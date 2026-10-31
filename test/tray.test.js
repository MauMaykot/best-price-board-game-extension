import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/tray.js';

const quotation = (name, value, pickup = '0') => ({ name, value, pickup, minPeriod: '2', maxPeriod: '3' });
const options = (...quotations) => ({ data: { quotations } });

const fakeSession = () => {
  const requested = [];
  return {
    requested,
    async get(url) {
      requested.push(url);
      if (url.includes('/loja/cartService.php')) {
        return { url: 'https://loja.com/checkout/cart?session_id=abc&store_id=1395318', text: '' };
      }
      return { url, text: JSON.stringify(options(quotation('PAC', '18.58'))) };
    },
  };
};

test('retirada com valor zero não vira frete grátis', () => {
  const delivery = cheapestDelivery(options(
    quotation('Retirada em Mogi', '0.00', '2'),
    quotation('Econômico', '16.36'),
    quotation('SEDEX', '27.6'),
  ));
  assert.equal(delivery.cost, 16.36);
  assert.equal(delivery.service, 'Econômico');
});

test('juntar ao pedido anterior e retirada sem marcação não viram entrega', () => {
  const delivery = cheapestDelivery(options(
    quotation('Juntar ao Pedido Anterior', '0.01'),
    quotation('Adicionar ao pedido anterior', '0.00'),
    quotation('Juntar Pedidos', '0.00'),
    quotation('Retirar na loja', '0.00'),
    quotation('PAC', '25.80'),
  ));
  assert.equal(delivery.service, 'PAC');
});

test('frete grátis de verdade é mantido', () => {
  assert.equal(cheapestDelivery(options(quotation('Frete Grátis SP', '0.00'), quotation('SEDEX', '27.6'))).cost, 0);
});

test('só retirada equivale a sem entrega', () => {
  assert.equal(cheapestDelivery(options(quotation('Retirada', '0.00', '2'))), null);
  assert.equal(cheapestDelivery({ data: {} }), null);
});

test('lê loja e produto da página', () => {
  const html = '<a href="/loja/cartService.php?loja=1395318&amp;acao=incluir&amp;IdProd=905">Comprar</a>';
  assert.deepEqual(parseProduct(html), { storeCode: '1395318', productId: '905' });
  assert.equal(parseProduct('<html>outra plataforma</html>'), null);
});

test('inclui todos os produtos na mesma sessão antes de cotar', async () => {
  const session = fakeSession();
  const products = [{ storeCode: '1395318', productId: '1' }, { storeCode: '1395318', productId: '2' }];
  const quote = await quoteCart('https://loja.com', products, '01310100', session);

  assert.equal(quote.cost, 18.58);
  const included = session.requested.filter((url) => url.includes('acao=incluir'));
  assert.deepEqual(included.map((url) => url.split('IdProd=')[1]), ['1', '2']);
  assert.ok(session.requested.at(-1).includes('session_id=abc&zipcode=01310-100'));
});
