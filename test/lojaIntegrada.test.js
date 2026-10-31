import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/lojaIntegrada.js';

const ORIGIN = 'https://loja.com';

const productPage = (id, relatedId = '999', generator = 'Loja Integrada') => `<html><head>
  <meta name="generator" content="${generator}" />
  <script type="text/javascript">
    var PRODUTO_ID = '${id}';
    var URL_PRODUTO_FRETE_CALCULAR = '${ORIGIN}/carrinho/frete';
  </script></head><body>
  <a href="${ORIGIN}/carrinho/produto/${relatedId}/adicionar" class="botao botao-comprar-ajax">Comprar</a>
  <div class="acoes-produto disponivel" data-produto-id="${id}">
    <a href="${ORIGIN}/carrinho/produto/${id}/adicionar" class="botao botao-comprar principal grande">Comprar</a>
  </div>
  </body></html>`;

const option = (name, price, extra = {}) => ({
  msgErro: null, additionalInfo: null, code: '03298', name, deliveryTime: '7', price, originalPrice: price, type: 'enviali2', ...extra,
});
const pickup = option('Retirar pessoalmente', 0, { code: 'retirar_pessoalmente', type: 'faixa_cep', deliveryTime: '1' });

const cartRow = (id) => `<tr data-produto-id="${id}" data-produto-quantidade="1"><td>Jogo</td></tr>`;
const cartPage = (...ids) => `<table class="table tabela-carrinho">${ids.map(cartRow).join('')}</table>`;

test('lê o id do produto principal, ignorando os relacionados', () => {
  assert.deepEqual(parseProduct(productPage('401358279', '401567802')), { productId: '401358279' });
});

test('reconhece a página de produto esgotado, que não tem botão de compra', () => {
  const html = `<meta name="generator" content="Loja Integrada" />
    <script>var PRODUTO_ID = '403273541';</script>
    <div class="acoes-produto indisponivel" data-produto-id="403273541"></div>`;
  assert.deepEqual(parseProduct(html), { productId: '403273541' });
});

test('rejeita outras plataformas e páginas que não são de produto', () => {
  const tray = '<a href="/loja/cartService.php?loja=123&amp;acao=incluir&amp;IdProd=456">Comprar</a>';
  const nuvemshop = '<form id="product_form" action="/comprar/"><input name="add_to_cart" value="222" /></form>';
  const otherPlatform = productPage('123', '999', 'WooCommerce');
  const cart = `<meta name="generator" content="Loja Integrada" />${cartPage('123')}`;

  for (const html of [tray, nuvemshop, otherPlatform, cart, '<html>outra plataforma</html>']) {
    assert.equal(parseProduct(html), null);
  }
});

test('escolhe a entrega mais barata com serviço e prazo', () => {
  const delivery = cheapestDelivery({ deliveries: [option('Correios SEDEX', 61.48), option('Correios PAC', 42.52)] });
  assert.deepEqual(delivery, { cost: 42.52, service: 'Correios PAC', maxDays: 7 });
});

test('opções que não são entrega ficam de fora', () => {
  const delivery = cheapestDelivery({
    deliveries: [
      pickup,
      option('Buscar na loja', 0, { code: 'retirar_pessoalmente' }),
      option('Balcão', 0, { type: 'retirar_pessoalmente' }),
      option('Entrega a combinar', 0),
      option('Motoboy', 0, { additionalInfo: 'Valor a combinar' }),
      option('Juntar com o Pedido Anterior', 0),
      option('Correios PAC', 42.52),
    ],
  });
  assert.equal(delivery.service, 'Correios PAC');
});

test('só retirada, como em CEP inexistente, devolve nulo', () => {
  assert.equal(cheapestDelivery({ deliveries: [pickup] }), null);
});

test('resposta de erro da loja devolve nulo', () => {
  assert.equal(cheapestDelivery({ error: 'Preencha os dados corretamente.' }), null);
});

