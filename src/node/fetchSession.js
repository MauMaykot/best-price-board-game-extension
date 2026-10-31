// Sessão HTTP com cookies próprios, para rodar pelo terminal.
// Na extensão, o Chrome é quem guarda os cookies, então esta sessão não se aplica lá.

const MAX_REDIRECTS = 6;
const TIMEOUT_MS = 20000;
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' };

export function createFetchSession() {
  const cookies = new Map();

  const storeCookies = (response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  };

  const request = async (url, init = {}) => {
    let current = url;
    let currentInit = init;
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const response = await fetch(current, {
        ...currentInit,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          ...currentInit.headers,
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        },
      });
      storeCookies(response);

      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) {
        return { url: current, status: response.status, text: await response.text() };
      }
      current = new URL(location, current).href;
      currentInit = {};
    }
    throw new Error(`Redirecionamentos demais em ${url}.`);
  };

  return {
    get: (url) => request(url),
    post: (url, body, headers = FORM_HEADERS) => request(url, { method: 'POST', headers, body }),
  };
}
