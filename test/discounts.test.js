import assert from 'node:assert/strict';
import test from 'node:test';
import { discountPercent, formatPercent, summarizeDiscounts } from '../src/optimizer/discounts.js';
import { findCheapestCarts } from '../src/optimizer/optimizer.js';

const offer = (gameId, storeId, price, listPrice) => ({ gameId, storeId, storeName: storeId, price, listPrice, url: `https://${storeId}/${gameId}` });
const quoteFreight = async () => ({ cost: 30 });

const planFor = async (options) => (await findCheapestCarts({ quoteFreight, ...options })).plans[0];

test('calcula e formata o percentual', () => {
  assert.equal(discountPercent(200, 180), 10);
  assert.equal(discountPercent(304, 282.72), 7);
  assert.equal(discountPercent(1420.9, 1278.81), 10);
  assert.equal(formatPercent(7.7), '7,7%');
  assert.equal(formatPercent(10), '10%');
});

test('sem desconto dá zero, sem dividir por zero', () => {
  assert.equal(discountPercent(100, 100), 0);
  assert.equal(discountPercent(100, 120), 0);
  assert.equal(discountPercent(0, 0), 0);
});

test('o frete não entra no percentual à vista', async () => {
  const plan = await planFor({ games: ['a'], offers: [offer('a', 'x', 90, 100)] });
  assert.deepEqual(summarizeDiscounts(plan, 'cash'), { cash: 10, coupon: 0, combined: 10 });
});

test('junta os jogos de todas as lojas do plano', async () => {
  const plan = await planFor({ games: ['a', 'b'], offers: [offer('a', 'x', 90, 100), offer('b', 'y', 190, 200)] });
  assert.equal(summarizeDiscounts(plan, 'cash').cash, 6.7);
});

test('cupom percentual aparece igual e o total combinado não é a soma', async () => {
  const plan = await planFor({
    games: ['a'],
    offers: [offer('a', 'x', 90, 100)],
    coupons: { x: { type: 'percent', value: 10 } },
  });
  assert.deepEqual(summarizeDiscounts(plan, 'cash'), { cash: 10, coupon: 10, combined: 19 });
});

test('cupom de valor fixo vira o percentual equivalente', async () => {
  const plan = await planFor({
    games: ['a'],
    offers: [offer('a', 'x', 80, 100)],
    coupons: { x: { type: 'fixed', value: 20 } },
  });
  assert.deepEqual(summarizeDiscounts(plan, 'cash'), { cash: 20, coupon: 25, combined: 40 });
});

test('a prazo o cupom é medido sobre o preço a prazo', async () => {
  const plan = await planFor({
    games: ['a'],
    offers: [offer('a', 'x', 80, 100)],
    coupons: { x: { type: 'fixed', value: 20 } },
    paymentMode: 'installment',
  });
  assert.equal(summarizeDiscounts(plan, 'installment').coupon, 20);
});

test('oferta sem preço a prazo não gera desconto', async () => {
  const plan = await planFor({ games: ['a'], offers: [{ ...offer('a', 'x', 90), listPrice: undefined }] });
  assert.deepEqual(summarizeDiscounts(plan, 'cash'), { cash: 0, coupon: 0, combined: 0 });
});
