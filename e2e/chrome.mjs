// Teste do painel no Chrome real, sem internet: toda requisição é respondida por fakeWeb.mjs,
// e qualquer endereço fora da lista reprova o teste. Uso: npm run test:chrome

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeWeb } from './fakeWeb.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOTS;
const SHIPPING_DELAY_MS = 150;

const web = createFakeWeb();
const profile = mkdtempSync(join(tmpdir(), 'bp-chrome-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let nextId = 1;
let buffer = '';
const pending = new Map();

const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
  const id = nextId;
  nextId += 1;
  pending.set(id, { done, fail });
  chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
});

async function answer({ requestId, request }, sessionId) {
  if (request.url.startsWith('chrome-extension:') || request.url.startsWith('data:')) {
    await send('Fetch.continueRequest', { requestId }, sessionId);
    return;
  }

  const reply = web.handle(request);
  if (request.url.includes('/api/shipping') || request.url.endsWith('/frete/')) {
    await new Promise((done) => { setTimeout(done, SHIPPING_DELAY_MS); });
  }
  if (reply.fail) {
    await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sessionId);
    return;
  }

  const headers = reply.location
    ? [{ name: 'Location', value: reply.location }]
    : [{ name: 'Content-Type', value: reply.type }];
  await send('Fetch.fulfillRequest', {
    requestId,
    responseCode: reply.status,
    responseHeaders: headers,
    body: reply.image ? web.image : Buffer.from(reply.body ?? '').toString('base64'),
  }, sessionId);
}

chrome.stdio[4].setEncoding('utf8');
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\0'); end !== -1; end = buffer.indexOf('\0')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);

    if (message.method === 'Fetch.requestPaused') answer(message.params, message.sessionId).catch(() => {});
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.fail(new Error(JSON.stringify(message.error)));
      else waiter.done(message.result);
    }
  }
});

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function open(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  return sessionId;
}

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
}

