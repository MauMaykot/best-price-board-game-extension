import { fetchCatalog, fetchGameSummary, isItemUrl, itemUrl, searchGames, slugFromUrl } from '../src/catalog/offers.js';
import { applyStoreDiscounts } from '../src/catalog/paymentDiscount.js';
import { describePrice, fetchPriceHistory } from '../src/catalog/priceHistory.js';
import { loadStoreIcons } from '../src/catalog/storeIcons.js';
import {
  cookieDomain,
  createBrowserSession,
  restoreInterruptedQuotes,
  withIsolatedCookies,
} from '../src/extension/isolatedSession.js';
import { maskZipCode } from '../src/freight/delivery.js';
import { createQuoter, fillCart, isManualOnly } from '../src/freight/quoter.js';
import { discountPercent, formatPercent, summarizeDiscounts } from '../src/optimizer/discounts.js';
import { diceFaces, renderDie } from './sprites.js';
import { findCheapestCarts } from '../src/optimizer/optimizer.js';

const ITEM_TABS = 'https://www.comparajogos.com.br/item/*';
const SEARCH_DELAY_MS = 300;
const RUN_LABEL = 'Encontrar menor valor';
const MAX_VISIBLE_DICE = 6;

const elements = Object.fromEntries(
  ['color-toggle', 'icon-sun', 'icon-moon', 'search-form', 'setup', 'setup-info', 'zip-code', 'game-input', 'suggestions', 'games', 'games-empty', 'refresh-tabs', 'run', 'run-label', 'turn-dice', 'cancel',
    'status', 'end-title', 'coupons', 'coupon-form', 'coupon-store', 'coupon-code', 'coupon-value', 'coupon-type', 'coupon-list', 'results']
    .map((id) => [id, document.getElementById(id)]),
);

// slug -> { name, image }. O nome começa como o slug até chegar o resumo do Compara Jogos.
const games = new Map();
// Guardados por busca, para recalcular com um frete informado sem repetir as cotações.
const quoteCache = new Map();
const manualFreight = new Map();
// storeId -> cupom. Continua valendo entre buscas, até o usuário remover.
const coupons = new Map();
// Carrinhos já montados nesta busca: clicar de novo só reabre, sem duplicar os itens.
const filledCarts = new Map();
let lastSearch = null;
let searchAbort = null;
let searchTimer;

const brl = (value) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const paymentMode = () => document.querySelector('input[name="payment-mode"]:checked').value;
const gameName = (slug) => games.get(slug)?.name ?? slug;
const cartKey = (storeId, offers) => `${storeId}|${offers.map((offer) => offer.gameId).sort().join(',')}`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(message, isError = false) {
  elements.status.hidden = !message;
  elements.status.textContent = message ?? '';
  elements.status.classList.toggle('error', isError);
}

function externalLink(className, text, href) {
  const link = element('a', className, text);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  return link;
}

function renderPhoto(image) {
  const photo = element('img', 'game-photo');
  photo.alt = '';
  photo.src = image;
  photo.addEventListener('error', () => photo.remove());
  return photo;
}

function renderGames() {
  elements.games.replaceChildren(...[...games].map(([slug, { name, image }]) => {
    const row = element('li');
    const remove = element('button', '', '×');
    remove.type = 'button';
    remove.title = `Remover ${name}`;
    remove.addEventListener('click', () => {
      games.delete(slug);
      renderGames();
    });
    if (image) row.append(renderPhoto(image));
    const title = element('span');
    title.append(externalLink('game-link', name, itemUrl(slug)));
    row.append(title, remove);
    return row;
  }));
  elements['games-empty'].hidden = games.size > 0;
}

async function loadGameSummary(slug) {
  const summary = await fetchGameSummary(slug).catch(() => null);
  if (!summary || !games.has(slug)) return;
  games.set(slug, summary);
  renderGames();
}

