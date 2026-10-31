import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/meca.js';

const productPage = (id, availability = 'InStock') => `
  <script>$(document).ready(function(){ productInfo.Init({"id":"${id}","sku":"TWI001","price":{"list":1499.99}}); });</script>
  <form id="product-details" name="product-details" method="post" data-element="form-product-buy">
    <div itemprop="offers" itemscope itemtype="http://schema.org/Offer" class="product-values botao_comprar">
      <link itemprop="availability" href="http://schema.org/${availability}" />
    </div>
    <a data-action="productInfo.buy" data-type="buttonAction" class="btn-buy"></a>
  </form>`;

const option = (id, title, cost, extra = {}) => ({
  id,
  title,
  cost,
  cost_label: `R$ ${cost.toFixed(2).replace('.', ',')}`,
  description: 'Prazo de entrega para esta modalidade é de <b>4</b> dias úteis.',
  error: '',
  deliveryTime: 4,
  ...extra,
});

const pickup = option('customizada', '<b>Retirada no local</b>', 0, { deliveryTime: 0 });
const combine = option('cmodulecombinacao', '<b>Combinar com Pedido Anterior (Não é um frete) </b>', 1, { deliveryTime: 9999 });
const storeDelivery = option('terrestre', '--->> <b>RECEBA HOJE!!* </b> - <u>MECA Entrega</u>', 15.9, { deliveryTime: 0 });
const sedex = option('melhorenvio_2', 'SEDEX', 26.49);

const quote = (...options) => JSON.stringify({
  status: true,
  destiny: { city: 'São Paulo', state_code: 'SP' },
  options: Object.fromEntries(options.map((item) => [item.id, item])),
});

test('lê o id e a disponibilidade na página da loja iSET', () => {
  assert.deepEqual(parseProduct(productPage('1109')), { productId: '1109', inStock: true, preOrder: false });
  assert.deepEqual(parseProduct(productPage('260', 'OutOfStock')), { productId: '260', inStock: false, preOrder: false });
});

test('pré-venda não conta como em estoque, mas é identificada', () => {
  const product = parseProduct(productPage('1257', 'PreOrder'));
  assert.equal(product.inStock, false);
  assert.equal(product.preOrder, true);
});

test('rejeita páginas de outras plataformas', () => {
  assert.equal(parseProduct('<html>outra plataforma</html>'), null);
  assert.equal(parseProduct('<form id="product_form"><input name="add_to_cart" value="222" /></form>'), null);
  assert.equal(parseProduct('<a href="cartService.php?loja=1&acao=incluir&IdProd=2">Comprar</a>'), null);
  assert.equal(parseProduct('<script>productInfo.Init({"id":"1109"});</script>'), null);
});

test('retirada e juntar ao pedido anterior não são entrega', () => {
  const delivery = cheapestDelivery(JSON.parse(quote(pickup, combine, sedex)));
  assert.deepEqual(delivery, { cost: 26.49, service: 'SEDEX', maxDays: 4 });
});

test('juntar pedidos fica de fora mesmo com outro título', () => {
  const renamed = { ...combine, title: 'Adicionar a uma compra em aberto' };
  assert.equal(cheapestDelivery(JSON.parse(quote(renamed, sedex))).service, 'SEDEX');
});

test('opção com valor a combinar não é entrega', () => {
  const motoboy = option('customizada2', 'Motoboy', 0, { cost_label: 'A combinar' });
  assert.equal(cheapestDelivery(JSON.parse(quote(motoboy, sedex))).service, 'SEDEX');
});

test('a entrega da própria loja conta, com o título limpo e sem prazo fixo', () => {
  const delivery = cheapestDelivery(JSON.parse(quote(pickup, combine, storeDelivery, sedex)));
  assert.deepEqual(delivery, { cost: 15.9, service: 'RECEBA HOJE!!* - MECA Entrega' });
});

test('frete grátis real vale como entrega de custo zero', () => {
  const free = option('free', 'Frete grátis', 0);
  const delivery = cheapestDelivery(JSON.parse(quote(pickup, free, combine, storeDelivery)));
  assert.deepEqual(delivery, { cost: 0, service: 'Frete grátis', maxDays: 4 });
});

test('opção com erro ou sem valor numérico fica de fora', () => {
  const failed = option('melhorenvio_31', 'Express', 0, { error: 'Sem cobertura para o CEP' });
  const noCost = option('melhorenvio_22', 'Rodoviário', 0, { cost: null });
  assert.equal(cheapestDelivery(JSON.parse(quote(failed, noCost, sedex))).service, 'SEDEX');
});

test('sem entrega válida devolve nulo', () => {
  assert.equal(cheapestDelivery(JSON.parse(quote(pickup, combine))), null);
  assert.equal(cheapestDelivery({ status: true, options: [] }), null);
});

const fakeSession = (shipping) => {
  const posts = [];
  return {
    posts,
    async get() { return { text: '' }; },
    async post(url, body) {
      posts.push(`${new URL(url).pathname} ${body}`);
      return { url, status: 200, text: shipping };
    },
  };
};

const available = (productId) => ({ productId, inStock: true });

test('cota os produtos juntos em uma só requisição, sem tocar no carrinho', async () => {
  const session = fakeSession(quote(pickup, combine, sedex));
  const delivery = await quoteCart('https://loja.com', [available('1109'), available('1285')], '01310-100', session);
  assert.equal(delivery.cost, 26.49);
  assert.deepEqual(session.posts, [
    '/shipping/quote cep=01310100'
    + '&products[0][id]=1109&products[0][qty]=1&products[0][variation]='
    + '&products[1][id]=1285&products[1][qty]=1&products[1][variation]=',
  ]);
});

test('pré-venda é cotada e sinalizada', async () => {
  const session = fakeSession(quote(sedex));
  const products = [available('699'), { productId: '1257', inStock: false, preOrder: true }];
  const delivery = await quoteCart('https://loja.com', products, '01310100', session);
  assert.equal(delivery.cost, 26.49);
  assert.equal(delivery.preOrder, true);
});

test('item esgotado invalida a cotação antes de qualquer requisição', async () => {
  const session = fakeSession(quote(sedex));
  const products = [available('699'), { productId: '260', inStock: false }];
  assert.deepEqual(await quoteCart('https://loja.com', products, '01310100', session), { unavailable: 'fora de estoque' });
  assert.deepEqual(session.posts, []);
});

test('resposta que não vem em JSON invalida a cotação', async () => {
  const session = fakeSession('<html>403 Forbidden</html>');
  assert.equal(await quoteCart('https://loja.com', [available('1109')], '01310100', session), null);
});

test('recusa do cálculo de frete devolve nulo', async () => {
  const session = fakeSession(JSON.stringify({ error: 'CEP inválido' }));
  assert.equal(await quoteCart('https://loja.com', [available('1109')], '01310100', session), null);
});
