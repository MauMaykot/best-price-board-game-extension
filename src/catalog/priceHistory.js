// Compara o preço de hoje com o histórico do Compara Jogos, para dizer se está bom mesmo.
//
// O histórico traz o menor preço de cada dia e não inclui frete, então a comparação usa só
// o preço do jogo. A Amazon fica de fora dele quando a consulta não tem login.

import { graphql } from './offers.js';

const PRODUCT_HISTORY_QUERY = `
  query productHistory($slug: String!, $period: String!) {
    product_history(args: {slug: $slug, period: $period, include_amazon: false}) {
      date
      condition
      price
      price_where
    }
  }
`;

// Quanto maior o período, mais espaçados os pontos: 5 anos vem com um ponto por trimestre, e
// 1 mês vem com um por dia. Juntar os períodos dá detalhe recente e alcance longo.
const PERIODS = ['1month', '6months', '1year', '5years'];
// Anúncios de marketplace variam muito por vendedor, e um preço fora da curva viraria o
// "menor preço" e faria todas as lojas normais parecerem caras.
const MARKETPLACES = /mercado livre|amazon/i;
const MIN_POINTS = 8;
const DAY_MS = 86400000;
const AVERAGE_DAYS = 180;
const RECENT_DAYS = 60;
const LOWEST_TOLERANCE = 0.01;
const NEAR_LOWEST = 0.05;
const BELOW_AVERAGE = 0.03;
const ABOVE_AVERAGE = 0.05;
const TOO_GOOD = 0.3;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const brl = (value) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const percent = (ratio) => `${Math.round(Math.abs(ratio) * 100)}%`;
const monthOf = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]}/${date.slice(0, 4)}`;
const daysBetween = (date, today) => (today.getTime() - Date.parse(date)) / DAY_MS;

export async function fetchPriceHistory(slug, fetchImpl = fetch) {
  const pages = await Promise.all(PERIODS.map((period) => (
    graphql(fetchImpl, 'productHistory', PRODUCT_HISTORY_QUERY, { slug, period })
  )));

  const byDate = new Map();
  for (const { product_history: history } of pages) {
    for (const { date, condition, price, price_where: store } of history) {
      if (condition !== 'NEW' || !(price > 0) || MARKETPLACES.test(store)) continue;
      if (!byDate.has(date) || price < byDate.get(date).price) byDate.set(date, { date, price, store });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function describePrice(price, history, today = new Date()) {
  if (history.length < MIN_POINTS) return null;

  const lowest = history.reduce((best, point) => (point.price < best.price ? point : best));
  const recent = history.filter(({ date }) => daysBetween(date, today) <= AVERAGE_DAYS);
  const average = recent.length > 0 ? recent.reduce((sum, point) => sum + point.price, 0) / recent.length : null;
  const aboveLowest = price / lowest.price - 1;
  const versusAverage = average === null ? 0 : price / average - 1;
  const lastCheaper = history.findLast((point) => point.price < price);

  const detail = aboveLowest > LOWEST_TOLERANCE ? `Menor preço: ${brl(lowest.price)} em ${monthOf(lowest.date)}` : null;

  // Um preço muito fora da curva costuma ser outro produto ou vendedor duvidoso, não pechincha.
  if (versusAverage <= -TOO_GOOD) {
    return { tone: 'high', headline: `${percent(versusAverage)} abaixo da média de 6 meses: confira o anúncio`, detail };
  }
  if (aboveLowest <= LOWEST_TOLERANCE) {
    return { tone: 'great', headline: `Menor preço desde ${monthOf(history[0].date)}, início do histórico`, detail };
  }
  if (daysBetween(lastCheaper.date, today) > RECENT_DAYS) {
    return { tone: 'good', headline: `Melhor preço desde ${monthOf(lastCheaper.date)}`, detail };
  }
  if (aboveLowest <= NEAR_LOWEST) {
    return { tone: 'good', headline: `Perto do menor preço: ${percent(aboveLowest)} acima`, detail };
  }
  if (versusAverage <= -BELOW_AVERAGE) {
    return { tone: 'good', headline: `${percent(versusAverage)} abaixo da média de 6 meses`, detail };
  }
  if (versusAverage >= ABOVE_AVERAGE) {
    return { tone: 'high', headline: `${percent(versusAverage)} acima da média de 6 meses`, detail };
  }
  return { tone: 'neutral', headline: 'Dentro da média de 6 meses', detail };
}