function addGame(slug, info = null) {
  if (info) games.set(slug, info);
  else if (!games.has(slug)) {
    games.set(slug, { name: slug, image: null });
    loadGameSummary(slug);
  }
  renderGames();
}

async function loadOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ITEM_TABS });
  for (const tab of tabs) addGame(slugFromUrl(tab.url));
}

// Só acrescenta: jogos buscados pelo nome não têm aba aberta e precisam continuar na lista.
async function refreshFromTabs() {
  const before = games.size;
  await loadOpenTabs();
  const added = games.size - before;
  if (added === 0) setStatus('Nenhum jogo novo nas abas abertas.');
  else setStatus(added === 1 ? '1 jogo adicionado das abas abertas.' : `${added} jogos adicionados das abas abertas.`);
}

function hideSuggestions() {
  elements.suggestions.hidden = true;
  elements.suggestions.replaceChildren();
}

function showSuggestions(results) {
  elements.suggestions.replaceChildren(...results.map((game) => {
    const row = element('li');
    const button = element('button');
    button.type = 'button';
    const offers = game.newOffers === 1 ? '1 oferta' : `${game.newOffers} ofertas`;
    if (game.image) button.append(renderPhoto(game.image));
    button.append(element('span', '', game.name), element('small', '', game.isExpansion ? `expansão · ${offers}` : offers));
    button.addEventListener('click', () => {
      addGame(game.slug, { name: game.name, image: game.image });
      elements['game-input'].value = '';
      hideSuggestions();
    });
    row.append(button);
    return row;
  }));
  elements.suggestions.hidden = results.length === 0;
}

function handleGameInput() {
  clearTimeout(searchTimer);
  const text = elements['game-input'].value.trim();

  if (isItemUrl(text)) {
    addGame(slugFromUrl(text));
    elements['game-input'].value = '';
    hideSuggestions();
    return;
  }
  if (text.length < 2) {
    hideSuggestions();
    return;
  }

  searchTimer = setTimeout(async () => {
    try {
      showSuggestions(await searchGames(text));
    } catch (error) {
      setStatus(error.message, true);
    }
  }, SEARCH_DELAY_MS);
}

function createPanelQuoter(zipCode, signal, onQuote) {
  const quote = createQuoter({ zipCode, createSession: () => createBrowserSession(signal) });
  return async (store, offers) => {
    const key = cartKey(store.id, offers);
    if (manualFreight.has(key)) return { cost: manualFreight.get(key), service: 'informado por você', manual: true };
    if (quoteCache.has(key)) return quoteCache.get(key);

    let result = null;
    if (!isManualOnly(offers[0].url)) {
      onQuote(store.name);
      result = await withIsolatedCookies(cookieDomain(offers[0].url), () => quote(store, offers));
    }
    // Falha causada pelo cancelamento não é falta de cotação: não entra no cache.
    if (!signal.aborted) quoteCache.set(key, result);
    return result;
  };
}

// No resultado o nome leva ao Compara Jogos; onde é preciso ver o frete, leva à loja.
function renderGame(item, href = itemUrl(item.gameId)) {
  const label = element('div', 'game');
  label.append(externalLink('game-name', gameName(item.gameId), href));
  if (item.maybePreOrder) label.append(element('div', 'pre-order', 'Pode ser pré-venda: confira na loja'));

  const note = describePrice(item.price, lastSearch.history.get(item.gameId) ?? []);
  if (note) {
    label.append(element('div', `price-note ${note.tone}`, note.headline));
    if (note.detail) label.append(element('div', 'price-detail', note.detail));
  }
  return label;
}

function renderSkeleton() {
  const card = element('article', 'plan skeleton');
  card.setAttribute('aria-hidden', 'true');
  const row = () => {
    const line = element('div', 'skeleton-row');
    line.append(element('div', 'skeleton-line photo'), element('div', 'skeleton-line'));
    return line;
  };
  card.append(
    element('div', 'skeleton-line short'),
    element('div', 'skeleton-line title'),
    element('div', 'skeleton-line short'),
    row(),
    row(),
  );
  return card;
}

