// Cotação de frete em lojas CommercePlus (Paladins Games), por HTTP e sem abrir aba.
//
// O simulador da página do produto só cota um item. O do carrinho cota tudo junto, com frete
// unificado e frete grátis por valor, e as duas ações usam a mesma rota:
//   1. A página do produto traz o produto em JSON e o id do item vendável (subproduto).
//   2. POST cpcontroller, metodo=add_item_carrinho, inclui cada item na sessão.
//   3. GET /carrinho confirma que cada item entrou.
//   4. POST cpcontroller, metodo=get_opcoes_frete, devolve as opções do carrinho inteiro.
//   5. POST cpcontroller, metodo=del_item_carrinho, tira do carrinho o que foi incluído.

import { cheapest, isDelivery } from './delivery.js';

const CONTROLLER = '/mediaplus/controller/cpcontroller';
const PRODUCT_JSON = /url: '\/mediaplus\/controller\/cpcontroller',\s*data: 'metodo=add_item_carrinho&param1=(\{.*?\})&param2=/;
const DEFAULT_SUBPRODUCT = /defineSubproduto\((\d+)\)/;
const COUPON_PATH = /\/carrinho\/cupomdesconto\/[0-9a-f]+/;

// Termos fora da regra comum. "Retira na loja" escapa de "retirar", e "Orçar Frete" é o
// orçamento de transportadora, que a própria loja mostra como preço a definir. O acento
// chega ilegível porque a página é ISO-8859-1, daí o ponto em "or.ar" e "gr.tis".
const NOT_A_DELIVERY = /\bretir[ae]\b|\bor.ar\b|\bor.amento\b|a definir/i;
const NOT_A_DELIVERY_CODE = /^(?:retirar_na_loja|orcamento)$/;
const FREE = /gr.tis/i;
const PRICE = /R\$\s*([\d.]*\d,\d{2})/;
const DAYS = /(\d+)(?:\s*a\s*(\d+))?\s*dias?\b/i;

export function parseProduct(html) {
  const subproductId = html.match(DEFAULT_SUBPRODUCT)?.[1];
  const productJson = html.match(PRODUCT_JSON)?.[1];
  if (!subproductId || !productJson) return null;

  try {
    const { idproduto: productId } = JSON.parse(productJson);
    return productId ? { productId, subproductId, productJson } : null;
  } catch {
    return null;
  }
}

function parseCost(price) {
  if (FREE.test(price)) return 0;
  const match = price.match(PRICE);
  return match ? Number(match[1].replace(/\./g, '').replace(',', '.')) : NaN;
}

function parseDays(term) {
  const match = term.match(DAYS);
  if (!match) return {};
  return { minDays: Number(match[1]), maxDays: Number(match[2] ?? match[1]) };
}

// Cada opção vem como mp*-*-*código*-*-*preço****prazo****descrição, e a loja às vezes põe
// um 0 antes da descrição. Resposta de erro não tem preço e cai fora no filtro de custo.
function parseOption(option) {
  const [, code = '', details = ''] = option.split('*-*-*');
  const [price = '', term = '', label = '', fallbackLabel = ''] = details.split('****');
  return {
    code,
    price,
    failed: term.startsWith('erro'),
    delivery: { cost: parseCost(price), service: Number(label) === 0 ? fallbackLabel : label, ...parseDays(term) },
  };
}

export function cheapestDelivery(text) {
  const [options] = text.split('__________');
  return cheapest(options.split('--mp--')
    .map(parseOption)
    .filter(({ code, price, failed, delivery }) => !failed
      && !NOT_A_DELIVERY_CODE.test(code)
      && !NOT_A_DELIVERY.test(`${delivery.service} ${price}`)
      && isDelivery(`${delivery.service} ${price}`)
      && Number.isFinite(delivery.cost))
    .map(({ delivery }) => delivery));
}

// A loja manda http para https com 302, e o redirecionamento perderia o corpo dos POSTs.
async function resolveBase(origin, session) {
  const { url } = await session.get(`${origin}/carrinho`);
  return new URL(url).origin;
}

async function addItems(base, products, session, added) {
  for (const product of products) {
    const { text } = await session.post(
      `${base}${CONTROLLER}`,
      `metodo=add_item_carrinho&param1=${encodeURIComponent(product.productJson)}&param2=${product.subproductId}&param3=1&param4=&param5=&param6=0&param7=&param8=&param11=&param12=`,
    );
    if (text.split('*')[1] !== '1') return false;
    added.push(product);
  }

  // Um item fora do carrinho daria frete menor que o real.
  const { text: cart } = await session.get(`${base}/carrinho`);
  return products.every(({ productId, subproductId }) => cart.includes(`id="qtd_${productId}_${subproductId}"`));
}

export async function addToCart(origin, products, session) {
  const base = await resolveBase(origin, session);
  return (await addItems(base, products, session, [])) ? `${base}/carrinho` : null;
}

export async function applyCoupon(origin, code, session) {
  const base = await resolveBase(origin, session);
  const { text } = await session.post(`${base}${CONTROLLER}`, `metodo=valida_cupomdesconto&param1=${encodeURIComponent(code)}`);
  if (text.split('*')[1] !== '1') return false;

  // Depois de validar, a página aplica o cupom abrindo este endereço.
  const { text: cart } = await session.get(`${base}/carrinho`);
  const applyPath = cart.match(COUPON_PATH)?.[0];
  if (!applyPath) return false;
  await session.get(`${base}${applyPath}`);
  return true;
}

export async function quoteCart(origin, products, zipCode, session) {
  const base = await resolveBase(origin, session);
  const controller = `${base}${CONTROLLER}`;
  const added = [];

  try {
    if (!(await addItems(base, products, session, added))) return null;

    const { text } = await session.post(controller, `metodo=get_opcoes_frete&param1=1&param2=${zipCode.replace(/\D/g, '')}`);
    return cheapestDelivery(text);
  } finally {
    // Incluir pode reservar estoque em algumas lojas, então nada fica no carrinho, e uma
    // falha aqui não pode custar a cotação já obtida.
    for (const { subproductId } of added) {
      await session.post(controller, `metodo=del_item_carrinho&param1=${subproductId}`).catch(() => {});
    }
  }
}
