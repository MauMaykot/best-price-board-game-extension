import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/pira.js';

const page = (canonical) => `<!doctype html><html lang="pt-BR"><head>
  <meta property="og:site_name" content="Pira no Board Game" />
  <script type="module" crossorigin src="/assets/index-CMZj2adc.js"></script>
  <link rel="canonical" href="${canonical}" /></head>
  <body><script id="manus-runtime">window.__MANUS_HOST_DEV__ = false;</script><div id="root"></div></body></html>`;

const option = (service, price, extra = {}) => ({ service, serviceCode: '04510', price, deliveryDays: 10, error: null, ...extra });

test('lê o slug do link canonical da página do produto', () => {
  assert.deepEqual(parseProduct(page('https://piranoboardgame.com.br/jogo/compile-main-1')), { slug: 'compile-main-1' });
  assert.deepEqual(parseProduct(page('https://piranoboardgame.com.br/jogo/compile-main-1/')), { slug: 'compile-main-1' });
});

test('rejeita outras plataformas e páginas que não são de produto', () => {
  assert.equal(parseProduct(page('https://piranoboardgame.com.br/shop')), null);
  assert.equal(parseProduct(page('https://outraloja.com.br/jogo/compile-main-1')), null);
  assert.equal(parseProduct(page('https://ludostation.com.br/produtos/ruins-1sei4/')), null);
  assert.equal(parseProduct('<form id="product_form"><input name="add_to_cart" value="222" /></form>'), null);
  assert.equal(parseProduct('<a href="/loja/cartService.php?loja=123&acao=incluir&IdProd=45">Comprar</a>'), null);
  assert.equal(parseProduct('<html>outra plataforma</html>'), null);
});

test('escolhe a entrega mais barata com prazo', () => {
  const delivery = cheapestDelivery({ options: [option('PAC', 32.18), option('SEDEX', 39.78), option('Jadlog', 22.48, { deliveryDays: 5 })] });
  assert.deepEqual(delivery, { cost: 22.48, service: 'Jadlog', maxDays: 5 });
});

test('aceita frete grátis real', () => {
  const delivery = cheapestDelivery({
    options: [option('Frete grátis', 0, { serviceCode: 'FREE_SHIPPING' })],
    freeShippingEligible: true,
  });
  assert.equal(delivery.cost, 0);
  assert.equal(delivery.service, 'Frete grátis');
});

test('opções com valor zero que não são entrega ficam de fora', () => {
  const delivery = cheapestDelivery({
    options: [
      option('Entrega em mãos', 0, { serviceCode: 'PERSONAL', localDelivery: { kind: 'hand_delivery' } }),
      option('Retirada em evento', 0, { serviceCode: 'EVENT', localDelivery: { kind: 'event_pickup' } }),
      option('Retirada na loja', 0),
      option('Entrega a combinar', 0),
      option('SEDEX', 39.78),
    ],
  });
  assert.equal(delivery.service, 'SEDEX');
});

test('opção com erro da transportadora não vale, mesmo com valor', () => {
  const delivery = cheapestDelivery({ options: [option('Jadlog', 0, { error: 'Sem cobertura' }), option('PAC', -1), option('SEDEX', 39.78)] });
  assert.equal(delivery.service, 'SEDEX');
});

test('sem entrega válida devolve nulo', () => {
  assert.equal(cheapestDelivery({ options: [option('Entrega em mãos', 0, { serviceCode: 'PERSONAL' })] }), null);
  assert.equal(cheapestDelivery({ options: [] }), null);
  assert.equal(cheapestDelivery(null), null);
});

const product = (id, slug, extra = {}) => ({
  id,
  slug,
  price: '168.00',
  pricePix: '157.00',
  weight: 300,
  width: null,
  height: null,
  length: null,
  boxWidth: 10,
  boxHeight: 10,
  boxLength: 14,
  stock: 5,
  active: true,
  status: 'published',
  availabilityType: 'in_stock',
  ...extra,
});

const ok = (json) => ({ status: 200, text: JSON.stringify({ result: { data: { json } } }) });

