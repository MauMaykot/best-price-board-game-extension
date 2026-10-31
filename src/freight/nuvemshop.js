// Cotação de frete em lojas Nuvemshop, por HTTP e sem abrir aba.
//
//   1. A página do produto informa o id da variante no formulário de compra.
//   2. POST /comprar/ inclui cada variante no carrinho da sessão.
//   3. POST /frete/ devolve as opções de envio do carrinho inteiro, em HTML dentro de JSON.

import { cheapest, isDelivery } from './delivery.js';

const VARIANT_FIELD = /id="product_form"[\s\S]*?name="add_to_cart"\s+value="(\d+)"/;
const SHIPPING_INPUT = /<input\b[^>]*\bjs-shipping-method\b[^>]*>/g;

const attribute = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';

export function parseProduct(html) {
  const match = html.match(VARIANT_FIELD);
  return match ? { variantId: match[1] } : null;
}

export function cheapestDelivery(html) {
  return cheapest((html.match(SHIPPING_INPUT) ?? [])
    .filter((tag) => !tag.includes('js-branch-method'))
    .filter((tag) => isDelivery(`${attribute(tag, 'data-name')} ${attribute(tag, 'data-cost')}`))
    .map((tag) => ({ cost: Number(attribute(tag, 'data-price')), service: attribute(tag, 'data-name') }))
    .filter((delivery) => Number.isFinite(delivery.cost)));
}

// Um item esgotado fica fora do carrinho em silêncio, e o frete sairia menor que o real.
async function addItems(origin, products, session) {
  for (const { variantId } of products) {
    await session.post(`${origin}/comprar/`, `add_to_cart=${variantId}&quantity=1`);
  }
  const { text: cart } = await session.get(`${origin}/comprar/`);
  return products.every(({ variantId }) => cart.includes(variantId));
}

// A Nuvemshop só aceita cupom no checkout, então o usuário aplica o código lá.
export async function addToCart(origin, products, session) {
  return (await addItems(origin, products, session)) ? `${origin}/comprar/` : null;
}

export async function quoteCart(origin, products, zipCode, session) {
  if (!(await addItems(origin, products, session))) return null;

  const { text } = await session.post(`${origin}/frete/`, `zipcode=${zipCode.replace(/\D/g, '')}`);
  const { success, html } = JSON.parse(text);
  return success ? cheapestDelivery(html) : null;
}
