// Encontra a combinação de carrinhos de menor valor total (produtos + frete).
//
// O frete é tratado como caixa-preta: `quoteFreight(store, offers)` devolve o valor
// real daquele carrinho inteiro. Por isso frete unificado, frete grátis por valor e
// desconto no frete não precisam de regra aqui: basta comparar as cotações.
//
// Como cada cotação é uma chamada à loja, elas são feitas sob demanda:
//   1. Carrinhos ainda não cotados entram na conta com frete 0 (limite inferior).
//   2. Calcula os melhores planos com esses valores.
//   3. Cota os carrinhos desses planos que ainda não têm preço real e repete.
// Quando os melhores planos só têm carrinhos cotados, nenhum outro plano pode vencer,
// porque até o custo mínimo possível dos demais já é maior ou igual.

const DEFAULT_MAX_QUOTES = 200;
const DEFAULT_TOP_K = 3;
const MAX_GAMES = 12;
const MAX_PARALLEL_QUOTES = 6;
const UNQUOTED_PLANS_TO_CHECK = 20;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
const UNAVAILABLE = false;
const PRICE_FIELDS = { cash: 'price', installment: 'listPrice' };

const toCents = (value) => Math.round(value * 100);
const toBrl = (cents) => cents / 100;

export async function findCheapestCarts({
  games,
  offers,
  quoteFreight,
  coupons = {},
  paymentMode = 'cash',
  maxQuotes = DEFAULT_MAX_QUOTES,
  topK = DEFAULT_TOP_K,
  onProgress = null,
  progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
  signal = null,
}) {
  const stockedGames = games.filter((game) => offers.some((offer) => offer.gameId === game));
  const missingGames = games.filter((game) => !stockedGames.includes(game));
  if (stockedGames.length > MAX_GAMES) {
    throw new Error(`Máximo de ${MAX_GAMES} jogos por busca.`);
  }

  const stores = groupOffersByStore(stockedGames, offers, coupons, PRICE_FIELDS[paymentMode]);
  const fullMask = (1 << stockedGames.length) - 1;
  const quotes = new Map();
  let quotesUsed = 0;
  let proven = true;

  const realCost = (store, mask) => {
    const quote = quotes.get(cartKey(store, mask));
    return quote ? subtotalCents(store, mask) + quote.costCents : null;
  };
  const lowerBound = (store, mask) => (
    quotes.has(cartKey(store, mask)) ? realCost(store, mask) : subtotalCents(store, mask)
  );

  // Parcial: só planos com todos os carrinhos cotados, e o ranking ainda pode mudar.
  let lastProgress = -Infinity;
  const reportProgress = () => {
    if (!onProgress || Date.now() - lastProgress < progressIntervalMs) return;
    lastProgress = Date.now();
    onProgress(rankPlans(stores, fullMask, topK, realCost).map((plan) => describePlan(plan, quotes)));
  };

  let bestPlans = [];
  while (true) {
    bestPlans = rankPlans(stores, fullMask, topK, lowerBound);
    const pending = new Map();
    for (const { carts } of bestPlans) {
      for (const cart of carts) {
        const key = cartKey(cart.store, cart.mask);
        if (!quotes.has(key)) pending.set(key, cart);
      }
    }
    if (pending.size === 0) break;

    // Cancelada: devolve o melhor entre o que já foi cotado.
    if (signal?.aborted) {
      return {
        plans: rankPlans(stores, fullMask, topK, realCost).map((plan) => describePlan(plan, quotes)),
        missingGames,
        quotesUsed,
        proven: false,
        unquotedCarts: [],
        cancelled: true,
      };
    }

    if (quotesUsed + pending.size > maxQuotes) {
      proven = false;
      bestPlans = rankPlans(stores, fullMask, topK, realCost);
      break;
    }

    quotesUsed += pending.size;
    await mapWithLimit([...pending], MAX_PARALLEL_QUOTES, async ([key, { store, mask }]) => {
      if (signal?.aborted) return;
      quotes.set(key, await requestQuote(quoteFreight, store, mask));
      reportProgress();
    });
  }

  const plans = bestPlans.map((plan) => describePlan(plan, quotes));
  return {
    plans,
    missingGames,
    quotesUsed,
    proven,
    unquotedCarts: findUnquotedCarts(stores, fullMask, quotes, plans[0]),
  };
}

function groupOffersByStore(games, offers, coupons, priceField) {
  const stores = new Map();
  for (const offer of offers) {
    const gameIndex = games.indexOf(offer.gameId);
    if (gameIndex === -1) continue;
    if (!stores.has(offer.storeId)) {
      stores.set(offer.storeId, {
        id: offer.storeId,
        name: offer.storeName,
        logo: offer.storeLogo ?? null,
        offers: new Map(),
        mask: 0,
        coupon: coupons[offer.storeId] ?? null,
        priceField,
      });
    }
    const store = stores.get(offer.storeId);
    const current = store.offers.get(gameIndex);
    if (!current || offer.price < current.price) store.offers.set(gameIndex, offer);
    store.mask |= 1 << gameIndex;
  }
  return [...stores.values()];
}

// Programação dinâmica por loja sobre subconjuntos de jogos. Processar loja a loja
// garante um único carrinho por loja, que é justamente o que unifica o frete.
function rankPlans(stores, fullMask, topK, cartCost) {
  let table = new Array(fullMask + 1).fill(null).map(() => []);
  table[0] = [{ costCents: 0, cartCount: 0, previous: null, cart: null }];

  for (const store of stores) {
    const next = table.map((entries) => [...entries]);
    for (let mask = 1; mask <= fullMask; mask += 1) {
      const buyable = mask & store.mask;
      for (let sub = buyable; sub > 0; sub = (sub - 1) & buyable) {
        const cost = cartCost(store, sub);
        if (cost === null) continue;
        for (const previous of table[mask ^ sub]) {
          insertRanked(next[mask], {
            costCents: previous.costCents + cost,
            cartCount: previous.cartCount + 1,
            previous,
            cart: { store, mask: sub },
          }, topK);
        }
      }
    }
    table = next;
  }

  return table[fullMask].filter((entry) => entry.cart).map(unwindPlan);
}

