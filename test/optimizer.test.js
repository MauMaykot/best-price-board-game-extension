import assert from 'node:assert/strict';
import test from 'node:test';
import { findCheapestCarts } from '../src/optimizer/optimizer.js';

const offer = (gameId, storeId, price) => ({ gameId, storeId, storeName: storeId, price, url: `https://${storeId}/${gameId}` });
const flatFreight = (cost) => async () => ({ cost });
const storesOf = (plan) => plan.carts.map((cart) => cart.storeId).sort();

test('frete unificado faz a mesma loja vencer preços unitários menores', async () => {
  const offers = [offer('a', 'x', 100), offer('b', 'x', 100), offer('a', 'y', 95), offer('b', 'z', 95)];
  const { plans } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight: flatFreight(30) });
  assert.deepEqual(storesOf(plans[0]), ['x']);
  assert.equal(plans[0].total, 230);
});

test('divide entre lojas quando a economia supera o frete extra', async () => {
  const offers = [offer('a', 'x', 200), offer('b', 'x', 200), offer('a', 'y', 100), offer('b', 'z', 100)];
  const { plans } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight: flatFreight(30) });
  assert.deepEqual(storesOf(plans[0]), ['y', 'z']);
  assert.equal(plans[0].total, 260);
});

test('frete grátis por valor do pedido entra na comparação', async () => {
  const offers = [offer('a', 'x', 160), offer('b', 'x', 160), offer('a', 'y', 140), offer('b', 'y', 170)];
  const quoteFreight = async (store, items) => {
    const subtotal = items.reduce((sum, item) => sum + item.price, 0);
    return { cost: store.id === 'x' && subtotal >= 300 ? 0 : 40 };
  };
  const { plans } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight });
  assert.deepEqual(storesOf(plans[0]), ['x']);
  assert.equal(plans[0].total, 320);
});

test('desconto no frete entra na comparação', async () => {
  const offers = [offer('a', 'x', 100), offer('b', 'x', 110), offer('a', 'y', 90), offer('b', 'z', 100)];
  const quoteFreight = async (store, items) => ({ cost: items.length === 2 ? 15 : 30 });
  const { plans } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight });
  assert.deepEqual(storesOf(plans[0]), ['x']);
  assert.equal(plans[0].freightTotal, 15);
});

test('usa a oferta mais barata quando a loja repete o jogo', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'x', 90)];
  const { plans } = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10) });
  assert.equal(plans[0].total, 100);
});

test('devolve alternativas em ordem crescente', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'y', 110), offer('a', 'z', 120)];
  const { plans } = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10) });
  assert.deepEqual(plans.map((plan) => plan.total), [110, 120, 130]);
});

test('não cota carrinhos que não têm como vencer', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'y', 101), offer('a', 'caro1', 500), offer('a', 'caro2', 600)];
  const { plans, quotesUsed } = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10), topK: 1 });
  assert.equal(plans[0].total, 110);
  assert.equal(quotesUsed, 2);
});

test('loja sem cotação sai do plano e é sinalizada se ainda pudesse vencer', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'sem-frete', 60)];
  const quoteFreight = async (store) => (store.id === 'sem-frete' ? null : { cost: 20 });
  const { plans, unquotedCarts } = await findCheapestCarts({ games: ['a'], offers, quoteFreight });
  assert.equal(plans.length, 1);
  assert.deepEqual(storesOf(plans[0]), ['x']);
  assert.equal(unquotedCarts.length, 1);
  assert.equal(unquotedCarts[0].storeId, 'sem-frete');
  assert.equal(unquotedCarts[0].subtotal, 60);
  assert.equal(unquotedCarts[0].maxFreightToWin, 60);
  assert.deepEqual(unquotedCarts[0].items.map((item) => item.gameId), ['a']);
});

test('loja sem cotação que não venceria nem com frete 0 não pede frete', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'sem-frete', 150)];
  const quoteFreight = async (store) => (store.id === 'sem-frete' ? null : { cost: 20 });
  const { unquotedCarts } = await findCheapestCarts({ games: ['a'], offers, quoteFreight, topK: 3 });
  assert.deepEqual(unquotedCarts, []);
});

test('nenhuma loja cotada ainda lista os carrinhos para informar o frete', async () => {
  const { plans, unquotedCarts } = await findCheapestCarts({ games: ['a'], offers: [offer('a', 'x', 100)], quoteFreight: async () => null });
  assert.deepEqual(plans, []);
  assert.equal(unquotedCarts.length, 1);
  assert.equal(unquotedCarts[0].maxFreightToWin, null);
});

