// Descobre o favicon de cada loja na página do produto, porque muitas não usam /favicon.ico.
// O endereço não muda com frequência, então quem chama guarda o resultado entre as buscas.

import { isManualOnly } from '../freight/quoter.js';

const LINK_TAG = /<link\b[^>]*>/gi;
const TIMEOUT_MS = 8000;

const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] ?? '';
const hasIconRel = (tag) => attribute(tag, 'rel').toLowerCase().split(/\s+/).includes('icon');

export function findFavicon(html, pageUrl) {
  const icon = (html.match(LINK_TAG) ?? []).find((tag) => hasIconRel(tag) && attribute(tag, 'href'));
  const href = icon ? attribute(icon, 'href').replaceAll('&amp;', '&') : '/favicon.ico';
  return new URL(href, pageUrl).href;
}

export async function loadStoreIcons(offers, known, fetchImpl = fetch) {
  const pending = new Map(offers
    .filter((offer) => !known[offer.storeId] && !isManualOnly(offer.url))
    .map((offer) => [offer.storeId, offer.url]));

  const found = await Promise.all([...pending].map(async ([storeId, url]) => {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return [storeId, findFavicon(await response.text(), response.url || url)];
    } catch {
      return null;
    }
  }));
  return { ...known, ...Object.fromEntries(found.filter(Boolean)) };
}
