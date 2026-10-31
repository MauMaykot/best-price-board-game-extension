// Cota carrinhos sem tocar no carrinho real do usuário.
//
// Dentro do Chrome, as requisições usam os cookies do navegador. Para cada cotação:
// guarda os cookies da loja, limpa, cota numa sessão anônima e restaura tudo. As lojas
// são tratadas uma cotação por vez, e uma cópia fica em storage.session para que um
// painel fechado no meio da cotação possa ser reparado ao abrir de novo.

const SNAPSHOTS_KEY = 'cookieSnapshots';
const TIMEOUT_MS = 20000;
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' };

const queues = new Map();
let snapshotWrites = Promise.resolve();

export function cookieDomain(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

export function withIsolatedCookies(domain, task) {
  const run = (queues.get(domain) ?? Promise.resolve()).then(() => isolate(domain, task));
  queues.set(domain, run.catch(() => {}));
  return run;
}

export async function restoreInterruptedQuotes() {
  const snapshots = await readSnapshots();
  for (const [domain, cookies] of Object.entries(snapshots)) await restore(domain, cookies);
}

export function createBrowserSession(cancelSignal = null) {
  const request = async (url, init = {}) => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      signal: cancelSignal ? AbortSignal.any([timeout, cancelSignal]) : timeout,
    });
    return { url: response.url, status: response.status, text: await response.text() };
  };

  return {
    get: (url) => request(url),
    post: (url, body, headers = FORM_HEADERS) => request(url, { method: 'POST', headers, body }),
  };
}

async function isolate(domain, task) {
  const saved = await chrome.cookies.getAll({ domain });
  await writeSnapshot(domain, saved);
  await removeCookies(saved);
  try {
    return await task();
  } finally {
    await restore(domain, saved);
  }
}

async function restore(domain, saved) {
  await removeCookies(await chrome.cookies.getAll({ domain }));
  await Promise.all(saved.map((cookie) => chrome.cookies.set(toSetDetails(cookie))));
  await writeSnapshot(domain, null);
}

function removeCookies(cookies) {
  return Promise.all(cookies.map((cookie) => chrome.cookies.remove({
    url: cookieUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
  })));
}

function cookieUrl(cookie) {
  const host = cookie.domain.replace(/^\./, '');
  return `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
}

function toSetDetails(cookie) {
  const { name, value, path, secure, httpOnly, sameSite, storeId, expirationDate, hostOnly, domain } = cookie;
  return {
    url: cookieUrl(cookie),
    name,
    value,
    path,
    secure,
    httpOnly,
    sameSite,
    storeId,
    ...(expirationDate === undefined ? {} : { expirationDate }),
    ...(hostOnly ? {} : { domain }),
  };
}

async function readSnapshots() {
  const stored = await chrome.storage.session.get(SNAPSHOTS_KEY);
  return stored[SNAPSHOTS_KEY] ?? {};
}

// Lojas diferentes cotam em paralelo e dividem esta lista. Uma gravação por vez evita que uma
// sobrescreva a outra e deixe para trás uma cópia, que depois restauraria cookies antigos.
function writeSnapshot(domain, cookies) {
  const write = snapshotWrites.then(async () => {
    const snapshots = await readSnapshots();
    if (cookies) snapshots[domain] = cookies;
    else delete snapshots[domain];
    await chrome.storage.session.set({ [SNAPSHOTS_KEY]: snapshots });
  });
  snapshotWrites = write.catch(() => {});
  return write;
}
