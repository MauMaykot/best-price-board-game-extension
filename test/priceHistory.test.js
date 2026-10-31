import assert from 'node:assert/strict';
import test from 'node:test';
import { describePrice, fetchPriceHistory } from '../src/catalog/priceHistory.js';

const today = new Date('2026-10-30T12:00:00Z');

const daysAgo = (days) => new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
const history = (...ranges) => ranges.flatMap(({ from, to, price }) => {
  const points = [];
  for (let days = from; days >= to; days -= 1) points.push({ date: daysAgo(days), price, store: 'Loja' });
  return points;
});

test('preço no menor valor do histórico', () => {
  const note = describePrice(100, history({ from: 400, to: 0, price: 120 }, { from: 300, to: 290, price: 100 }).sort((a, b) => a.date.localeCompare(b.date)), today);
  assert.equal(note.tone, 'great');
  assert.match(note.headline, /^Menor preço desde set\/2025/);
  assert.equal(note.detail, null);
});

test('preço abaixo de todo o histórico também é o menor', () => {
  assert.equal(describePrice(80, history({ from: 100, to: 0, price: 100 }), today).tone, 'great');
});

test('preço muito abaixo da média vira alerta, não comemoração', () => {
  const note = describePrice(60, history({ from: 100, to: 0, price: 100 }), today);
  assert.equal(note.tone, 'high');
  assert.equal(note.headline, '40% abaixo da média de 6 meses: confira o anúncio');
});

test('melhor preço desde o último dia mais barato', () => {
  const points = history({ from: 400, to: 201, price: 90 }, { from: 200, to: 0, price: 130 });
  const note = describePrice(110, points, today);
  assert.equal(note.tone, 'good');
  assert.equal(note.headline, `Melhor preço desde abr/2026`);
  assert.match(note.detail, /^Menor preço: R\$\s*90,00 em set\/2025$/);
});

test('perto do menor preço quando ficou mais barato há pouco tempo', () => {
  const points = history({ from: 100, to: 11, price: 120 }, { from: 10, to: 0, price: 100 });
  const note = describePrice(103, points, today);
  assert.equal(note.tone, 'good');
  assert.equal(note.headline, 'Perto do menor preço: 3% acima');
});

test('abaixo da média de 6 meses', () => {
  const points = history({ from: 100, to: 11, price: 130 }, { from: 10, to: 0, price: 100 });
  const note = describePrice(115, points, today);
  assert.equal(note.headline, '9% abaixo da média de 6 meses');
});

test('acima da média de 6 meses', () => {
  const points = history({ from: 100, to: 0, price: 100 });
  const note = describePrice(120, points, today);
  assert.equal(note.tone, 'high');
  assert.equal(note.headline, '20% acima da média de 6 meses');
});

test('dentro da média de 6 meses', () => {
  const points = history({ from: 100, to: 51, price: 110 }, { from: 50, to: 0, price: 100 });
  const note = describePrice(106, points, today);
  assert.equal(note.tone, 'neutral');
});

test('histórico curto não gera indicador', () => {
  assert.equal(describePrice(100, history({ from: 5, to: 0, price: 120 }), today), null);
  assert.equal(describePrice(100, [], today), null);
});

test('junta os períodos e usa só preços de jogos novos, em ordem de data', async () => {
  const periods = [];
  const fetchImpl = async (url, options) => {
    const { period } = JSON.parse(options.body).variables;
    periods.push(period);
    const shared = { date: '2026-02-01', condition: 'NEW', price: period === '1month' ? 100 : 105, price_where: 'A' };
    return {
      ok: true,
      json: async () => ({
        data: {
          product_history: period === '5years'
            ? [
              shared,
              { date: '2026-01-01', condition: 'NEW', price: 110, price_where: 'B' },
              { date: '2026-01-15', condition: 'USED', price: 50, price_where: 'C' },
              { date: '2026-01-20', condition: 'NEW', price: null, price_where: null },
            ]
            : [shared],
        },
      }),
    };
  };
  assert.deepEqual(await fetchPriceHistory('ruins', fetchImpl), [
    { date: '2026-01-01', price: 110, store: 'B' },
    { date: '2026-02-01', price: 100, store: 'A' },
  ]);
  assert.deepEqual(periods, ['1month', '6months', '1year', '5years']);
});

test('marketplace fora da curva não vira o menor preço', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      data: {
        product_history: [
          { date: '2026-02-01', condition: 'NEW', price: 750, price_where: 'Mercado Livre' },
          { date: '2026-02-02', condition: 'NEW', price: 900, price_where: 'Amazon' },
          { date: '2026-02-03', condition: 'NEW', price: 1200, price_where: 'Loja' },
        ],
      },
    }),
  });
  assert.deepEqual((await fetchPriceHistory('ruins', fetchImpl)).map(({ price }) => price), [1200]);
});