// O parcial não tem botão: montar um carrinho real durante as cotações colidiria com a
// troca temporária de cookies, e o vencedor ainda pode mudar.
function renderPartialResult(plans) {
  elements.results.replaceChildren(
    ...plans.map((plan, index) => renderPlan(plan, index === 0, true)),
    renderSkeleton(),
  );
  elements['end-title'].hidden = false;
}

// Depois de cancelar nada mais está cotando, então o parcial já pode levar à loja.
function renderCancelledResult(plans) {
  elements.results.replaceChildren(...plans.map((plan, index) => renderPlan(plan, index === 0, true, true)));
  elements['end-title'].hidden = plans.length === 0;
  if (plans.length === 0) elements.setup.open = true;
}

function renderPlan(plan, isBest, isPartial = false, canBuy = !isPartial) {
  const card = element('article', isBest ? 'plan best' : 'plan');
  if (isBest && isPartial) {
    card.append(element('div', 'plan-label', 'Melhor até agora'));
  } else if (isBest) {
    const winners = plan.carts.map((cart) => cart.storeName).join(' + ');
    card.append(element('div', 'plan-label', `Vencedor: ${winners}`));
  }
  const hasTwoPrices = plan.installmentTotal > plan.cashTotal;
  const cashLabel = `${brl(plan.cashTotal)} à vista`;
  const installmentLabel = `${brl(plan.installmentTotal)} a prazo`;
  const [main, other] = paymentMode() === 'installment' ? [installmentLabel, cashLabel] : [cashLabel, installmentLabel];
  card.append(element('div', 'plan-total', hasTwoPrices ? main : brl(plan.total)));
  if (hasTwoPrices) card.append(element('div', 'plan-full', other));
  const discounts = describeDiscounts(plan);
  if (discounts) card.append(element('div', 'plan-discounts', discounts));
  card.append(element('div', 'plan-split', `${brl(plan.productsTotal)} em jogos + ${plan.freightTotal === 0 ? 'frete grátis' : `${brl(plan.freightTotal)} de frete`}`));

  const blocks = new Map();
  for (const cart of plan.carts) {
    const block = element('div', 'cart');
    blocks.set(cart, block);
    block.append(
      renderStoreName(cart.storeName, cart.storeLogo),
      element('div', cart.quote.manual ? 'cart-freight manual-tag' : 'cart-freight', `${cart.freight === 0 ? 'Frete grátis' : brl(cart.freight)} · ${cart.quote.service}`),
    );
    for (const item of cart.items) {
      const row = element('div', 'item');
      const byInstallment = paymentMode() === 'installment';
      const prices = element('div', 'item-prices', brl(byInstallment ? item.listPrice ?? item.price : item.price));
      if (item.listPrice > item.price) {
        const percent = formatPercent(discountPercent(item.listPrice, item.price));
        prices.append(element('small', '', byInstallment ? `à vista ${brl(item.price)} (-${percent})` : `a prazo ${brl(item.listPrice)} (-${percent} à vista)`));
      }
      prices.append(externalLink('store-link', 'ver na loja', item.url));
      const { image } = games.get(item.gameId) ?? {};
      if (image) row.append(renderPhoto(image));
      row.append(renderGame(item), prices);
      block.append(row);
    }
    if (plan.carts.length > 1 && cart.items.length > 1) block.append(renderCartSubtotal(cart));
    if (cart.couponSavings > 0) block.append(renderCouponLine(cart));
    if (cart.quote.preOrder) block.append(element('div', 'pre-order', 'Pré-venda, segundo a loja'));
    card.append(block);
  }

  if (canBuy) {
    const button = element('button', 'go-to-store', plan.carts.length === 1 ? 'Ir para a loja' : `Ir para as ${plan.carts.length} lojas`);
    button.type = 'button';
    button.addEventListener('click', () => goToStores(plan, blocks, button));
    card.append(button);
  }
  return card;
}