// Em caso de empate no valor, prefere menos lojas: são menos entregas para acompanhar.
function insertRanked(entries, entry, topK) {
  const position = entries.findIndex((other) => (
    entry.costCents < other.costCents
    || (entry.costCents === other.costCents && entry.cartCount < other.cartCount)
  ));
  entries.splice(position === -1 ? entries.length : position, 0, entry);
  entries.length = Math.min(entries.length, topK);
}

function unwindPlan(entry) {
  const carts = [];
  for (let node = entry; node.cart; node = node.previous) carts.push(node.cart);
  return { carts };
}

// Devolve a cotação, null quando faltou cotar ou UNAVAILABLE quando a loja informa que o
// carrinho não pode ser comprado agora, como em pré-venda. Só o null pede frete ao usuário.
async function requestQuote(quoteFreight, store, mask) {
  try {
    const quote = await quoteFreight({ id: store.id, name: store.name }, offersIn(store, mask));
    if (quote?.unavailable) return UNAVAILABLE;
    if (!quote || !Number.isFinite(quote.cost) || quote.cost < 0) return null;
    return { ...quote, costCents: toCents(quote.cost) };
  } catch {
    return null;
  }
}

// Carrinhos sem cotação que ainda venceriam o melhor plano, para o usuário informar o
// frete. Considera frete 0 neles e diz o máximo que podem cobrar para valer a pena; sem
// nenhum plano cotado, todo carrinho que completa a compra entra na lista.
function findUnquotedCarts(stores, fullMask, quotes, bestPlan) {
  const bestCents = bestPlan ? toCents(bestPlan.total) : null;
  const optimistic = (store, mask) => {
    const key = cartKey(store, mask);
    if (!quotes.has(key) || quotes.get(key) === UNAVAILABLE) return null;
    return subtotalCents(store, mask) + (quotes.get(key)?.costCents ?? 0);
  };

  const carts = new Map();
  for (const plan of rankPlans(stores, fullMask, UNQUOTED_PLANS_TO_CHECK, optimistic)) {
    const floorCents = plan.carts.reduce((sum, { store, mask }) => sum + optimistic(store, mask), 0);
    if (bestCents !== null && floorCents >= bestCents) break;

    for (const { store, mask } of plan.carts) {
      const key = cartKey(store, mask);
      if (quotes.get(key) !== null || carts.has(key)) continue;
      carts.set(key, {
        storeId: store.id,
        storeName: store.name,
        storeLogo: store.logo,
        items: offersIn(store, mask),
        subtotal: toBrl(subtotalCents(store, mask)),
        maxFreightToWin: bestCents === null ? null : toBrl(bestCents - floorCents),
      });
    }
  }
  return [...carts.values()];
}

function describePlan(plan, quotes) {
  const carts = plan.carts.map(({ store, mask }) => {
    const quote = quotes.get(cartKey(store, mask));
    const subtotal = subtotalCents(store, mask);
    return {
      storeId: store.id,
      storeName: store.name,
      storeLogo: store.logo,
      items: offersIn(store, mask),
      subtotal: toBrl(subtotal),
      cashSubtotal: toBrl(modeSubtotalCents(store, mask, 'price')),
      installmentSubtotal: toBrl(modeSubtotalCents(store, mask, 'listPrice')),
      couponSavings: toBrl(sumCents(store, mask, store.priceField) - subtotal),
      freight: toBrl(quote.costCents),
      quote,
    };
  });
  const sumCarts = (read) => plan.carts.reduce((sum, { store, mask }) => sum + read(store, mask), 0);
  const productsCents = sumCarts(subtotalCents);
  const cashCents = sumCarts((store, mask) => modeSubtotalCents(store, mask, 'price'));
  const installmentCents = sumCarts((store, mask) => modeSubtotalCents(store, mask, 'listPrice'));
  const freightCents = carts.reduce((sum, cart) => sum + cart.quote.costCents, 0);
  return {
    total: toBrl(productsCents + freightCents),
    cashTotal: toBrl(cashCents + freightCents),
    installmentTotal: toBrl(installmentCents + freightCents),
    productsTotal: toBrl(productsCents),
    freightTotal: toBrl(freightCents),
    carts,
  };
}

async function mapWithLimit(items, limit, task) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length > 0) await task(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function offersIn(store, mask) {
  return [...store.offers].filter(([gameIndex]) => mask & (1 << gameIndex)).map(([, offer]) => offer);
}

function sumCents(store, mask, field) {
  return offersIn(store, mask).reduce((sum, offer) => sum + toCents(offer[field] ?? offer.price), 0);
}

// O cupom vale só para os jogos: o frete é somado depois, sem desconto.
function applyCoupon(cents, coupon) {
  if (!coupon) return cents;
  const discount = coupon.type === 'percent' ? Math.round(cents * (coupon.value / 100)) : toCents(coupon.value);
  return Math.max(cents - discount, 0);
}

function modeSubtotalCents(store, mask, field) {
  return applyCoupon(sumCents(store, mask, field), store.coupon);
}

function subtotalCents(store, mask) {
  return modeSubtotalCents(store, mask, store.priceField);
}

function cartKey(store, mask) {
  return `${store.id}|${mask}`;
}