test('jogos que só existem em lojas sem cotação pedem o frete de cada carrinho', async () => {
  const offers = [offer('a', 'x', 100), offer('b', 'y', 100)];
  const { plans, unquotedCarts } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight: async () => null });
  assert.deepEqual(plans, []);
  assert.deepEqual(unquotedCarts.map((cart) => cart.storeId).sort(), ['x', 'y']);
});

test('dois carrinhos sem cotação que só vencem juntos são pedidos', async () => {
  const offers = [
    offer('a', 'cotada', 100),
    offer('b', 'cotada', 100),
    offer('a', 'sem1', 60),
    offer('b', 'sem2', 60),
  ];
  const quoteFreight = async (store) => (store.id === 'cotada' ? { cost: 10 } : null);
  const { unquotedCarts } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight });
  const byStore = Object.fromEntries(unquotedCarts.map((cart) => [cart.storeId, cart.maxFreightToWin]));
  assert.equal(byStore.sem1, 90);
  assert.equal(byStore.sem2, 90);
});

test('mostra o total à vista e a prazo', async () => {
  const offers = [{ ...offer('a', 'x', 90), listPrice: 100 }, { ...offer('b', 'x', 45), listPrice: 50 }];
  const { plans } = await findCheapestCarts({ games: ['a', 'b'], offers, quoteFreight: flatFreight(20) });
  assert.equal(plans[0].total, 155);
  assert.equal(plans[0].cashTotal, 155);
  assert.equal(plans[0].installmentTotal, 170);
});

test('oferta sem preço cheio informado usa o próprio preço', async () => {
  const { plans } = await findCheapestCarts({ games: ['a'], offers: [offer('a', 'x', 90)], quoteFreight: flatFreight(10) });
  assert.equal(plans[0].installmentTotal, 100);
});

test('o modo de pagamento define quem vence', async () => {
  const offers = [
    { ...offer('a', 'desconto-grande', 90), listPrice: 120 },
    { ...offer('a', 'preco-liso', 100), listPrice: 100 },
  ];
  const aVista = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10) });
  const aPrazo = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10), paymentMode: 'installment' });

  assert.deepEqual(storesOf(aVista.plans[0]), ['desconto-grande']);
  assert.equal(aVista.plans[0].total, 100);
  assert.deepEqual(storesOf(aPrazo.plans[0]), ['preco-liso']);
  assert.equal(aPrazo.plans[0].total, 110);
  assert.equal(aPrazo.plans[1].total, 130);
});

test('a prazo mantém os dois valores de cada plano', async () => {
  const offers = [{ ...offer('a', 'x', 90), listPrice: 120 }];
  const { plans } = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10), paymentMode: 'installment' });
  assert.equal(plans[0].cashTotal, 100);
  assert.equal(plans[0].installmentTotal, 130);
  assert.equal(plans[0].carts[0].cashSubtotal, 90);
  assert.equal(plans[0].carts[0].installmentSubtotal, 120);
});

test('cupom entra nos subtotais à vista e a prazo do carrinho', async () => {
  const offers = [{ ...offer('a', 'x', 90), listPrice: 100 }, { ...offer('b', 'x', 90), listPrice: 100 }];
  const { plans } = await findCheapestCarts({
    games: ['a', 'b'],
    offers,
    quoteFreight: flatFreight(10),
    coupons: { x: { type: 'percent', value: 10 } },
    paymentMode: 'installment',
  });
  const [cart] = plans[0].carts;
  assert.equal(cart.cashSubtotal, 162);
  assert.equal(cart.installmentSubtotal, 180);
  assert.equal(cart.couponSavings, 20);
});

test('a logo da loja acompanha o carrinho', async () => {
  const offers = [{ ...offer('a', 'x', 90), storeLogo: 'https://loja.com/logo.png' }];
  const { plans } = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10) });
  assert.equal(plans[0].carts[0].storeLogo, 'https://loja.com/logo.png');
});

test('cupom percentual vale só para os jogos, não para o frete', async () => {
  const { plans } = await findCheapestCarts({
    games: ['a'],
    offers: [offer('a', 'x', 200)],
    quoteFreight: flatFreight(30),
    coupons: { x: { type: 'percent', value: 10 } },
  });
  assert.equal(plans[0].total, 210);
  assert.equal(plans[0].freightTotal, 30);
  assert.equal(plans[0].carts[0].couponSavings, 20);
});