// Tenta cada imagem na ordem e, se nenhuma abrir, usa a inicial do nome da loja.
function renderLogo(name, logos) {
  const initial = element('span', 'store-initial', name.charAt(0).toUpperCase());
  const sources = [...new Set(logos)];
  if (sources.length === 0) return initial;

  const image = element('img', 'store-logo');
  image.alt = '';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => {
    if (sources.length > 0) image.src = sources.shift();
    else image.replaceWith(initial);
  });
  image.src = sources.shift();
  return image;
}

function renderStoreName(name, logo) {
  const row = element('div', 'cart-store store-name');
  row.append(renderLogo(name, logo), element('span', '', name));
  return row;
}

function describeDiscounts(plan) {
  const { cash, coupon, combined } = summarizeDiscounts(plan, paymentMode());
  const parts = [];
  if (cash > 0) parts.push(`Desconto à vista: ${formatPercent(cash)}`);
  if (coupon > 0) parts.push(`Cupom: ${formatPercent(coupon)}`);
  if (cash > 0 && coupon > 0 && paymentMode() === 'cash') parts.push(`Total: ${formatPercent(combined)}`);
  return parts.join(' · ');
}

function renderCartSubtotal(cart) {
  const cash = `${brl(cart.cashSubtotal)} à vista`;
  const installment = `${brl(cart.installmentSubtotal)} a prazo`;
  const text = cart.installmentSubtotal > cart.cashSubtotal ? `${cash} · ${installment}` : brl(cart.subtotal);
  return element('div', 'cart-subtotal', `Subtotal: ${text}`);
}

function renderCouponLine(cart) {
  const { code } = coupons.get(cart.storeId) ?? {};
  const percent = formatPercent(discountPercent(cart.subtotal + cart.couponSavings, cart.subtotal));
  const line = element('div', 'cart-coupon', `Cupom${code ? ` ${code}` : ''}: -${brl(cart.couponSavings)} (${percent}) nos jogos`);
  if (code) {
    const copy = element('button', 'copy-coupon', 'Copiar');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Copiado';
    });
    line.append(copy);
  }
  return line;
}

function couponNote(code, applied) {
  if (!code) return '';
  return applied ? ` Cupom ${code} aplicado.` : ` Cole o cupom ${code} na loja antes de pagar.`;
}

async function openCart(cart) {
  const { code = '' } = coupons.get(cart.storeId) ?? {};
  const key = cartKey(cart.storeId, cart.items);
  const filled = filledCarts.get(key);
  if (filled) {
    await chrome.tabs.create({ url: filled.cartUrl, active: false });
    return `Carrinho reaberto.${couponNote(code, filled.couponApplied)}`;
  }

  const result = await fillCart(cart.items, code, createBrowserSession()).catch(() => null);
  if (!result) {
    await Promise.all(cart.items.map(({ url }) => chrome.tabs.create({ url, active: false })));
    return `Abri a página dos jogos: adicione ao carrinho na loja.${couponNote(code, false)}`;
  }

  filledCarts.set(key, result);
  await chrome.tabs.create({ url: result.cartUrl, active: false });
  return `Carrinho montado.${couponNote(code, result.couponApplied)}`;
}

async function goToStores(plan, blocks, button) {
  button.disabled = true;
  for (const cart of plan.carts) {
    setStatus(`Montando o carrinho: ${cart.storeName}`);
    const note = await openCart(cart);
    const block = blocks.get(cart);
    block.querySelector('.cart-result')?.remove();
    block.append(element('div', 'cart-result', note));
  }
  setStatus('Pronto: confira os carrinhos nas abas abertas.');
  button.disabled = false;
}

function renderNotice(title, lines) {
  const notice = element('div', 'notice', title);
  const list = element('ul');
  list.append(...lines.map((line) => element('li', '', line)));
  notice.append(list);
  return notice;
}

