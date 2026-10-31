// Uso: npm run quote -- 01310100 compile-main-1 ruins

import { fetchCatalog, slugFromUrl } from './catalog/offers.js';
import { applyStoreDiscounts } from './catalog/paymentDiscount.js';
import { describePrice, fetchPriceHistory } from './catalog/priceHistory.js';
import { createQuoter } from './freight/quoter.js';
import { createFetchSession } from './node/fetchSession.js';
import { findCheapestCarts } from './optimizer/optimizer.js';

const args = process.argv.slice(2);
const paymentMode = args.includes('--a-prazo') ? 'installment' : 'cash';
const [zipCode, ...games] = args.filter((arg) => arg !== '--a-prazo');
if (!zipCode || games.length === 0) {
  console.error('Uso: npm run quote -- <cep> <jogo> [jogo...] [--a-prazo]');
  process.exit(1);
}

const brl = (value) => `R$ ${value.toFixed(2)}`;

const catalogs = await Promise.all(games.map(async (game) => {
  const catalog = await fetchCatalog(slugFromUrl(game));
  return {
    ...catalog,
    offers: await applyStoreDiscounts(catalog.offers),
    history: await fetchPriceHistory(catalog.slug).catch(() => []),
  };
}));
const histories = new Map(catalogs.map(({ slug, history }) => [slug, history]));
for (const { name, offers, excluded } of catalogs) {
  console.log(`${name}: ${offers.length} ofertas elegíveis, ${excluded.length} excluídas`);
}

const result = await findCheapestCarts({
  games: catalogs.map((catalog) => catalog.slug),
  offers: catalogs.flatMap((catalog) => catalog.offers),
  quoteFreight: createQuoter({ zipCode, createSession: createFetchSession }),
  paymentMode,
  topK: 4,
});

result.plans.forEach((plan, index) => {
  console.log(`\n${index + 1}. ${brl(plan.cashTotal)} à vista, ${brl(plan.installmentTotal)} a prazo (frete ${brl(plan.freightTotal)})`);
  for (const cart of plan.carts) {
    console.log(`   ${cart.storeName}: frete ${brl(cart.freight)}, ${cart.quote.service}`);
    if (cart.quote.preOrder) console.log('     Pré-venda, segundo a loja');
    for (const item of cart.items) {
      console.log(`     ${brl(item.price)}  ${item.gameId}  ${item.url}${item.maybePreOrder ? '  (pode ser pré-venda)' : ''}`);
      const note = describePrice(item.price, histories.get(item.gameId));
      if (note) console.log(`       ${[note.headline, note.detail].filter(Boolean).join(' | ')}`);
    }
  }
});

if (result.missingGames.length > 0) console.log(`\nJogos sem oferta: ${result.missingGames.join(', ')}`);
if (!result.proven) console.log('\nAtenção: limite de cotações atingido; o menor valor não está comprovado.');
for (const { storeName, items, maxFreightToWin } of result.unquotedCarts) {
  const detail = maxFreightToWin === null ? 'sem plano para comparar' : `venceria com frete de até ${brl(maxFreightToWin)}`;
  console.log(`\nSem cotação: ${storeName} [${items.map((item) => item.gameId).join(', ')}] (${detail})`);
}
console.log(`\nCotações usadas: ${result.quotesUsed}`);
