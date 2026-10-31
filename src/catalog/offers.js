// Busca as ofertas do Compara Jogos.
//
// Usa a API GraphQL do site, a mesma do botão "Mostrar mais". A página do item não serve
// como fonte: ela traz só 6 ofertas novas, com as lojas em destaque primeiro.

import { localizedError } from '../i18n/i18n.js';

const GRAPHQL_URL = 'https://api.comparajogos.com.br/v1/graphql';
const PAGE_SIZE = 50;
const TIMEOUT_MS = 15000;
const PRE_ORDER = /pr[eé][\s-]?venda/i;

const PRODUCT_PRICES_QUERY = `
  query productPrices($slug: String!, $limit: Int!, $offset: Int!) {
    product(where: {slug: {_eq: $slug}}) {
      slug
      name
      thumbnail_url
      prices(
        where: {available: {_eq: true}, type: {_neq: LOT}, condition: {_eq: NEW}, is_extra: {_eq: false}}
        order_by: [{price_to: asc}, {price_from: asc}, {id: asc}]
        limit: $limit
        offset: $offset
      ) {
        type
        name
        condition
        damaged
        is_extra
        price_from
        price_to
        url
        available
        store {
          name
          full_name
          logo
        }
      }
    }
  }
`;

const SEARCH_QUERY = `
  query searchGames($term: String!, $limit: Int!) {
    product(
      where: {name: {_ilike: $term}}
      order_by: [{product_price: {new_count: desc_nulls_last}}, {bgg_ranking: asc_nulls_last}]
      limit: $limit
    ) {
      slug
      name
      type
      thumbnail_url
      product_price {
        new_count
      }
    }
  }
`;

const GAME_SUMMARY_QUERY = `
  query gameSummary($slug: String!) {
    product(where: {slug: {_eq: $slug}}) {
      name
      thumbnail_url
    }
  }
`;

// Aceita a URL do item ou o próprio slug.
export function slugFromUrl(value) {
  const path = value.includes('://') ? new URL(value).pathname : value;
  return path.replace(/\/+$/, '').split('/').at(-1);
}

export function itemUrl(slug) {
  return `https://www.comparajogos.com.br/item/${slug}`;
}

export function isItemUrl(value) {
  return /^https?:\/\/(www\.)?comparajogos\.com\.br\/item\/[^/?#]+/.test(value.trim());
}

export async function searchGames(text, fetchImpl = fetch, limit = 8) {
  const term = `%${text.trim().split(/\s+/).join('%')}%`;
  const { product } = await graphql(fetchImpl, 'searchGames', SEARCH_QUERY, { term, limit });
  return product.map((game) => ({
    slug: game.slug,
    name: game.name,
    image: game.thumbnail_url ?? null,
    isExpansion: game.type === 'expansion',
    newOffers: game.product_price?.new_count ?? 0,
  }));
}

export async function fetchGameSummary(slug, fetchImpl = fetch) {
  const { product } = await graphql(fetchImpl, 'gameSummary', GAME_SUMMARY_QUERY, { slug });
  return product[0] ? { name: product[0].name, image: product[0].thumbnail_url ?? null } : null;
}

export async function fetchCatalog(slug, fetchImpl = fetch) {
  const prices = [];
  let product;
  while (true) {
    product = await requestPrices(fetchImpl, slug, prices.length);
    prices.push(...product.prices);
    if (product.prices.length < PAGE_SIZE) break;
  }

  const offers = [];
  const excluded = [];
  for (const price of prices) {
    const reason = exclusionReason(price);
    if (reason) {
      excluded.push({ reason, store: price.store?.full_name ?? null, price: price.price_to });
    } else {
      offers.push({
        gameId: product.slug,
        storeId: price.store.name,
        storeName: price.store.full_name,
        storeLogo: price.store.logo ?? null,
        price: price.price_to,
        listPrice: Math.max(price.price_from ?? 0, price.price_to),
        url: price.url,
        // O Compara Jogos não informa pré-venda: o nome e o link só dão um indício.
        maybePreOrder: PRE_ORDER.test(`${price.name} ${price.url}`),
      });
    }
  }
  return { slug: product.slug, name: product.name, image: product.thumbnail_url ?? null, offers, excluded };
}

async function requestPrices(fetchImpl, slug, offset) {
  const { product } = await graphql(fetchImpl, 'productPrices', PRODUCT_PRICES_QUERY, { slug, limit: PAGE_SIZE, offset });
  if (!product[0]) throw localizedError('gameNotFound', slug);
  return product[0];
}

export async function graphql(fetchImpl, operationName, query, variables) {
  const response = await fetchImpl(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName, query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw localizedError('catalogStatus', response.status);

  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`Compara Jogos: ${errors[0].message}`);
  return data;
}

function exclusionReason(price) {
  if (price.type !== 'LINK' || !price.url || !price.store) return 'sem loja vinculada';
  if (price.condition !== 'NEW') return 'usado';
  if (!price.available) return 'indisponível';
  if (price.damaged) return 'avariado';
  if (price.is_extra) return 'item extra';
  return null;
}
