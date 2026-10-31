// Cotação de frete em lojas Tray, por HTTP e sem abrir aba.
//
// O simulador da página do produto só cota um item por vez. Para obter o frete real de
// jogos diferentes juntos, monta um carrinho anônimo e usa a mesma rota do checkout:
//   1. A página do produto informa o id da loja e do produto.
//   2. /loja/cartService.php inclui cada produto e devolve o session_id do carrinho.
//   3. /checkout/cart/api/shipping devolve as opções de envio do carrinho inteiro.

import { cheapest, formatZipCode, isDelivery } from './delivery.js';

const CART_LINK = /cartService\.php\?loja=(\d+)(?:&amp;|&)acao=incluir(?:&amp;|&)IdProd=(\d+)/;

export function parseProduct(html) {
  const match = html.match(CART_LINK);
  return match ? { storeCode: match[1], productId: match[2] } : null;
}

export function cheapestDelivery(response) {
  return cheapest((response.data?.quotations ?? [])
    .filter((quotation) => Number(quotation.pickup) === 0 && isDelivery(quotation.name))
    .map((quotation) => ({
      cost: Number(quotation.value),
      service: quotation.name,
      minDays: Number(quotation.minPeriod),
      maxDays: Number(quotation.maxPeriod),
    })));
}

async function addItems(origin, products, session) {
  let sessionId = null;
  for (const { storeCode, productId } of products) {
    const { url } = await session.get(`${origin}/loja/cartService.php?loja=${storeCode}&acao=incluir&IdProd=${productId}`);
    sessionId = new URL(url).searchParams.get('session_id');
  }
  return sessionId;
}

// O cupom da Tray exige a identidade gerada pelo antifraude do checkout, então o usuário
// aplica o código na própria loja.
export async function addToCart(origin, products, session) {
  const sessionId = await addItems(origin, products, session);
  return sessionId ? `${origin}/loja/redirect_cart_service.php?loja=${products[0].storeCode}` : null;
}

export async function quoteCart(origin, products, zipCode, session) {
  const [{ storeCode }] = products;

  const sessionId = await addItems(origin, products, session);
  if (!sessionId) return null;

  const { text } = await session.get(
    `${origin}/checkout/cart/api/shipping?store_id=${storeCode}&session_id=${sessionId}&zipcode=${formatZipCode(zipCode)}`,
  );
  return cheapestDelivery(JSON.parse(text));
}