function parseAmount(text) {
  const value = Number(text.trim().replace(/^R\$\s*/i, '').replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}

function describeCoupon({ type, value, code }) {
  const amount = type === 'percent' ? `${String(value).replace('.', ',')}%` : brl(value);
  return `${amount} nos jogos${code ? ` (${code})` : ''}`;
}

function renderCoupons() {
  const stores = new Map(lastSearch.catalogs.flatMap(({ offers }) => offers).map((offer) => [offer.storeId, offer]));
  const selected = elements['coupon-store'].value;
  const trigger = element('button');
  trigger.append(document.createElement('selectedcontent'));
  elements['coupon-store'].replaceChildren(trigger, ...[...stores.values()]
    .sort((a, b) => a.storeName.localeCompare(b.storeName))
    .map(({ storeId, storeName, storeLogo }) => {
      const option = element('option');
      option.value = storeId;
      option.append(renderLogo(storeName, storeLogo), element('span', '', storeName));
      return option;
    }));
  if (stores.has(selected)) elements['coupon-store'].value = selected;

  elements['coupon-list'].replaceChildren(...[...coupons].map(([storeId, coupon]) => {
    const row = element('li');
    const remove = element('button', '', '×');
    remove.type = 'button';
    remove.title = `Remover cupom de ${coupon.storeName}`;
    remove.addEventListener('click', () => {
      coupons.delete(storeId);
      recalculate();
    });
    row.append(element('span', '', `${coupon.storeName}: ${describeCoupon(coupon)}`), remove);
    return row;
  }));
  elements.coupons.hidden = false;
  if (coupons.size > 0) elements.coupons.open = true;
}

function addCoupon(event) {
  event.preventDefault();
  const type = elements['coupon-type'].value;
  const value = parseAmount(elements['coupon-value'].value);
  if (!value || (type === 'percent' && value > 100)) {
    setStatus(type === 'percent' ? 'Informe um percentual entre 0 e 100.' : 'Informe um valor de cupom válido.', true);
    return;
  }

  const select = elements['coupon-store'];
  const code = elements['coupon-code'].value.trim();
  coupons.set(select.value, { type, value, code, storeName: select.selectedOptions[0].textContent });
  elements['coupon-value'].value = '';
  elements['coupon-code'].value = '';
  recalculate();
}

function renderManualCart(cart) {
  const row = element('div', 'manual-cart');
  row.dataset.key = cartKey(cart.storeId, cart.items);

  const links = element('div', 'manual-items');
  links.append(...cart.items.map((item) => renderGame(item, item.url)));

  const input = element('input');
  input.inputMode = 'decimal';
  input.placeholder = 'R$ 0,00';
  input.setAttribute('aria-label', `Frete de ${cart.storeName}`);

  const limit = cart.maxFreightToWin === null ? 'Informe para comparar' : `Vence se o frete for até ${brl(cart.maxFreightToWin)}`;
  row.append(
    renderStoreName(`${cart.storeName} · ${brl(cart.subtotal)} em jogos`, cart.storeLogo),
    links,
    element('div', 'cart-freight', limit),
    input,
  );
  return row;
}

function renderManualForm(carts) {
  const form = element('form', 'manual');
  const button = element('button', '', 'Recalcular com estes fretes');
  button.type = 'submit';
  form.append(
    element('h2', '', 'Informe o frete destas lojas'),
    element('p', 'hint', 'Não foi possível cotar automaticamente. Veja o frete no site da loja, com o seu CEP, e digite aqui.'),
    ...carts.map(renderManualCart),
    button,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const entries = [...form.querySelectorAll('.manual-cart')]
      .map((row) => [row.dataset.key, parseAmount(row.querySelector('input').value)])
      .filter(([, value]) => value !== null);
    if (entries.length === 0) {
      setStatus('Digite ao menos um valor de frete válido.', true);
      return;
    }
    for (const [key, value] of entries) manualFreight.set(key, value);
    recalculate();
  });
  return form;
}

