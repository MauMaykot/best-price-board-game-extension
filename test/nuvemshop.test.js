import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/nuvemshop.js';

const option = (name, price, cost = ` R$${price}`, classes = '') => `<input
  class="js-shipping-method ${classes} shipping-method"
  data-price="${price}"
  data-name="${name}"
  data-cost="${cost}"
  type="radio" />`;

test('lê a variante do formulário principal, ignorando os relacionados', () => {
  const html = `
    <form class="js-product-form" action="/comprar/"><input type="hidden" name="add_to_cart" value="111" /></form>
    <form id="product_form" class="js-product-form" action="/comprar/"><input type="hidden" name="add_to_cart" value="222" /></form>`;
  assert.deepEqual(parseProduct(html), { variantId: '222' });
  assert.equal(parseProduct('<html>outra plataforma</html>'), null);
});

test('escolhe a entrega mais barata e aceita frete grátis real', () => {
  const delivery = cheapestDelivery(option('PAC', '0', ' Grátis') + option('SEDEX', '16.32'));
  assert.equal(delivery.cost, 0);
  assert.equal(delivery.service, 'PAC');
});

test('opções com valor zero que não são entrega ficam de fora', () => {
  const delivery = cheapestDelivery(
    option('Juntar com o Pedido Anterior (somente clientes com pedidos em aberto)', '0', ' Grátis')
    + option('Enviar 99/Uber/Rappi', '0', ' A combinar ')
    + option('Ponto de retirada', '0', ' Grátis', 'js-branch-method')
    + option('Unidade Centro', '0', ' Grátis', 'js-branch-method')
    + option('SEDEX', '14.42'),
  );
  assert.equal(delivery.service, 'SEDEX');
});

test('sem entrega válida devolve nulo', () => {
  assert.equal(cheapestDelivery(option('Retirada', '0', ' Grátis')), null);
});

const fakeSession = ({ cart }) => {
  const posts = [];
  return {
    posts,
    async get() { return { text: cart }; },
    async post(url, body) {
      posts.push(`${new URL(url).pathname} ${body}`);
      return { text: JSON.stringify({ success: true, html: option('SEDEX', '16.32') }) };
    },
  };
};

test('inclui as variantes e cota o carrinho', async () => {
  const session = fakeSession({ cart: 'item 111 item 222' });
  const quote = await quoteCart('https://loja.com', [{ variantId: '111' }, { variantId: '222' }], '01310-100', session);
  assert.equal(quote.cost, 16.32);
  assert.deepEqual(session.posts, ['/comprar/ add_to_cart=111&quantity=1', '/comprar/ add_to_cart=222&quantity=1', '/frete/ zipcode=01310100']);
});

test('item que não entrou no carrinho invalida a cotação', async () => {
  const session = fakeSession({ cart: 'item 111' });
  const quote = await quoteCart('https://loja.com', [{ variantId: '111' }, { variantId: '222' }], '01310100', session);
  assert.equal(quote, null);
  assert.ok(!session.posts.some((post) => post.startsWith('/frete/')));
});