test('cupom de valor fixo não passa do valor dos jogos nem desconta o frete', async () => {
  const { plans } = await findCheapestCarts({
    games: ['a'],
    offers: [offer('a', 'x', 50)],
    quoteFreight: flatFreight(30),
    coupons: { x: { type: 'fixed', value: 80 } },
  });
  assert.equal(plans[0].total, 30);
  assert.equal(plans[0].carts[0].couponSavings, 50);
});

test('cupom vale só para a loja dele e pode mudar a combinação vencedora', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'y', 110)];
  const semCupom = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10) });
  const comCupom = await findCheapestCarts({
    games: ['a'],
    offers,
    quoteFreight: flatFreight(10),
    coupons: { y: { type: 'fixed', value: 20 } },
  });
  assert.deepEqual(storesOf(semCupom.plans[0]), ['x']);
  assert.deepEqual(storesOf(comCupom.plans[0]), ['y']);
  assert.equal(comCupom.plans[0].total, 100);
  assert.equal(comCupom.plans[1].total, 110);
});

test('cupom entra junto com o desconto de pagamento nos dois totais', async () => {
  const { plans } = await findCheapestCarts({
    games: ['a'],
    offers: [{ ...offer('a', 'x', 90), listPrice: 100 }],
    quoteFreight: flatFreight(10),
    coupons: { x: { type: 'percent', value: 10 } },
  });
  assert.equal(plans[0].total, 91);
  assert.equal(plans[0].installmentTotal, 100);
});

test('informa resultados parciais só com carrinhos já cotados', async () => {
  const offers = [offer('a', 'x', 100), offer('b', 'y', 100), offer('b', 'x', 150)];
  const snapshots = [];
  const { plans } = await findCheapestCarts({
    games: ['a', 'b'],
    offers,
    quoteFreight: flatFreight(10),
    progressIntervalMs: 0,
    onProgress: (partial) => snapshots.push(partial),
  });

  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every((partial) => partial.every((plan) => plan.carts.every((cart) => cart.quote))));
  assert.ok(snapshots.some((partial) => partial.length > 0));
  assert.equal(snapshots.at(-1)[0].total, plans[0].total);
});

test('o parcial pode ser pior que o resultado final', async () => {
  const offers = [offer('a', 'cara', 100), offer('a', 'barata', 101)];
  const freight = { cara: 50, barata: 0 };
  const snapshots = [];
  const { plans } = await findCheapestCarts({
    games: ['a'],
    offers,
    topK: 1,
    quoteFreight: async (store) => ({ cost: freight[store.id] }),
    progressIntervalMs: 0,
    onProgress: (partial) => snapshots.push(partial.map((plan) => plan.total)),
  });
  assert.deepEqual(snapshots[0], [150]);
  assert.equal(plans[0].total, 101);
});

test('limita a frequência dos parciais', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'y', 101), offer('a', 'z', 102)];
  let calls = 0;
  await findCheapestCarts({
    games: ['a'],
    offers,
    quoteFreight: flatFreight(10),
    progressIntervalMs: 60000,
    onProgress: () => { calls += 1; },
  });
  assert.equal(calls, 1);
});

test('cancelar para de cotar e devolve o melhor até ali', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'y', 101), offer('a', 'z', 102), offer('a', 'w', 103)];
  const controller = new AbortController();
  const quoted = [];
  const result = await findCheapestCarts({
    games: ['a'],
    offers,
    topK: 1,
    signal: controller.signal,
    quoteFreight: async (store) => {
      quoted.push(store.id);
      if (quoted.length === 2) controller.abort();
      return { cost: 50 };
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.proven, false);
  assert.equal(quoted.length, 2);
  assert.deepEqual(storesOf(result.plans[0]), ['x']);
  assert.deepEqual(result.unquotedCarts, []);
});

test('cancelar antes da primeira cotação não cota nada', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await findCheapestCarts({
    games: ['a'],
    offers: [offer('a', 'x', 100)],
    signal: controller.signal,
    quoteFreight: async () => { throw new Error('não deveria cotar'); },
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.plans, []);
  assert.equal(result.quotesUsed, 0);
});

test('busca sem cancelamento não marca o resultado', async () => {
  const { cancelled } = await findCheapestCarts({ games: ['a'], offers: [offer('a', 'x', 100)], quoteFreight: flatFreight(10) });
  assert.equal(cancelled, undefined);
});