async function main() {
  await sleep(800);
  const { id } = await send('Extensions.loadUnpacked', { path: PROJECT });

  await open('https://www.comparajogos.com.br/item/alfa');
  await sleep(300);
  const panel = await open(`chrome-extension://${id}/panel/panel.html`);
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 1000, deviceScaleFactor: 1, mobile: false }, panel);
  // Fixa o tema do sistema, para o resultado não depender da máquina.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, panel);

  const page = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, panel);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await page(expression)) return;
      await sleep(40);
    }
    throw new Error(`Tempo esgotado: ${expression}`);
  };
  const text = (selector) => page(`document.querySelector('${selector}')?.innerText ?? ''`);
  const type = (selector, value) => page(`(()=>{const i=document.querySelector('${selector}'); i.value='${value}'; i.dispatchEvent(new Event('input'));})()`);
  const shot = async (name) => {
    if (!SCREENSHOT_DIR) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, panel);
    writeFileSync(join(SCREENSHOT_DIR, name), Buffer.from(data, 'base64'));
  };
  const finished = () => until(`!document.getElementById('run').disabled`);

  // Configuração
  await until(`document.querySelector('#games')?.innerText.includes('Jogo Alfa')`);
  check('aba aberta entra com o nome oficial', true);
  check('jogo aparece com foto', await page(`document.querySelector('#games .game-photo')?.naturalWidth > 0`));
  const toggle = await page(`(()=>{const t=document.getElementById('color-toggle').getBoundingClientRect(), h=document.querySelector('header').getBoundingClientRect(); return {gap:Math.round(h.right-t.right), moon:!document.getElementById('icon-moon').hidden, sun:!document.getElementById('icon-sun').hidden, text:document.getElementById('color-toggle').innerText.trim()};})()`);
  check('botão de lua à direita, sem texto', toggle.gap === 0 && toggle.moon && !toggle.sun && toggle.text === '', JSON.stringify(toggle));
  check('nome novo no título', (await text('h1')) === 'Melhor compra', await text('h1'));
  check('nome do jogo leva ao Compara Jogos', (await page(`document.querySelector('#games .game-link').href`)) === 'https://www.comparajogos.com.br/item/alfa');
  check('sem seletor de temas', !(await page(`!!document.querySelector('#theme-picker')`)));
  const byline = await page(`(()=>{const a=document.querySelector('.byline a'); return {text:document.querySelector('.byline').innerText.trim(), href:a.href, h1:getComputedStyle(document.querySelector('h1')).fontSize};})()`);
  check('assinatura com link do GitHub', byline.text === '- Por Maurício Maykot' && byline.href === 'https://github.com/MauMaykot' && byline.h1 === '24px', JSON.stringify(byline));
  check('títulos dos passos', (await page(`[...document.querySelectorAll('#search-form .step-title')].map(n=>n.innerText.trim()).join('|')`)) === '1. Configuração|2. Pesquisa');

  await type('#zip-code', '01310100');
  check('CEP formatado', (await page(`document.getElementById('zip-code').value`)) === '01310-100');

  await type('#game-input', 'beta');
  await until(`document.querySelectorAll('#suggestions button').length > 0`);
  await page(`document.querySelector('#suggestions button').click()`);
  check('busca por nome adiciona o jogo', (await text('#games')).includes('Jogo Beta'));

  // Busca com cookie do usuário: a cotação não pode mexer nele
  await page(`chrome.cookies.set({url:'https://loja-nuvem.test/', name:'meu_carrinho', value:'real'})`);
  await page(`(()=>{window.seen={skeleton:false, partial:false, buttons:0}; new MutationObserver(()=>{const r=document.getElementById('results'), s=r.querySelector('.skeleton'), p=r.querySelector('.plan:not(.skeleton)'); if(s) window.seen.skeleton=true; if(s&&p){window.seen.partial=true; window.seen.buttons+=r.querySelectorAll('.go-to-store').length;}}).observe(document.getElementById('results'),{childList:true});})()`);
  check('configuração aberta antes de pesquisar', await page(`document.getElementById('setup').open`));
  await page(`document.querySelector('#setup > summary').click()`);
  check('antes de pesquisar não dá para recolher', await page(`document.getElementById('setup').open`));
  check('sem seta de recolher antes de pesquisar', (await page(`getComputedStyle(document.querySelector('#setup > summary')).listStyleType`)) === 'none');
  await page(`document.getElementById('run').click()`);
  await until(`document.querySelectorAll('#run .die').length > 0`);
  check('pesquisar recolhe a configuração com resumo', !(await page(`document.getElementById('setup').open`)) && (await text('#setup-info')) === '2 jogos · CEP 01310-100', await text('#setup-info'));
  const running = await page(`(()=>{const r=document.getElementById('run'), d=r.querySelector('.die'); return {disabled:r.disabled, label:r.innerText.trim(), spin:getComputedStyle(d).animationName};})()`);
  check('botão desabilitado com dados rodando', running.disabled && running.label === 'Pesquisando...' && running.spin === 'die-spin', JSON.stringify(running));
  await until(`document.querySelector('.skeleton') && document.querySelector('.plan:not(.skeleton)')`);
  await shot('parcial.png');
  await finished();

  const seen = await page('window.seen');
  check('resultado parcial aparece com skeleton', seen.skeleton && seen.partial, JSON.stringify(seen));
  check('parcial não tem botão de compra', seen.buttons === 0);
  check('skeleton e dados somem no fim', (await page(`document.querySelectorAll('.skeleton, #run .die').length`)) === 0);

  // Resultado à vista
  const result = await text('#results');
  await shot('resultado.png');
  check('vencedor à vista com frete grátis combinado', (await text('.plan-label')) === 'VENCEDOR: LOJA NUVEM' && /310,00 à vista/.test(await text('.plan-total')), result.slice(0, 200));
  check('mostra a prazo e o percentual', /340,00 a prazo/.test(result) && /Desconto à vista: 8,8%/.test(result), result.slice(0, 240));
  check('indicador do histórico', (await page(`document.querySelectorAll('.price-note').length`)) > 0);
  check('cookie do usuário preservado', (await page(`chrome.cookies.get({url:'https://loja-nuvem.test/', name:'meu_carrinho'}).then(c=>c?.value)`)) === 'real');
  check('nenhuma cópia de cookies sobrando', (await page(`chrome.storage.session.get('cookieSnapshots').then(s=>Object.keys(s.cookieSnapshots??{}).length)`)) === 0);

  const links = await page(`({game:document.querySelector('.plan .game-name').href, store:document.querySelector('.plan .store-link').href, manual:document.querySelector('.manual .game-name').href})`);
  check('resultado leva ao Compara Jogos e à loja', links.game.startsWith('https://www.comparajogos.com.br/item/') && links.store.startsWith('https://loja-nuvem.test/'), JSON.stringify(links));
  check('frete manual leva à loja', !links.manual.includes('comparajogos'), links.manual);

  // Hover e modo escuro
  const box = await page(`(()=>{const r=document.querySelector('.go-to-store'); r.scrollIntoView({block:'center'}); const b=r.getBoundingClientRect(); return {x:b.x+b.width/2, y:b.y+b.height/2, color:getComputedStyle(r).backgroundColor};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, panel);
  await sleep(250);
  const hovered = await page(`getComputedStyle(document.querySelector('.go-to-store')).backgroundColor`);
  check('botão muda no hover', hovered !== box.color, `${box.color} -> ${hovered}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, panel);
  const light = await page(`getComputedStyle(document.body).backgroundColor`);
  await page(`document.getElementById('color-toggle').click()`);
  await sleep(100);
  const dark = await page(`({bg:getComputedStyle(document.body).backgroundColor, moonHidden:document.getElementById('icon-moon').hidden, sunHidden:document.getElementById('icon-sun').hidden, saved:await chrome.storage.local.get('colorMode').then(s=>s.colorMode)})`.replace('({bg', '(async()=>({bg').replace('colorMode)})', 'colorMode)}))()'));
  check('modo escuro muda o fundo e fica salvo', dark.bg !== light && dark.moonHidden && !dark.sunHidden && dark.saved === 'dark', JSON.stringify(dark));
  await shot('escuro.png');
  await page(`document.getElementById('color-toggle').click()`);

  // Loja fora do ar e Amazon não derrubam a busca
  const manual = await text('.manual');
  check('loja fora do ar pede o frete', manual.includes('Loja Fora do Ar'), manual);
  check('Amazon pede o frete', manual.includes('Amazon'), manual);
  check('Amazon não recebe requisição', !web.requests.some((request) => request.includes('amazon')));

  // Carrinho
  await page(`document.querySelector('.go-to-store').click()`);
  await until(`document.querySelector('.cart-result')`);
  check('botão monta o carrinho da loja', web.carts.nuvem.join() === '222,111' || web.carts.nuvem.join() === '111,222', web.carts.nuvem.join());
  const cartCount = web.carts.nuvem.length;
  await page(`document.querySelector('.go-to-store').click()`);
  await until(`document.querySelector('.cart-result')?.innerText.includes('reaberto')`);
  check('segundo clique não duplica', web.carts.nuvem.length === cartCount);
  web.carts.nuvem = [];

  // A prazo
  await page(`document.querySelector('input[name="payment-mode"][value="installment"]').click()`);
  await until(`document.querySelector('.plan-total').innerText.includes('a prazo')`);
  await finished();
  await sleep(250);
  check('opção selecionada na cor primária', (await page(`getComputedStyle(document.querySelector('#payment-mode label:has(input:checked)')).backgroundColor`)) === 'rgb(31, 95, 191)');
  check('modo a prazo troca o vencedor', (await text('.plan-label')) === 'VENCEDOR: LOJA TRAY' && /335,00 a prazo/.test(await text('.plan-total')), await text('.plan-label'));
  check('possível pré-venda fica sinalizada', (await text('.plan.best')).includes('Pode ser pré-venda'), await text('.plan.best'));
  await page(`document.querySelector('input[name="payment-mode"][value="cash"]').click()`);
  await until(`document.querySelector('.plan-total').innerText.includes('à vista')`);
  await finished();

  // Frete digitado
  const requestsBefore = web.requests.length;
  await page(`(()=>{const r=[...document.querySelectorAll('.manual-cart')].find(c=>c.innerText.includes('Fora do Ar')); r.querySelector('input').value='5,00'; r.closest('form').requestSubmit();})()`);
  await until(`document.getElementById('status').innerText === 'Recalculado.' || document.querySelector('.plan-label')?.innerText.includes('FORA DO AR')`);
  await finished();
  check('frete digitado entra na conta', /informado por você/.test(await text('#results')));
  check('frete digitado não repete cotações', web.requests.length - requestsBefore < 6, String(web.requests.length - requestsBefore));

  // Cupom
  await page(`(()=>{document.getElementById('coupon-store').value='nuvem'; document.getElementById('coupon-type').value='percent'; document.getElementById('coupon-value').value='50'; document.getElementById('coupon-code').value='METADE'; document.getElementById('coupon-form').requestSubmit();})()`);
  await until(`document.getElementById('results').innerText.includes('METADE')`);
  await finished();
  const withCoupon = await text('#results');
  check('cupom vale só para os jogos', /Cupom METADE/.test(withCoupon) && /155,00 à vista/.test(withCoupon), withCoupon.slice(0, 240));
  await page(`document.querySelector('#coupon-list button').click()`);
  await until(`document.querySelectorAll('#coupon-list li').length === 0`);
  await finished();

  // O título reabre a configuração recolhida
  await page(`document.querySelector('#setup > summary').click()`);
  check('título reabre a configuração', await page(`document.getElementById('setup').open`));
  check('seta de recolher aparece depois de pesquisar', (await page(`getComputedStyle(document.querySelector('#setup > summary')).listStyleType`)) !== 'none');
  check('recolher não mexe na opacidade', !(await page(`getComputedStyle(document.getElementById('setup'), '::details-content').transitionProperty`)).includes('opacity'));
  const heights = await page(`(async()=>{const s=document.getElementById('setup'), h=()=>Math.round(s.getBoundingClientRect().height), seen=[]; await new Promise(r=>setTimeout(r,350)); seen.push(h()); s.open=false; for(let i=0;i<6;i+=1){await new Promise(r=>requestAnimationFrame(r)); seen.push(h());} await new Promise(r=>setTimeout(r,350)); seen.push(h()); return seen;})()`);
  check('configuração recolhe de forma gradual', new Set(heights).size > 3 && heights.at(-1) < heights[0], heights.join(' '));

  // Cancelar no meio das cotações
  web.carts = { tray: [], nuvem: [] };
  await page(`document.getElementById('run').click()`);
  await until(`!document.getElementById('cancel').hidden && document.querySelector('.plan:not(.skeleton)')`);
  check('botão de cancelar aparece durante a busca', await page(`document.getElementById('run').disabled`));
  await shot('cancelar.png');
  await page(`document.getElementById('cancel').click()`);
  await finished();
  const cancelled = await page(`({status:document.getElementById('status').innerText, cancelHidden:document.getElementById('cancel').hidden, skeleton:document.querySelectorAll('.skeleton').length, dice:document.querySelectorAll('#run .die').length, plans:document.querySelectorAll('.plan').length, buttons:document.querySelectorAll('.go-to-store').length, label:document.querySelector('.plan-label')?.innerText})`);
  check('cancelar mantém o melhor até ali, com botão de loja', /cancelada/.test(cancelled.status) && cancelled.cancelHidden && cancelled.skeleton === 0 && cancelled.dice === 0 && cancelled.plans > 0 && cancelled.buttons === cancelled.plans && cancelled.label === 'MELHOR ATÉ AGORA', JSON.stringify(cancelled));
  check('cancelar restaura os cookies', (await page(`chrome.cookies.get({url:'https://loja-nuvem.test/', name:'meu_carrinho'}).then(c=>c?.value)`)) === 'real');
  await until(`chrome.storage.session.get('cookieSnapshots').then(s=>Object.keys(s.cookieSnapshots??{}).length===0)`);
  check('cancelar não deixa cópia de cookies', true);

  // Cancelar logo no início, antes de haver resultado
  web.carts = { tray: [], nuvem: [] };
  await page(`document.getElementById('run').click()`);
  await until(`!document.getElementById('cancel').hidden`);
  await page(`document.getElementById('cancel').click()`);
  await finished();
  check('cancelar no início também encerra a busca', /cancelada/.test(await text('#status')) && (await page(`document.querySelectorAll('.skeleton').length`)) === 0, await text('#status'));

  // A busca seguinte funciona normalmente
  web.carts = { tray: [], nuvem: [] };
  await page(`document.getElementById('run').click()`);
  await sleep(100);
  await finished();
  check('busca depois de cancelar volta ao normal', /cotações feitas/.test(await text('#status')) && (await text('.plan-label')) === 'VENCEDOR: LOJA NUVEM', `${await text('#status')} | ${await text('.plan-label')}`);

  // Compara Jogos fora do ar
  web.comparaDown = true;
  await page(`document.getElementById('run').click()`);
  await until(`document.querySelector('#status.error')`);
  await finished();
  const failure = await text('#status');
  check('Compara Jogos fora do ar mostra erro', failure.length > 0, failure);
  check('erro não deixa skeleton preso', (await page(`document.querySelectorAll('.skeleton').length`)) === 0);
  check('botão volta depois do erro', (await text('#run')) === 'Encontrar menor valor');
  check('erro reabre a configuração', await page(`document.getElementById('setup').open`));

  check('nenhum endereço fora da internet simulada', web.unexpected.length === 0, web.unexpected.join(' '));
}

const started = Date.now();
try {
  await main();
} catch (error) {
  results.push(false);
  console.log(`ERRO  ${error.message}`);
}
chrome.kill();
await sleep(500);
try {
  rmSync(profile, { recursive: true, force: true });
} catch { /* o Chrome pode segurar o perfil por um instante; a pasta é temporária */ }

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} verificações em ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(passed === results.length ? 0 : 1);