test('aceita frete grátis real', () => {
  const delivery = cheapestDelivery({
    free_shipping: { active: true, missing_value: 0 },
    deliveries: [pickup, option('Frete Grátis', 0, { originalPrice: 42.52 }), option('Correios SEDEX', 61.48)],
  });
  assert.equal(delivery.cost, 0);
  assert.equal(delivery.service, 'Frete Grátis');
});

test('aviso com preço válido mantém a opção', () => {
  const delivery = cheapestDelivery({
    deliveries: [option('Correios SEDEX', 61.48, { msgErro: 'Sua encomenda poderá sofrer algum atraso.' })],
  });
  assert.equal(delivery.cost, 61.48);
});

test('falha de transportadora com valor zero não é frete grátis', () => {
  const delivery = cheapestDelivery({
    deliveries: [option('Correios PAC', 0, { msgErro: 'CEP não atendido.' }), option('Correios SEDEX', 61.48)],
  });
  assert.equal(delivery.service, 'Correios SEDEX');
});

test('preço ausente ou opção sem nome não viram frete grátis', () => {
  assert.equal(cheapestDelivery({ deliveries: [option('Correios PAC', null)] }), null);
  assert.equal(cheapestDelivery({ deliveries: [option('', 0)] }), null);
});

test('prazo ausente não vira zero dias', () => {
  const delivery = cheapestDelivery({ deliveries: [option('Correios PAC', 42.52, { deliveryTime: null })] });
  assert.deepEqual(delivery, { cost: 42.52, service: 'Correios PAC' });
});

const fakeSession = ({ cart, quote = { deliveries: [pickup, option('Correios PAC', 56.31)] } }) => {
  const gets = [];
  return {
    gets,
    async get(url) {
      const { pathname, search } = new URL(url);
      gets.push(`${pathname}${search}`);
      if (pathname === '/carrinho/index') return { url, status: 200, text: cart };
      if (pathname === '/carrinho/endereco/adicionar') {
        return { url, status: 200, text: typeof quote === 'string' ? quote : JSON.stringify(quote) };
      }
      return { url: `${ORIGIN}/carrinho/index`, status: 200, text: cart };
    },
    async post() { throw new Error('nada aqui usa POST'); },
  };
};

test('inclui os produtos, confere o carrinho e cota o conjunto', async () => {
  const session = fakeSession({ cart: cartPage('222', '111') });
  const quote = await quoteCart(ORIGIN, [{ productId: '111' }, { productId: '222' }], '01310-100', session);
  assert.deepEqual(quote, { cost: 56.31, service: 'Correios PAC', maxDays: 7 });
  assert.deepEqual(session.gets, [
    '/carrinho/produto/111/adicionar',
    '/carrinho/produto/222/adicionar',
    '/carrinho/index',
    '/carrinho/endereco/adicionar?cep=01310100',
  ]);
});

test('item que não entrou no carrinho invalida a cotação', async () => {
  const session = fakeSession({ cart: `<div class="alert alert-danger">Produto sem estoque</div>${cartPage('111')}` });
  const quote = await quoteCart(ORIGIN, [{ productId: '111' }, { productId: '222' }], '01310100', session);
  assert.equal(quote, null);
  assert.ok(!session.gets.some((path) => path.startsWith('/carrinho/endereco/')));
});

test('o id em outra lista da página não conta como item no carrinho', async () => {
  const related = `<div class="acoes-produto" data-produto-id="222"><a href="${ORIGIN}/carrinho/produto/222/adicionar">Comprar</a></div>`;
  const session = fakeSession({ cart: cartPage('111') + related });
  assert.equal(await quoteCart(ORIGIN, [{ productId: '111' }, { productId: '222' }], '01310100', session), null);
});

test('resposta que não é JSON devolve nulo', async () => {
  const session = fakeSession({ cart: cartPage('111'), quote: '<html>Serviço indisponível</html>' });
  assert.equal(await quoteCart(ORIGIN, [{ productId: '111' }], '01310100', session), null);
});

test('CEP sem opções de envio devolve nulo', async () => {
  const session = fakeSession({ cart: cartPage('111'), quote: { deliveries: [] } });
  assert.equal(await quoteCart(ORIGIN, [{ productId: '111' }], '00000000', session), null);
});