function renderResult(result) {
  const nodes = result.plans.map((plan, index) => renderPlan(plan, index === 0));

  if (result.plans.length === 0 && result.unquotedCarts.length === 0) {
    nodes.push(renderNotice('Nenhuma combinação pôde ser cotada.', []));
  }
  if (result.unquotedCarts.length > 0) nodes.unshift(renderManualForm(result.unquotedCarts));
  if (result.missingGames.length > 0) {
    nodes.push(renderNotice('Sem oferta nova disponível:', result.missingGames.map(gameName)));
  }
  if (!result.proven) {
    nodes.push(renderNotice('O limite de cotações foi atingido; pode existir combinação mais barata.', []));
  }
  elements.results.replaceChildren(...nodes);
  elements['end-title'].hidden = nodes.length === 0;
}

async function run(event) {
  event.preventDefault();
  const zipCode = elements['zip-code'].value.replace(/\D/g, '');
  if (zipCode.length !== 8) {
    setStatus('Informe um CEP com 8 dígitos.', true);
    return;
  }
  if (games.size === 0) {
    setStatus('Adicione pelo menos um jogo.', true);
    return;
  }

  await chrome.storage.local.set({ zipCode });
  setSearching(true);
  collapseSetup(zipCode);
  elements.results.replaceChildren(renderSkeleton());
  elements['end-title'].hidden = false;
  quoteCache.clear();
  manualFreight.clear();
  filledCarts.clear();

  const { signal } = searchAbort;
  const cancellableFetch = (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, signal]) });

  try {
    setStatus('Buscando ofertas...');
    const catalogs = await Promise.all([...games.keys()].map(async (slug) => {
      const catalog = await fetchCatalog(slug, cancellableFetch);
      return { ...catalog, offers: await applyStoreDiscounts(catalog.offers, cancellableFetch) };
    }));
    for (const { slug, name, image } of catalogs) addGame(slug, { name, image });

    const icons = await refreshStoreIcons(catalogs.flatMap(({ offers }) => offers), cancellableFetch);
    for (const catalog of catalogs) {
      catalog.offers = catalog.offers.map((offer) => ({
        ...offer,
        storeLogo: [icons[offer.storeId], offer.storeLogo].filter(Boolean),
      }));
    }

    // O histórico só enriquece o resultado: sem ele, a busca segue normalmente.
    const history = new Map(await Promise.all(catalogs.map(async ({ slug }) => (
      [slug, await fetchPriceHistory(slug, cancellableFetch).catch(() => [])]
    ))));
    signal.throwIfAborted();

    lastSearch = { zipCode, catalogs, history };
    await optimize(renderPartialResult);
  } catch (error) {
    elements.results.replaceChildren();
    elements['end-title'].hidden = true;
    elements.setup.open = true;
    if (signal.aborted) setStatus('Busca cancelada.');
    else setStatus(error.message, true);
  } finally {
    setSearching(false);
  }
}

// Recolhe a configuração para dar espaço aos resultados; o título reabre e mostra o resumo.
function collapseSetup(zipCode) {
  const count = games.size === 1 ? '1 jogo' : `${games.size} jogos`;
  elements['setup-info'].textContent = `${count} · CEP ${maskZipCode(zipCode)}`;
  elements.setup.classList.add('collapsible');
  elements.setup.querySelector('summary').tabIndex = 0;
  elements.setup.open = false;
}

