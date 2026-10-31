// Procura na página da loja o desconto por forma de pagamento que o Compara Jogos não trouxe.
//
// Só vale um preço em reais escrito junto de "Pix" ou "à vista". Percentuais ficaram de fora
// porque costumam ser banners genéricos do site. A página também mostra produtos relacionados,
// então o preço precisa estar numa faixa plausível. Sem certeza, fica sem desconto: um preço
// errado seria pior do que mostrar um total um pouco maior.

import { isManualOnly } from '../freight/quoter.js';

const MAX_DISCOUNT = 0.2;
const TIMEOUT_MS = 8000;
const PRICE_THEN_PIX = /R\$\s*([\d.]*\d,\d{2})[^$]{0,40}?(?<!\p{L})(?:pix|à vista|a vista)(?!\p{L})/giu;

const toNumber = (text) => Number(text.replace(/\./g, '').replace(',', '.'));

function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

export function findDiscountedPrice(html, listPrice) {
  const prices = [...pageText(html).matchAll(PRICE_THEN_PIX)]
    .map(([, price]) => toNumber(price))
    .filter((price) => price < listPrice && price >= listPrice * (1 - MAX_DISCOUNT));
  return prices[0] ?? null;
}

export async function applyStoreDiscounts(offers, fetchImpl = fetch) {
  return Promise.all(offers.map(async (offer) => {
    if (offer.price < offer.listPrice || isManualOnly(offer.url)) return offer;
    try {
      const response = await fetchImpl(offer.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { ...offer, price: findDiscountedPrice(await response.text(), offer.listPrice) ?? offer.price };
    } catch {
      return offer;
    }
  }));
}
