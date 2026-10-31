// Cotação de frete na Pira no Board Game, por HTTP e sem abrir aba.
//
// A loja é um app React com API tRPC própria, sem plataforma de e-commerce conhecida. O
// carrinho só existe para cliente logado: cart.* e shipping.calculateForCart respondem 401.
// O simulador público da página do produto, porém, aceita uma lista de itens e cota todos
// como um pacote só, inclusive o frete grátis por valor:
//   1. O HTML é só a casca do app, e o slug do produto vem do link canonical.
//   2. products.getBySlug devolve id, peso, medidas, preço e estoque de cada produto.
//   3. shipping.calculate devolve as opções de envio dos itens juntos.

import { cheapest, isDelivery } from './delivery.js';

const CANONICAL_LINK = /<link\s+rel="canonical"\s+href="https:\/\/(?:www\.)?piranoboardgame\.com\.br\/jogo\/([^"/?#]+)\/?"/;
const JSON_HEADERS = { 'content-type': 'application/json' };

// A página do produto só mostra estes serviços da mesma rota. O restante da lista, como
// entrega em mãos e retirada em evento, vem com valor zero, mas não é frete.
const SHIPPING_SERVICES = ['PAC', 'SEDEX', 'Jadlog', 'Frete grátis'];

const positive = (value) => (Number(value) > 0 ? Number(value) : null);

function result({ status, text }) {
  return status === 200 ? JSON.parse(text).result?.data?.json ?? null : null;
}

export function parseProduct(html) {
  const match = html.match(CANONICAL_LINK);
  return match ? { slug: match[1] } : null;
}

function isSellable(product) {
  return product?.active === true && product.status === 'published' && product.stock > 0;
}

// A página cota com as medidas de envio e, se faltarem, com as da caixa.
function toQuoteItem(product) {
  const item = {
    productId: product.id,
    quantity: 1,
    weight: positive(product.weight),
    width: positive(product.width) ?? positive(product.boxWidth),
    height: positive(product.height) ?? positive(product.boxHeight),
    length: positive(product.length) ?? positive(product.boxLength),
    price: positive(product.price),
  };
  return Object.values(item).every(Boolean) ? item : null;
}

export function cheapestDelivery(response) {
  return cheapest((response?.options ?? [])
    .filter(({ service, error }) => !error && SHIPPING_SERVICES.includes(service) && isDelivery(service))
    .map(({ service, price, deliveryDays }) => ({ cost: Number(price), service, maxDays: deliveryDays }))
    .filter(({ cost }) => cost >= 0));
}

export async function quoteCart(origin, products, zipCode, session) {
  // Sem carrinho no servidor, nada recusa um item esgotado: ele entraria na cotação e o
  // frete sairia de um pedido que não pode ser feito. Por isso o estoque é conferido aqui.
  const items = [];
  let preOrder = false;
  for (const { slug } of products) {
    const input = encodeURIComponent(JSON.stringify({ json: { slug } }));
    const product = result(await session.get(`${origin}/api/trpc/products.getBySlug?input=${input}`));

    // O "sob encomenda" tem botão de compra, mas é vendido sem estoque.
    if (product?.availabilityType === 'on_demand') return { unavailable: 'encomenda' };
    preOrder ||= product?.availabilityType === 'pre_order';

    const item = isSellable(product) ? toQuoteItem(product) : null;
    if (!item) return null;
    items.push(item);
  }

  const cep = zipCode.replace(/\D/g, '');
  const delivery = cheapestDelivery(result(
    await session.post(`${origin}/api/trpc/shipping.calculate`, JSON.stringify({ json: { cep, items } }), JSON_HEADERS),
  ));
  return delivery && { ...delivery, preOrder };
}
