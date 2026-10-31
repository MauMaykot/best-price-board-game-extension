import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStoreDiscounts, findDiscountedPrice } from '../src/catalog/paymentDiscount.js';

test('lê o preço em reais junto de Pix ou à vista', () => {
  assert.equal(findDiscountedPrice('<b>R$ 143,91</b> <span>no Pix</span>', 159.9), 143.91);
  assert.equal(findDiscountedPrice('R$ 134,85 à vista com desconto Pix', 145), 134.85);
  assert.equal(findDiscountedPrice('R$&nbsp;1.278,81 à vista', 1420.9), 1278.81);
});

test('ignora preço de produto relacionado fora da faixa plausível', () => {
  assert.equal(findDiscountedPrice('R$ 19,90 no Pix e R$ 143,91 no Pix', 159.9), 143.91);
  assert.equal(findDiscountedPrice('R$ 19,90 no Pix', 159.9), null);
});

test('não aceita preço igual ou maior que o preço cheio', () => {
  assert.equal(findDiscountedPrice('R$ 159,90 no Pix', 159.9), null);
  assert.equal(findDiscountedPrice('R$ 200,00 no Pix', 159.9), null);
});

test('banner de percentual não vira desconto', () => {
  assert.equal(findDiscountedPrice('Ganhe 10% de desconto no Pix em toda a loja', 188.8), null);
  assert.equal(findDiscountedPrice('Pix 0% de desconto pagando com Pix', 384.9), null);
});

test('ignora texto dentro de scripts', () => {
  assert.equal(findDiscountedPrice('<script>var x = "R$ 143,91 no Pix";</script>', 159.9), null);
});

const offer = (extra) => ({ gameId: 'a', storeId: 'x', price: 100, listPrice: 100, url: 'https://loja.com/a', ...extra });

test('busca na loja só quando o Compara não trouxe desconto', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { text: async () => 'R$ 90,00 no Pix' }; };
  const [fromStore, known] = await applyStoreDiscounts(
    [offer({}), offer({ price: 95, url: 'https://loja.com/b' })],
    fetchImpl,
  );
  assert.equal(fromStore.price, 90);
  assert.equal(fromStore.listPrice, 100);
  assert.equal(known.price, 95);
  assert.deepEqual(urls, ['https://loja.com/a']);
});

test('site só manual não recebe requisição', async () => {
  const [result] = await applyStoreDiscounts(
    [offer({ url: 'https://www.amazon.com.br/dp/X' })],
    async () => { throw new Error('não deveria acessar'); },
  );
  assert.equal(result.price, 100);
});

test('a leitura da loja tem tempo limite', async () => {
  let signal;
  await applyStoreDiscounts([offer({})], async (url, options) => {
    ({ signal } = options);
    return { text: async () => '' };
  });
  assert.ok(signal instanceof AbortSignal);
});

test('falha ao ler a página mantém o preço', async () => {
  const [result] = await applyStoreDiscounts([offer({})], async () => { throw new Error('timeout'); });
  assert.equal(result.price, 100);
});