test('carrinho indisponível sai da conta e não pede frete', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'pre-venda', 60)];
  const quoteFreight = async (store) => (store.id === 'pre-venda' ? { unavailable: 'pré-venda' } : { cost: 20 });
  const { plans, unquotedCarts } = await findCheapestCarts({ games: ['a'], offers, quoteFreight });
  assert.deepEqual(plans.map(storesOf), [['x']]);
  assert.deepEqual(unquotedCarts, []);
});

test('frete informado para o carrinho entra na comparação como qualquer cotação', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'manual', 60)];
  const quoteFreight = async (store) => ({ cost: store.id === 'manual' ? 15 : 20 });
  const { plans, unquotedCarts } = await findCheapestCarts({ games: ['a'], offers, quoteFreight });
  assert.deepEqual(storesOf(plans[0]), ['manual']);
  assert.equal(plans[0].total, 75);
  assert.deepEqual(unquotedCarts, []);
});

test('erro na cotação não derruba a busca', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'quebrada', 50)];
  const quoteFreight = async (store) => {
    if (store.id === 'quebrada') throw new Error('timeout');
    return { cost: 10 };
  };
  const { plans } = await findCheapestCarts({ games: ['a'], offers, quoteFreight });
  assert.deepEqual(storesOf(plans[0]), ['x']);
});

test('jogo sem nenhuma oferta é informado e os demais seguem', async () => {
  const { plans, missingGames } = await findCheapestCarts({ games: ['a', 'b'], offers: [offer('a', 'x', 100)], quoteFreight: flatFreight(10) });
  assert.deepEqual(missingGames, ['b']);
  assert.equal(plans[0].total, 110);
});

test('estourar o limite de cotações marca o resultado como não comprovado', async () => {
  const offers = [offer('a', 'x', 100), offer('a', 'y', 101), offer('a', 'z', 102)];
  const { proven, quotesUsed } = await findCheapestCarts({ games: ['a'], offers, quoteFreight: flatFreight(10), maxQuotes: 1, topK: 3 });
  assert.equal(proven, false);
  assert.ok(quotesUsed <= 1);
});

test('sem oferta alguma devolve lista vazia', async () => {
  const { plans, missingGames } = await findCheapestCarts({ games: ['a'], offers: [], quoteFreight: flatFreight(10) });
  assert.deepEqual(plans, []);
  assert.deepEqual(missingGames, ['a']);
});

// Compara com a força bruta para garantir que a busca sob demanda acha o ótimo real.
test('coincide com a força bruta em cenários aleatórios', async () => {
  let seed = 20261030;
  const random = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % limit;
  };

  let compared = 0;
  for (let round = 0; round < 300; round += 1) {
    const games = Array.from({ length: 1 + random(4) }, (_, index) => `g${index}`);
    const stores = Array.from({ length: 1 + random(5) }, (_, index) => ({
      id: `s${index}`,
      base: 10 + random(40),
      extra: random(15),
      freeFrom: random(2) ? 150 + random(300) : Infinity,
    }));
    const offers = stores.flatMap((store) => games
      .filter(() => random(4) > 0)
      .map((game) => offer(game, store.id, 50 + random(200))));
    if (!games.every((game) => offers.some((item) => item.gameId === game))) continue;

    const freightOf = (storeId, items) => {
      const store = stores.find((candidate) => candidate.id === storeId);
      const subtotal = items.reduce((sum, item) => sum + item.price, 0);
      return subtotal >= store.freeFrom ? 0 : store.base + store.extra * (items.length - 1);
    };
    const { plans, proven } = await findCheapestCarts({
      games,
      offers,
      topK: 1,
      maxQuotes: 10000,
      quoteFreight: async (store, items) => ({ cost: freightOf(store.id, items) }),
    });

    assert.equal(proven, true);
    assert.equal(plans[0].total, bruteForce(games, offers, freightOf));
    compared += 1;
  }

  assert.ok(compared >= 100, `só ${compared} cenários foram comparados`);
});

function bruteForce(games, offers, freightOf) {
  let best = Infinity;
  const walk = (index, chosen) => {
    if (index === games.length) {
      const carts = Object.groupBy(chosen, (item) => item.storeId);
      const total = Object.entries(carts).reduce((sum, [storeId, items]) => (
        sum + freightOf(storeId, items) + items.reduce((itemSum, item) => itemSum + item.price, 0)
      ), 0);
      best = Math.min(best, total);
      return;
    }
    for (const item of offers.filter((candidate) => candidate.gameId === games[index])) {
      walk(index + 1, [...chosen, item]);
    }
  };
  walk(0, []);
  return best;
}
