// Cotação de frete na Meca dos Jogos (plataforma iSET), por HTTP e sem abrir aba.
//
// Não usa o carrinho: incluir item pode reservar estoque real, e a extensão cota muitas
// vezes. A rota do calculador da página aceita vários produtos, e o frete unificado e o
// frete grátis por valor saem iguais aos do carrinho:
//   1. A página do produto informa o id em productInfo.Init e a disponibilidade no schema.org.
//   2. POST /shipping/quote devolve as opções de envio dos produtos juntos, em JSON.

import { cheapest, isDelivery } from './delivery.js';

const BUY_FORM = 'data-element="form-product-buy"';
const PRODUCT_ID = /productInfo\.Init\(\{"id":"(\d+)"/;
const IN_STOCK = 'schema.org/InStock';
const PRE_ORDER = 'schema.org/PreOrder';

// Cobra R$ 1,00 e não é frete: só junta itens a um pedido já aberto, seja qual for o título.
const COMBINE_ORDERS = 'cmodulecombinacao';

const plainText = (title) => title.replace(/<[^>]*>/g, '').replace(/^[\s>-]+/, '').replace(/\s+/g, ' ').trim();

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function parseProduct(html) {
  if (!html.includes(BUY_FORM)) return null;
  const match = html.match(PRODUCT_ID);
  return match ? { productId: match[1], inStock: html.includes(IN_STOCK), preOrder: html.includes(PRE_ORDER) } : null;
}

export function cheapestDelivery(response) {
  return cheapest(Object.values(response.options ?? {})
    .filter((option) => !option.error && option.id !== COMBINE_ORDERS && Number.isFinite(option.cost))
    .filter((option) => isDelivery(`${option.title} ${option.cost_label}`))
    .map((option) => ({
      cost: option.cost,
      service: plainText(option.title),
      // A entrega da própria loja vem com prazo 0 e depende do horário do pedido.
      ...(option.deliveryTime > 0 ? { maxDays: option.deliveryTime } : {}),
    })));
}

// Só aqui o carrinho é usado, porque o usuário pediu para comprar.
export async function addToCart(origin, products, session) {
  for (const { productId } of products) {
    const { text } = await session.post(`${origin}/cart/add`, `quantity=1&id_produto=${productId}`);
    if (String(parseJson(text)?.product_cart_id) !== productId) return null;
  }
  return `${origin}/cart`;
}

export async function quoteCart(origin, products, zipCode, session) {
  // A rota cota item esgotado sem reclamar, e esse carrinho não existiria de verdade.
  if (!products.every(({ inStock, preOrder }) => inStock || preOrder)) return { unavailable: 'fora de estoque' };

  const items = products
    .map(({ productId }, index) => `products[${index}][id]=${productId}&products[${index}][qty]=1&products[${index}][variation]=`)
    .join('&');
  const { text } = await session.post(`${origin}/shipping/quote`, `cep=${zipCode.replace(/\D/g, '')}&${items}`);
  const shipping = parseJson(text);
  const delivery = shipping?.status ? cheapestDelivery(shipping) : null;
  return delivery && { ...delivery, preOrder: products.some(({ preOrder }) => preOrder) };
}
