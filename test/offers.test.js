import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCatalog, fetchGameSummary, isItemUrl, itemUrl, searchGames, slugFromUrl } from '../src/catalog/offers.js';

const price = (id, overrides = {}) => ({
  type: 'LINK',
  name: `Oferta ${id}`,
  condition: 'NEW',
  damaged: false,
  is_extra: false,
  price_to: 100,
  url: `https://loja.com/${id}`,
  available: true,
  store: { name: 'loja', full_name: 'Loja' },
  ...overrides,
});

const apiResponse = (prices) => ({
  ok: true,
  json: async () => ({ data: { product: [{ slug: 'ruins', name: 'Ruins', prices }] } }),
});

test('pagina a API até acabar as ofertas', async () => {
  const offsets = [];
  const fetchImpl = async (url, options) => {
    const { offset } = JSON.parse(options.body).variables;
    offsets.push(offset);
    return apiResponse(Array.from({ length: offset === 0 ? 50 : 3 }, (_, index) => price(offset + index)));
  };
  const { offers } = await fetchCatalog('ruins', fetchImpl);
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(offers.length, 53);
});

test('exclui ofertas fora do escopo e registra o motivo', async () => {
  const { offers, excluded } = await fetchCatalog('ruins', async () => apiResponse([
    price(1),
    price(2, { type: 'MARKET', url: null, store: null }),
    price(3, { damaged: true }),
  ]));
  assert.equal(offers.length, 1);
  assert.deepEqual(excluded.map((item) => item.reason), ['sem loja vinculada', 'avariado']);
});

test('possível pré-venda continua na lista, com aviso', async () => {
  const { offers, excluded } = await fetchCatalog('ruins', async () => apiResponse([
    price(1),
    price(2, { url: 'https://loja.com/jogo-pre-venda' }),
    price(3, { name: 'Jogo (Pré-venda)' }),
  ]));
  assert.deepEqual(offers.map((offer) => offer.maybePreOrder), [false, true, true]);
  assert.deepEqual(excluded, []);
});

test('propaga erro de GraphQL, HTTP e jogo inexistente', async () => {
  await assert.rejects(
    fetchCatalog('ruins', async () => ({ ok: true, json: async () => ({ errors: [{ message: 'campo inválido' }] }) })),
    /campo inválido/,
  );
  await assert.rejects(fetchCatalog('ruins', async () => ({ ok: false, status: 429 })), /429/);
  await assert.rejects(
    fetchCatalog('nada', async () => ({ ok: true, json: async () => ({ data: { product: [] } }) })),
    /não encontrado/,
  );
});

test('busca por nome aceita palavras fora de ordem exata e informa as ofertas', async () => {
  let variables;
  const fetchImpl = async (url, options) => {
    ({ variables } = JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        data: {
          product: [
            { slug: 'ruins', name: 'Ruins', type: 'game', thumbnail_url: 'https://img/r.jpg', product_price: { new_count: 13 } },
            { slug: 'x', name: 'X', type: 'expansion', product_price: null },
          ],
        },
      }),
    };
  };
  const games = await searchGames('  twilight   imperium ', fetchImpl);
  assert.equal(variables.term, '%twilight%imperium%');
  assert.deepEqual(games, [
    { slug: 'ruins', name: 'Ruins', image: 'https://img/r.jpg', isExpansion: false, newOffers: 13 },
    { slug: 'x', name: 'X', image: null, isExpansion: true, newOffers: 0 },
  ]);
});

test('a consulta ao Compara Jogos tem tempo limite', async () => {
  let signal;
  await fetchGameSummary('ruins', async (url, options) => {
    ({ signal } = options);
    return { ok: true, json: async () => ({ data: { product: [] } }) };
  });
  assert.ok(signal instanceof AbortSignal);
});

test('resumo do jogo traz nome oficial e foto', async () => {
  const reply = (product) => async () => ({ ok: true, json: async () => ({ data: { product } }) });
  assert.deepEqual(
    await fetchGameSummary('ruins', reply([{ name: 'Ruins', thumbnail_url: 'https://img/r.jpg' }])),
    { name: 'Ruins', image: 'https://img/r.jpg' },
  );
  assert.equal(await fetchGameSummary('nada', reply([])), null);
});

test('monta o link do jogo no Compara Jogos', () => {
  assert.equal(itemUrl('ruins'), 'https://www.comparajogos.com.br/item/ruins');
  assert.equal(slugFromUrl(itemUrl('compile-main-1')), 'compile-main-1');
});

test('reconhece a URL de um item', () => {
  assert.equal(isItemUrl('https://www.comparajogos.com.br/item/ruins'), true);
  assert.equal(isItemUrl('https://comparajogos.com.br/item/ruins?x=1'), true);
  assert.equal(isItemUrl('https://www.comparajogos.com.br/all?q=ruins'), false);
  assert.equal(isItemUrl('ruins'), false);
});

test('aceita URL ou slug', () => {
  for (const value of ['https://www.comparajogos.com.br/item/ruins', 'https://www.comparajogos.com.br/item/ruins/', 'ruins']) {
    assert.equal(slugFromUrl(value), 'ruins');
  }
});
