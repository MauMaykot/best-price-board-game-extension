// Cotação de frete no Brechó Lúdico (WooCommerce), por HTTP e sem abrir aba.
//
// O simulador da página do produto só cota um item por vez, e a Store API só aceita mudar
// o carrinho com um nonce que vem em cabeçalho, que a sessão não expõe. Por isso o carrinho
// é montado pelas rotas clássicas e lido pela Store API, que não exige nonce para consultar:
//   1. A página do produto informa o id do produto no botão de compra.
//   2. POST /?wc-ajax=add_to_cart inclui cada produto no carrinho da sessão.
//   3. GET /carrinho/ traz o nonce da calculadora de frete.
//   4. POST /carrinho/ grava o CEP na sessão e devolve os prazos no HTML.
//   5. GET /wp-json/wc/store/v1/cart devolve os itens e as opções do carrinho inteiro.

import { cheapest, isDelivery } from './delivery.js';

// A rota é genérica de WooCommerce, mas só esta loja teve as opções de frete conferidas.
const CART_FORM = /<form\b[^>]*\bclass="cart"[^>]*\baction="https:\/\/brecholudico\.com\.br\/[\s\S]*?<\/form>/;
const ADD_TO_CART_BUTTON = /name="add-to-cart"\s+value="(\d+)"/;
const CALCULATOR_NONCE = /name="woocommerce-shipping-calculator-nonce"\s+value="([^"]+)"/;
const APPLY_COUPON_NONCE = /"apply_coupon_nonce":"([^"]+)"/;
const MAX_DAYS = /até (\d+) dias? út/;
const BACKORDER = /schema\.org\/BackOrder/;

const PICKUP_METHODS = new Set(['local_pickup', 'pickup_location']);

const digits = (text) => String(text ?? '').replace(/\D/g, '');

const parseCart = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isRealDelivery = (rate) => !PICKUP_METHODS.has(rate.method_id) && isDelivery(`${rate.name} ${rate.description}`);

// A Store API não informa prazo: ele só aparece ao lado da opção no HTML do carrinho.
const maxDaysOf = (rate, cartHtml) => {
  const option = cartHtml.split('</li>').find((chunk) => chunk.includes(`value="${rate.rate_id}"`));
  const match = option?.match(MAX_DAYS);
  return match ? { maxDays: Number(match[1]) } : {};
};

export function parseProduct(html) {
  const match = html.match(CART_FORM)?.[0].match(ADD_TO_CART_BUTTON);
  return match ? { productId: match[1], onBackorder: BACKORDER.test(html) } : null;
}

export function cheapestDelivery(rates, cartHtml = '') {
  return cheapest(rates
    .filter(isRealDelivery)
    .map((rate) => ({
      cost: Number(rate.price) / 10 ** rate.currency_minor_unit,
      service: rate.name,
      ...maxDaysOf(rate, cartHtml),
    }))
    .filter((delivery) => Number.isFinite(delivery.cost)));
}

async function readCart(origin, session) {
  const { text } = await session.get(`${origin}/wp-json/wc/store/v1/cart`);
  return parseCart(text);
}

const hasAllItems = (cart, products) => {
  const inCart = new Set(cart?.items?.map(({ id }) => String(id)));
  return products.every(({ productId }) => inCart.has(productId));
};

async function addItems(origin, products, session) {
  for (const { productId } of products) {
    await session.post(`${origin}/?wc-ajax=add_to_cart`, `product_id=${productId}&quantity=1`);
  }
}

export async function addToCart(origin, products, session) {
  await addItems(origin, products, session);
  return hasAllItems(await readCart(origin, session), products) ? `${origin}/carrinho/` : null;
}

export async function applyCoupon(origin, code, session) {
  const { text: cartPage } = await session.get(`${origin}/carrinho/`);
  const nonce = cartPage.match(APPLY_COUPON_NONCE)?.[1];
  if (!nonce) return false;

  await session.post(`${origin}/?wc-ajax=apply_coupon`, new URLSearchParams({ security: nonce, coupon_code: code }).toString());
  const cart = await readCart(origin, session);
  return Boolean(cart?.coupons?.some((coupon) => coupon.code.toLowerCase() === code.toLowerCase()));
}

export async function quoteCart(origin, products, zipCode, session) {
  // "Disponível por encomenda" pode ser comprado, mas o jogo não está em estoque.
  if (products.some(({ onBackorder }) => onBackorder)) return { unavailable: 'encomenda' };

  await addItems(origin, products, session);

  const { text: cartPage } = await session.get(`${origin}/carrinho/`);
  const nonce = cartPage.match(CALCULATOR_NONCE)?.[1];
  if (!nonce) return null;

  const { text: cartHtml } = await session.post(`${origin}/carrinho/`, new URLSearchParams({
    calc_shipping_postcode: zipCode,
    calc_shipping: '1',
    'woocommerce-shipping-calculator-nonce': nonce,
  }).toString());

  // Um item esgotado fica fora do carrinho em silêncio, e o frete sairia menor que o real.
  const cart = await readCart(origin, session);
  if (!cart || !hasAllItems(cart, products)) return null;

  // Sem o CEP gravado, as opções não seriam deste destino. Mais de um pacote soma fretes
  // que esta conta não cobre.
  if (digits(cart.shipping_address?.postcode) !== digits(zipCode)) return null;
  if (cart.shipping_rates?.length !== 1) return null;

  return cheapestDelivery(cart.shipping_rates[0].shipping_rates, cartHtml);
}
