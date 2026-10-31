import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  cookieDomain,
  createBrowserSession,
  restoreInterruptedQuotes,
  withIsolatedCookies,
} from '../src/extension/isolatedSession.js';

const cookie = (name, value, extra = {}) => ({
  name,
  value,
  domain: 'www.loja.com',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'lax',
  storeId: '0',
  ...extra,
});

let jar;
let session;

beforeEach(() => {
  jar = [];
  session = {};
  globalThis.chrome = {
    cookies: {
      getAll: async () => [...jar],
      remove: async ({ name }) => { jar = jar.filter((item) => item.name !== name); },
      set: async (details) => {
        jar.push({ ...cookie(details.name, details.value), hostOnly: !details.domain, domain: details.domain ?? 'www.loja.com' });
      },
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: structuredClone(session[key]) }),
        set: async (values) => { Object.assign(session, structuredClone(values)); },
      },
    },
  };
});

test('a cotação não vê os cookies do usuário e eles voltam depois', async () => {
  jar = [cookie('carrinho_real', 'meus-itens')];
  await withIsolatedCookies('loja.com', async () => {
    assert.deepEqual(jar, []);
    jar.push(cookie('carrinho_anonimo', 'cotacao'));
  });
  assert.deepEqual(jar.map((item) => [item.name, item.value]), [['carrinho_real', 'meus-itens']]);
});

test('restaura mesmo quando a cotação falha', async () => {
  jar = [cookie('carrinho_real', 'meus-itens')];
  await assert.rejects(withIsolatedCookies('loja.com', async () => { throw new Error('timeout'); }), /timeout/);
  assert.deepEqual(jar.map((item) => item.name), ['carrinho_real']);
});

test('cotações na mesma loja rodam uma por vez', async () => {
  const events = [];
  const quote = (label) => withIsolatedCookies('loja.com', async () => {
    events.push(`início ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    events.push(`fim ${label}`);
  });
  await Promise.all([quote('a'), quote('b')]);
  assert.deepEqual(events, ['início a', 'fim a', 'início b', 'fim b']);
});

test('uma falha não trava a fila da loja', async () => {
  await assert.rejects(withIsolatedCookies('loja.com', async () => { throw new Error('falhou'); }));
  assert.equal(await withIsolatedCookies('loja.com', async () => 'ok'), 'ok');
});

test('o painel fechado no meio da cotação é reparado ao abrir de novo', async () => {
  jar = [cookie('carrinho_real', 'meus-itens')];
  let release;
  withIsolatedCookies('interrompida.com', () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(jar, []);

  jar.push(cookie('carrinho_anonimo', 'cotacao'));
  await restoreInterruptedQuotes();
  assert.deepEqual(jar.map((item) => item.name), ['carrinho_real']);
  release();
});

test('sem interrupção não há o que reparar', async () => {
  jar = [cookie('carrinho_real', 'meus-itens')];
  await withIsolatedCookies('loja.com', async () => {});
  await restoreInterruptedQuotes();
  assert.deepEqual(jar.map((item) => item.name), ['carrinho_real']);
});

test('lojas cotadas ao mesmo tempo não deixam cópia de cookies para trás', async () => {
  // A loja B lê a lista com a cópia de A e só grava depois de A já ter limpado a dela.
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const { set } = chrome.storage.session;
  chrome.storage.session.set = async (values) => {
    await wait('b.com' in values.cookieSnapshots ? 30 : 1);
    await set(values);
  };

  const first = withIsolatedCookies('a.com', () => wait(8));
  await wait(4);
  const second = withIsolatedCookies('b.com', () => wait(1));
  await Promise.all([first, second]);

  assert.deepEqual(session.cookieSnapshots, {});
});

test('cancelar interrompe a requisição e restaura os cookies', async () => {
  jar = [cookie('carrinho_real', 'meus-itens')];
  const controller = new AbortController();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });

  try {
    const quote = withIsolatedCookies('cancelada.com', () => createBrowserSession(controller.signal).get('https://cancelada.com/'));
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    assert.deepEqual(jar, []);
    controller.abort();
    await assert.rejects(quote);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(jar.map((item) => item.name), ['carrinho_real']);
});

test('usa o domínio sem www', () => {
  assert.equal(cookieDomain('https://www.loja.com.br/produto'), 'loja.com.br');
  assert.equal(cookieDomain('https://loja.com.br/produto'), 'loja.com.br');
});
