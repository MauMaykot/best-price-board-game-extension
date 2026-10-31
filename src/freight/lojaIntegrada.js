// Cotação de frete em lojas Loja Integrada, por HTTP e sem abrir aba.
//
// O simulador da página do produto (/carrinho/frete) só cota um item por vez. Para obter o
// frete real de jogos diferentes juntos, monta um carrinho anônimo e usa a rota do carrinho:
//   1. A página do produto informa o id do produto em PRODUTO_ID.
//   2. GET /carrinho/produto/{id}/adicionar inclui cada produto no carrinho da sessão.
//   3. GET /carrinho/index mostra o que realmente entrou.
//   4. GET /carrinho/endereco/adicionar devolve as opções de envio do carrinho inteiro.

import { cheapest, isDelivery } from './delivery.js';

// PRODUTO_ID é um nome genérico, então só vale junto com a marca da plataforma. Os links de
// compra não servem: os produtos relacionados da mesma página usam o mesmo formato.
const PLATFORM = /<meta\s+name="generator"\s+content="Loja Integrada"/;
const PRODUCT_ID = /var PRODUTO_ID = '(\d+)'/;
const CART_ROW = /<tr\b[^>]*\bdata-produto-id="(\d+)"/g;
const COUPON_IN_CART = /data-cupom-desconto-codigo="[^"]+"/;

export function parseProduct(html) {
  const match = PLATFORM.test(html) && html.match(PRODUCT_ID);
  return match ? { productId: match[1] } : null;
}

// msgErro nem sempre é erro: SEDEX e PAC vêm com aviso de atraso e preço válido, e o site
// mostra a opção normalmente. Só sem preço a mensagem indica falha da transportadora, e aí
// o zero não é frete grátis.
const hasPrice = ({ msgErro, price }) => !msgErro || Number(price) > 0;

export function cheapestDelivery(response) {
  return cheapest((response.deliveries ?? [])
    // A retirada vem em toda cotação, até em CEP inexistente, e o nome nem sempre diz que é
    // retirada ou "a combinar", por isso código, tipo e observação entram na verificação.
    .filter(({ name, code, type, additionalInfo }) => name && isDelivery([name, code, type, additionalInfo].join(' ')))
    .filter(hasPrice)
    // A loja informa um único prazo, em dias úteis, sem faixa de mínimo e máximo. Preço
    // nulo não pode virar zero: pareceria frete grátis.
    .map(({ name, price, deliveryTime }) => ({
      cost: Number(price ?? NaN),
      service: name,
      ...(Number(deliveryTime) > 0 ? { maxDays: Number(deliveryTime) } : {}),
    }))
    .filter((delivery) => Number.isFinite(delivery.cost)));
}

// Bloqueio ou erro da loja chega como página HTML, e isso é ausência de cotação.
function parseQuote(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function addItems(origin, products, session) {
  for (const { productId } of products) {
    await session.get(`${origin}/carrinho/produto/${productId}/adicionar`);
  }

  // Um item esgotado volta para o carrinho com status 200 e apenas um aviso na tela, e o
  // frete sairia menor que o real. O id precisa estar numa linha do carrinho: ele também
  // pode aparecer na página em outras listas de produtos.
  const { text: cart } = await session.get(`${origin}/carrinho/index`);
  const inCart = new Set([...cart.matchAll(CART_ROW)].map(([, productId]) => productId));
  return products.every(({ productId }) => inCart.has(productId));
}

export async function addToCart(origin, products, session) {
  return (await addItems(origin, products, session)) ? `${origin}/carrinho/index` : null;
}

export async function applyCoupon(origin, code, session) {
  const { text } = await session.post(`${origin}/carrinho/cupom/validar`, `cupom=${encodeURIComponent(code)}`);
  return COUPON_IN_CART.test(text);
}

export async function quoteCart(origin, products, zipCode, session) {
  if (!(await addItems(origin, products, session))) return null;

  const { text } = await session.get(`${origin}/carrinho/endereco/adicionar?cep=${zipCode.replace(/\D/g, '')}`);
  return cheapestDelivery(parseQuote(text));
}
