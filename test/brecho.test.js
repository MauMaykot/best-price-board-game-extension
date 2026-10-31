import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/brecho.js';

const productPage = `
  <a href="?add-to-cart=999" data-product_id="999" class="add_to_cart_button">Relacionado</a>
  <p class="stock available-on-backorder">Disponível por encomenda</p>
  <form class="cart" action="https://brecholudico.com.br/produto/ruins/" method="post" enctype='multipart/form-data'>
    <div class="quantity"><input type="number" name="quantity" value="1" /></div>
    <button type="submit" name="add-to-cart" value="42519" class="single_add_to_cart_button button alt">Adicionar ao carrinho</button>
  </form>`;

const rate = (rateId, methodId, name, price) => ({
  rate_id: rateId,
  method_id: methodId,
  name,
  description: '',
  delivery_time: '',
  price,
  currency_minor_unit: 2,
});

const PAC = rate('correios-cws31', 'correios-cws', 'PAC', '2507');
const SEDEX = rate('correios-cws32', 'correios-cws', 'Sedex', '3969');
const FREE = rate('free_shipping:30', 'free_shipping', 'Frete grátis', '0');
// O nome real traz um espaço não separável entre "pedido" e "existente".
const EXISTING_ORDER = rate('flat_rate:33', 'flat_rate', 'Incluir compra em pedido existente.', '200');

const cartHtml = `
  <ul id="shipping_method" class="woocommerce-shipping-methods">
    <li><input type="radio" name="shipping_method[0]" value="correios-cws31" class="shipping_method" /><label>PAC: R$25.07</label><p><small>Entrega em até 6 dias úteis</small></p></li>
    <li><input type="radio" name="shipping_method[0]" value="correios-cws32" class="shipping_method" /><label>Sedex: R$39.69</label><p><small>Entrega em até 1 dia útil</small></p></li>
    <li><input type="radio" name="shipping_method[0]" value="flat_rate:33" class="shipping_method" /><label>Incluir compra: R$2.00</label></li>
  </ul>`;

const storeCart = ({ ids = [42519, 42298], postcode = '01310-100', packages = [[PAC, SEDEX, EXISTING_ORDER]] } = {}) => JSON.stringify({
  items: ids.map((id) => ({ id, quantity: 1 })),
  shipping_address: { postcode, country: 'BR' },
  shipping_rates: packages.map((shippingRates) => ({ shipping_rates: shippingRates })),
});

const cartPage = '<input type="hidden" id="woocommerce-shipping-calculator-nonce" name="woocommerce-shipping-calculator-nonce" value="abc123" />';

const fakeSession = ({ page = cartPage, cart = storeCart() } = {}) => {
  const posts = [];
  return {
    posts,
    async get(url) {
      return { url, status: 200, text: new URL(url).pathname.startsWith('/wp-json/') ? cart : page };
    },
    async post(url, body) {
      posts.push(`${new URL(url).pathname}${new URL(url).search} ${body}`);
      return { url, status: 200, text: cartHtml };
    },
  };
};

const PRODUCTS = [{ productId: '42519' }, { productId: '42298' }];

test('jogo por encomenda fica fora sem montar carrinho', async () => {
  const session = { post: async () => { throw new Error('não deveria incluir no carrinho'); } };
  const quote = await quoteCart('https://brecholudico.com.br', [{ productId: '1', onBackorder: true }], '01310100', session);
  assert.deepEqual(quote, { unavailable: 'encomenda' });
});
const quote = (session, products = PRODUCTS, zipCode = '01310100') => quoteCart('https://brecholudico.com.br', products, zipCode, session);

test('lê o produto do formulário de compra, ignorando os relacionados', () => {
  assert.deepEqual(parseProduct(productPage), { productId: '42519', onBackorder: false });
  assert.equal(parseProduct(`${productPage}"availability":"https://schema.org/BackOrder"`).onBackorder, true);
});

test('rejeita páginas de outras plataformas e de outras lojas WooCommerce', () => {
  assert.equal(parseProduct('<html>outra plataforma</html>'), null);
  assert.equal(parseProduct('<a href="/loja/cartService.php?loja=1&acao=incluir&IdProd=2">Comprar</a>'), null);
  assert.equal(parseProduct('<form id="product_form" action="/comprar/"><input name="add_to_cart" value="222" /></form>'), null);
  assert.equal(parseProduct(productPage.replace('brecholudico.com.br', 'outraloja.com.br')), null);
});

