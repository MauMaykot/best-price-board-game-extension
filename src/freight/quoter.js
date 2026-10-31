// Escolhe o adaptador pela página do produto e cota o carrinho numa sessão nova, porque
// o carrinho vive nos cookies. Nenhum pedido é criado: o carrinho é apenas abandonado.

import * as bravo from './bravo.js';
import * as brecho from './brecho.js';
import * as lojaIntegrada from './lojaIntegrada.js';
import * as meca from './meca.js';
import * as nuvemshop from './nuvemshop.js';
import * as paladins from './paladins.js';
import * as pira from './pira.js';
import * as tray from './tray.js';

const ADAPTERS = [tray, nuvemshop, lojaIntegrada, bravo, brecho, meca, paladins, pira];

// A Amazon recusa automação no robots.txt, inclusive o carrinho, e o Mercado Livre responde
// com CAPTCHA. Nesses sites a extensão não faz requisições: o frete vem do usuário.
const MANUAL_ONLY = /(^|\.)(amazon|mercadolivre)\.com\.br$/;

export function isManualOnly(url) {
  return MANUAL_ONLY.test(new URL(url).hostname);
}

async function resolveProducts(offers, session) {
  const pages = [];
  for (const offer of offers) pages.push((await session.get(offer.url)).text);

  const adapter = ADAPTERS.find(({ parseProduct }) => parseProduct(pages[0]));
  if (!adapter) return null;

  const products = pages.map(adapter.parseProduct);
  if (products.some((product) => !product)) return null;
  return { adapter, products, origin: new URL(offers[0].url).origin };
}

export function createQuoter({ zipCode, createSession }) {
  return async (store, offers) => {
    if (isManualOnly(offers[0].url)) return null;

    const session = createSession();
    const resolved = await resolveProducts(offers, session);
    return resolved && resolved.adapter.quoteCart(resolved.origin, resolved.products, zipCode, session);
  };
}

// Monta o carrinho na sessão do próprio usuário, para ele continuar a compra na loja.
// Devolve null quando a loja não permite: aí o usuário segue pela página do produto.
export async function fillCart(offers, couponCode, session) {
  if (isManualOnly(offers[0].url)) return null;

  const resolved = await resolveProducts(offers, session);
  if (!resolved?.adapter.addToCart) return null;

  const { adapter, products, origin } = resolved;
  const cartUrl = await adapter.addToCart(origin, products, session);
  if (!cartUrl) return null;

  const couponApplied = Boolean(couponCode && adapter.applyCoupon)
    && await adapter.applyCoupon(origin, couponCode, session).catch(() => false);
  return { cartUrl, couponApplied };
}
