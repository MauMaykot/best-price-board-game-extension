// Internet simulada do teste no Chrome: Compara Jogos e lojas nos formatos reais, sem rede.
//
// Valores à vista: Loja Nuvem vence (R$ 310,00) porque os dois jogos juntos têm frete grátis.
// Valores a prazo: Loja Tray vence (R$ 335,00). Loja Fora do Ar sempre falha, e a Amazon é
// só manual: as duas precisam aparecer pedindo o frete, sem derrubar a busca.

const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const STORES = {
  tray: { full_name: 'Loja Tray', logo: 'https://img.test/tray.png', origin: 'https://loja-tray.test' },
  nuvem: { full_name: 'Loja Nuvem', logo: null, origin: 'https://loja-nuvem.test' },
  fora: { full_name: 'Loja Fora do Ar', logo: null, origin: 'https://loja-fora.test' },
  amazon: { full_name: 'Amazon', logo: null, origin: 'https://www.amazon.com.br' },
};

const offer = (store, slug, priceTo, priceFrom, name = slug) => ({
  type: 'LINK',
  name,
  condition: 'NEW',
  damaged: false,
  is_extra: false,
  price_from: priceFrom,
  price_to: priceTo,
  url: `${STORES[store].origin}/${slug}`,
  available: true,
  store: { name: store, full_name: STORES[store].full_name, logo: STORES[store].logo },
});

const GAMES = {
  alfa: {
    name: 'Jogo Alfa',
    thumbnail_url: 'https://img.test/alfa.png',
    prices: [
      offer('amazon', 'alfa', 70, 70),
      offer('fora', 'alfa', 80, 90),
      offer('tray', 'alfa', 100, 105),
      offer('nuvem', 'alfa', 120, 140),
    ],
  },
  beta: {
    name: 'Jogo Beta',
    thumbnail_url: 'https://img.test/beta.png',
    prices: [
      offer('nuvem', 'beta', 190, 200),
      offer('tray', 'beta', 200, 205, 'Jogo Beta (Pré-venda)'),
    ],
  },
};

const TRAY_IDS = { alfa: '9', beta: '10' };
const NUVEM_IDS = { alfa: '111', beta: '222' };
const TRAY_FREIGHT = { 1: '20.00', 2: '25.00' };
const NUVEM_FREIGHT = { 1: '15', 2: '0' };

const json = (body) => ({ status: 200, type: 'application/json', body: JSON.stringify(body) });
const html = (body) => ({ status: 200, type: 'text/html', body });

function history() {
  const today = new Date();
  return Array.from({ length: 20 }, (_, index) => {
    const date = new Date(today.getTime() - index * 86400000).toISOString().slice(0, 10);
    return { date, condition: 'NEW', price: 150, price_where: 'Loja Antiga' };
  });
}

function graphql(request) {
  const { operationName, variables } = JSON.parse(request.postData);
  const game = GAMES[variables.slug];
  if (operationName === 'searchGames') {
    return json({ data: { product: [{ slug: 'beta', name: GAMES.beta.name, type: 'game', thumbnail_url: GAMES.beta.thumbnail_url, product_price: { new_count: 2 } }] } });
  }
  if (operationName === 'gameSummary') return json({ data: { product: [{ name: game.name, thumbnail_url: game.thumbnail_url }] } });
  if (operationName === 'productHistory') return json({ data: { product_history: history() } });
  return json({ data: { product: [{ slug: variables.slug, ...game }] } });
}

export function createFakeWeb() {
  const web = {
    comparaDown: false,
    requests: [],
    unexpected: [],
    carts: { tray: [], nuvem: [] },
    handle,
    image: IMAGE,
  };

  function tray(url) {
    if (url.pathname === '/loja/cartService.php') {
      web.carts.tray.push(url.searchParams.get('IdProd'));
      return { status: 302, location: '/checkout/cart?session_id=sessao&store_id=1' };
    }
    if (url.pathname === '/checkout/cart') return html('<html>carrinho</html>');
    if (url.pathname === '/checkout/cart/api/shipping') {
      const value = TRAY_FREIGHT[web.carts.tray.length];
      web.carts.tray = [];
      return json({ data: { quotations: [{ name: 'PAC', value, pickup: '0', minPeriod: '5', maxPeriod: '7' }] } });
    }
    const slug = url.pathname.slice(1);
    return html(`<link rel="icon" href="https://img.test/tray.png"><a href="/loja/cartService.php?loja=1&amp;acao=incluir&amp;IdProd=${TRAY_IDS[slug]}">Comprar</a>`);
  }

  function nuvem(url, request) {
    if (url.pathname === '/comprar/' && request.method === 'POST') {
      web.carts.nuvem.push(request.postData.match(/add_to_cart=(\d+)/)[1]);
      return html('');
    }
    if (url.pathname === '/comprar/') return html(`<div>${web.carts.nuvem.join(' ')}</div>`);
    if (url.pathname === '/frete/') {
      const price = NUVEM_FREIGHT[web.carts.nuvem.length];
      web.carts.nuvem = [];
      const cost = price === '0' ? ' Grátis' : ` R$${price},00`;
      return json({ success: true, html: `<input class="js-shipping-method" data-price="${price}" data-name="PAC" data-cost="${cost}" />` });
    }
    const slug = url.pathname.slice(1);
    return html(`<link rel="icon" href="https://img.test/nuvem.png"><form id="product_form"><input type="hidden" name="add_to_cart" value="${NUVEM_IDS[slug]}" /></form>`);
  }

  function handle(request) {
    const url = new URL(request.url);
    web.requests.push(`${request.method} ${url.host}${url.pathname}`);

    if (url.host === 'api.comparajogos.com.br') {
      return web.comparaDown ? { fail: true } : graphql(request);
    }
    if (url.host === 'www.comparajogos.com.br') return html('<html>Compara Jogos</html>');
    if (url.host === 'img.test') return { status: 200, type: 'image/png', image: true };
    if (url.host === 'loja-tray.test') return tray(url);
    if (url.host === 'loja-nuvem.test') return nuvem(url, request);
    if (url.host === 'loja-fora.test') return { fail: true };

    web.unexpected.push(request.url);
    return { fail: true };
  }

  return web;
}