const fakeSession = (catalog, shipping = { status: 200, json: { options: [option('Jadlog', 23.01)] } }) => {
  const posts = [];
  return {
    posts,
    async get(url) {
      const { searchParams, pathname } = new URL(url);
      assert.equal(pathname, '/api/trpc/products.getBySlug');
      return ok(catalog[JSON.parse(searchParams.get('input')).json.slug] ?? null);
    },
    async post(url, body, headers) {
      posts.push({ path: new URL(url).pathname, input: JSON.parse(body).json, headers });
      return shipping.status === 200 ? ok(shipping.json) : { status: shipping.status, text: shipping.text };
    },
  };
};

const CATALOG = {
  compile: product(4200002, 'compile'),
  'sleepy-cats': product(750080, 'sleepy-cats', { price: '29.90', weight: 100, boxWidth: null, width: 8, height: 8, length: 3 }),
};

test('cota os dois itens juntos, com peso, medidas e preço reais', async () => {
  const session = fakeSession(CATALOG);
  const quote = await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }, { slug: 'sleepy-cats' }], '01310-100', session);
  assert.deepEqual(quote, { cost: 23.01, service: 'Jadlog', maxDays: 10, preOrder: false });
  assert.equal(session.posts.length, 1);
  assert.equal(session.posts[0].path, '/api/trpc/shipping.calculate');
  assert.deepEqual(session.posts[0].headers, { 'content-type': 'application/json' });
  assert.deepEqual(session.posts[0].input, {
    cep: '01310100',
    items: [
      { productId: 4200002, quantity: 1, weight: 300, width: 10, height: 10, length: 14, price: 168 },
      { productId: 750080, quantity: 1, weight: 100, width: 8, height: 8, length: 3, price: 29.9 },
    ],
  });
});

test('item esgotado invalida a cotação sem chegar a cotar', async () => {
  const session = fakeSession({ ...CATALOG, 'sleepy-cats': { ...CATALOG['sleepy-cats'], stock: 0 } });
  const quote = await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }, { slug: 'sleepy-cats' }], '01310100', session);
  assert.equal(quote, null);
  assert.equal(session.posts.length, 0);
});

test('produto inexistente ou fora de venda invalida a cotação', async () => {
  const hidden = fakeSession({ ...CATALOG, compile: { ...CATALOG.compile, active: false } });
  assert.equal(await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }], '01310100', hidden), null);
  const missing = fakeSession(CATALOG);
  assert.equal(await quoteCart('https://piranoboardgame.com.br', [{ slug: 'nao-existe' }], '01310100', missing), null);
  assert.equal(hidden.posts.length + missing.posts.length, 0);
});

test('pré-venda é cotada e sinalizada, mesmo junto de item em estoque', async () => {
  const session = fakeSession({ ...CATALOG, compile: { ...CATALOG.compile, stock: 5, availabilityType: 'pre_order' } });
  const quote = await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }, { slug: 'sleepy-cats' }], '01310100', session);
  assert.equal(quote.cost, 23.01);
  assert.equal(quote.preOrder, true);
});

test('sob encomenda fica fora sem cotar', async () => {
  const session = fakeSession({ compile: { ...CATALOG.compile, stock: 5, availabilityType: 'on_demand' } });
  const quote = await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }], '01310100', session);
  assert.deepEqual(quote, { unavailable: 'encomenda' });
  assert.equal(session.posts.length, 0);
});

test('produto sem peso ou medidas não dá cotação confiável', async () => {
  const session = fakeSession({ compile: { ...CATALOG.compile, boxLength: null } });
  assert.equal(await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }], '01310100', session), null);
  assert.equal(session.posts.length, 0);
});

test('erro da API, como CEP inválido, devolve nulo', async () => {
  const session = fakeSession(CATALOG, { status: 400, text: '{"error":{"json":{"message":"CEP inválido"}}}' });
  assert.equal(await quoteCart('https://piranoboardgame.com.br', [{ slug: 'compile' }], '00000000', session), null);
});