function isDarkMode() {
  const chosen = document.documentElement.dataset.color;
  return chosen ? chosen === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyColorMode(mode) {
  if (mode) document.documentElement.dataset.color = mode;
  const dark = isDarkMode();
  const label = dark ? 'Ativar modo claro' : 'Ativar modo escuro';
  elements['color-toggle'].title = label;
  elements['color-toggle'].setAttribute('aria-label', label);
  elements['icon-sun'].hidden = !dark;
  elements['icon-moon'].hidden = dark;
}

function setSearching(searching) {
  elements.run.disabled = searching;
  elements.cancel.hidden = !searching;
  elements['run-label'].textContent = searching ? 'Pesquisando...' : RUN_LABEL;
  searchAbort = searching ? new AbortController() : null;
  showTurnDice(searching ? 1 : 0);
}

// Em buscas muito longas, mostra só os últimos dados para caber no botão.
function showTurnDice(turn) {
  elements['turn-dice'].replaceChildren(...diceFaces(turn).slice(-MAX_VISIBLE_DICE).map(renderDie));
}

async function refreshStoreIcons(offers, fetchImpl) {
  const { storeIcons = {} } = await chrome.storage.local.get('storeIcons');
  const icons = await loadStoreIcons(offers, storeIcons, fetchImpl);
  await chrome.storage.local.set({ storeIcons: icons });
  return icons;
}

// Cupom, frete digitado e troca de modo também podem cotar carrinhos novos.
async function recalculate() {
  setSearching(true);
  try {
    await optimize();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setSearching(false);
  }
}

// Só a busca nova mostra parciais: ao recalcular, o resultado atual fica até o novo chegar.
async function optimize(onProgress = null) {
  const { zipCode, catalogs } = lastSearch;
  const { signal } = searchAbort;
  let quoted = 0;
  const quoteFreight = createPanelQuoter(zipCode, signal, (storeName) => {
    quoted += 1;
    setStatus(`Loja ${quoted}: cotando frete em ${storeName}`);
    showTurnDice(quoted);
  });

  const result = await findCheapestCarts({
    games: catalogs.map(({ slug }) => slug),
    offers: catalogs.flatMap(({ offers }) => offers),
    quoteFreight,
    coupons: Object.fromEntries(coupons),
    paymentMode: paymentMode(),
    onProgress,
    signal,
  });

  renderCoupons();
  if (result.cancelled) {
    renderCancelledResult(result.plans);
    setStatus(result.plans.length > 0 ? 'Busca cancelada. Estes são os melhores resultados até aqui.' : 'Busca cancelada.');
    return;
  }
  renderResult(result);
  setStatus(quoted === 0 ? 'Recalculado.' : `${quoted} cotações feitas.`);
}

// Trocar o modo só reordena: as cotações já feitas valem para os dois.
async function changePaymentMode() {
  await chrome.storage.local.set({ paymentMode: paymentMode() });
  if (lastSearch && !elements.run.disabled) await recalculate();
}

async function start() {
  await restoreInterruptedQuotes();
  const { zipCode, paymentMode: savedMode, colorMode } = await chrome.storage.local.get(['zipCode', 'paymentMode', 'colorMode']);
  applyColorMode(colorMode);
  elements['color-toggle'].addEventListener('click', () => {
    const mode = isDarkMode() ? 'light' : 'dark';
    applyColorMode(mode);
    chrome.storage.local.set({ colorMode: mode });
  });
  elements.setup.querySelector('summary').addEventListener('click', (event) => {
    if (!elements.setup.classList.contains('collapsible')) event.preventDefault();
  });
  if (zipCode) elements['zip-code'].value = maskZipCode(zipCode);
  if (savedMode) document.querySelector(`input[name="payment-mode"][value="${savedMode}"]`).checked = true;
  renderGames();
  await loadOpenTabs();

  document.querySelectorAll('input[name="payment-mode"]').forEach((radio) => radio.addEventListener('change', changePaymentMode));
  elements['zip-code'].addEventListener('input', () => {
    elements['zip-code'].value = maskZipCode(elements['zip-code'].value);
  });
  elements['refresh-tabs'].addEventListener('click', refreshFromTabs);
  elements.cancel.addEventListener('click', () => {
    setStatus('Cancelando...');
    searchAbort?.abort();
  });
  elements['coupon-form'].addEventListener('submit', addCoupon);
  elements['game-input'].addEventListener('input', handleGameInput);
  elements['search-form'].addEventListener('submit', run);
}

start();