test('produto esgotado não tem formulário de compra', () => {
  assert.equal(parseProduct('<p class="stock out-of-stock">Fora de estoque</p>'), null);
});

test('produto com variações não é reconhecido', () => {
  const html = productPage.replace('class="cart"', 'class="variations_form cart"');
  assert.equal(parseProduct(html), null);
});

test('escolhe a entrega mais barata em reais e lê o prazo no HTML', () => {
  assert.deepEqual(cheapestDelivery([SEDEX, PAC], cartHtml), { cost: 25.07, service: 'PAC', maxDays: 6 });
  assert.deepEqual(cheapestDelivery([SEDEX], cartHtml), { cost: 39.69, service: 'Sedex', maxDays: 1 });
});

test('o prazo de uma opção não vaza para outra sem prazo', () => {
  const cheap = rate('flat_rate:40', 'flat_rate', 'Transportadora', '1000');
  const html = `${cartHtml}<li><input value="flat_rate:40" /><label>Transportadora</label></li>`;
  assert.deepEqual(cheapestDelivery([PAC, cheap], html), { cost: 10, service: 'Transportadora' });
});

test('aceita frete grátis real', () => {
  assert.deepEqual(cheapestDelivery([FREE, PAC, SEDEX, EXISTING_ORDER]), { cost: 0, service: 'Frete grátis' });
});

test('opções que não são entrega ficam de fora, mesmo mais baratas', () => {
  const delivery = cheapestDelivery([
    EXISTING_ORDER,
    rate('flat_rate:34', 'flat_rate', 'Juntar com o pedido anterior', '0'),
    rate('flat_rate:35', 'flat_rate', 'Enviar por 99, valor a combinar', '0'),
    rate('flat_rate:36', 'flat_rate', 'Retirada na loja', '0'),
    rate('local_pickup:37', 'local_pickup', 'Unidade Centro', '0'),
    rate('pickup_location:0', 'pickup_location', 'Loja Pinheiros', '0'),
    PAC,
  ]);
  assert.equal(delivery.service, 'PAC');
});

test('sem entrega válida devolve nulo', () => {
  assert.equal(cheapestDelivery([EXISTING_ORDER]), null);
  assert.equal(cheapestDelivery([]), null);
});

test('monta o carrinho, grava o CEP com o nonce e cota os itens juntos', async () => {
  const session = fakeSession();
  assert.deepEqual(await quote(session), { cost: 25.07, service: 'PAC', maxDays: 6 });
  assert.deepEqual(session.posts, [
    '/?wc-ajax=add_to_cart product_id=42519&quantity=1',
    '/?wc-ajax=add_to_cart product_id=42298&quantity=1',
    '/carrinho/ calc_shipping_postcode=01310100&calc_shipping=1&woocommerce-shipping-calculator-nonce=abc123',
  ]);
});

test('o frete grátis só no carrinho combinado é devolvido', async () => {
  const session = fakeSession({ cart: storeCart({ packages: [[FREE, PAC, SEDEX, EXISTING_ORDER]] }) });
  assert.deepEqual(await quote(session), { cost: 0, service: 'Frete grátis' });
});

test('item que não entrou no carrinho invalida a cotação', async () => {
  const session = fakeSession({ cart: storeCart({ ids: [42298] }) });
  assert.equal(await quote(session), null);
});

test('carrinho vazio não tem calculadora e não chega a cotar', async () => {
  const session = fakeSession({ page: '<p class="cart-empty">Seu carrinho está vazio.</p>' });
  assert.equal(await quote(session), null);
  assert.ok(!session.posts.some((post) => post.startsWith('/carrinho/')));
});

test('CEP que não foi gravado invalida a cotação', async () => {
  assert.equal(await quote(fakeSession({ cart: storeCart({ postcode: '' }) })), null);
  assert.equal(await quote(fakeSession({ cart: storeCart({ postcode: '01001-000' }) })), null);
});

test('carrinho dividido em pacotes não é cotado', async () => {
  const session = fakeSession({ cart: storeCart({ packages: [[PAC], [SEDEX]] }) });
  assert.equal(await quote(session), null);
});

test('resposta fora do formato, como uma página de bloqueio, devolve nulo', async () => {
  assert.equal(await quote(fakeSession({ cart: '<html>406 Not Acceptable</html>' })), null);
});
