import assert from 'node:assert/strict';
import test from 'node:test';
import * as bravo from '../src/freight/bravo.js';
import * as brecho from '../src/freight/brecho.js';
import * as lojaIntegrada from '../src/freight/lojaIntegrada.js';
import * as meca from '../src/freight/meca.js';
import * as nuvemshop from '../src/freight/nuvemshop.js';
import * as paladins from '../src/freight/paladins.js';
import { fillCart } from '../src/freight/quoter.js';
import * as tray from '../src/freight/tray.js';

const ORIGIN = 'https://loja.com';

const scripted = (routes) => {
  const calls = [];
  const answer = (method) => async (url, body) => {
    const { pathname, search } = new URL(url);
    const path = `${pathname}${search}`;
    calls.push(body === undefined ? `${method} ${path}` : `${method} ${path} ${body}`);
    const route = Object.keys(routes).find((key) => path.startsWith(key));
    const reply = route === undefined ? '' : routes[route];
    return { url, status: 200, text: typeof reply === 'function' ? reply(body) : reply };
  };
  return { calls, get: answer('GET'), post: answer('POST') };
};

test('tray: inclui os itens e devolve o carrinho da loja', async () => {
  const session = {
    async get(url) { return { url: `${ORIGIN}/checkout/cart?session_id=abc`, text: '' }; },
  };
  const products = [{ storeCode: '1', productId: '9' }];
  assert.equal(await tray.addToCart(ORIGIN, products, session), `${ORIGIN}/loja/redirect_cart_service.php?loja=1`);
  assert.equal(tray.applyCoupon, undefined);
});

test('nuvemshop: confere os itens antes de devolver o carrinho', async () => {
  const session = scripted({ '/comprar/': 'item 111' });
  assert.equal(await nuvemshop.addToCart(ORIGIN, [{ variantId: '111' }], session), `${ORIGIN}/comprar/`);
  assert.equal(await nuvemshop.addToCart(ORIGIN, [{ variantId: '111' }, { variantId: '222' }], session), null);
  assert.equal(nuvemshop.applyCoupon, undefined);
});

test('loja integrada: inclui itens e reconhece cupom aplicado', async () => {
  const cart = '<tr data-produto-id="1"></tr>';
  const session = scripted({
    '/carrinho/index': cart,
    '/carrinho/cupom/validar': (body) => (body.includes('VALE10') ? '<div data-cupom-desconto-codigo="VALE10"></div>' : '<div class="alert">Cupom não encontrado.</div>'),
  });
  assert.equal(await lojaIntegrada.addToCart(ORIGIN, [{ productId: '1' }], session), `${ORIGIN}/carrinho/index`);
  assert.equal(await lojaIntegrada.addToCart(ORIGIN, [{ productId: '2' }], session), null);
  assert.equal(await lojaIntegrada.applyCoupon(ORIGIN, 'VALE10', session), true);
  assert.equal(await lojaIntegrada.applyCoupon(ORIGIN, 'FALSO', session), false);
});

test('woocommerce: só confirma o cupom que aparece no carrinho', async () => {
  let coupons = [];
  const session = scripted({
    '/carrinho/': '{"apply_coupon_nonce":"n1"}',
    '/?wc-ajax=apply_coupon': (body) => { if (body.includes('VALE10')) coupons = [{ code: 'vale10' }]; return ''; },
    '/wp-json/wc/store/v1/cart': () => JSON.stringify({ items: [{ id: 5 }], coupons }),
  });
  assert.equal(await brecho.addToCart(ORIGIN, [{ productId: '5' }], session), `${ORIGIN}/carrinho/`);
  assert.equal(await brecho.addToCart(ORIGIN, [{ productId: '6' }], session), null);
  assert.equal(await brecho.applyCoupon(ORIGIN, 'FALSO', session), false);
  assert.equal(await brecho.applyCoupon(ORIGIN, 'VALE10', session), true);
});

test('commerceplus: valida o cupom e abre o endereço que o aplica', async () => {
  const product = { productId: '7', subproductId: '8', productJson: '{"idproduto":"7"}' };
  const session = scripted({
    '/carrinho/cupomdesconto/': '',
    '/carrinho': 'id="qtd_7_8" window.location = "/carrinho/cupomdesconto/abc123";',
    '/mediaplus/controller/cpcontroller': (body) => {
      if (body.includes('add_item_carrinho')) return 'mp*1*ok';
      return body.includes('VALE10') ? 'mp*1*ok' : 'mp*0*Cupom inválido';
    },
  });
  assert.equal(await paladins.addToCart(ORIGIN, [product], session), `${ORIGIN}/carrinho`);
  assert.equal(await paladins.applyCoupon(ORIGIN, 'FALSO', session), false);
  assert.ok(!session.calls.includes('GET /carrinho/cupomdesconto/abc123'));
  assert.equal(await paladins.applyCoupon(ORIGIN, 'VALE10', session), true);
  assert.ok(session.calls.includes('GET /carrinho/cupomdesconto/abc123'));
});

test('simplo7: inclui itens e lê a resposta do cupom', async () => {
  const session = scripted({
    '/carrinhos/createProduct/1766/1': '{"produto_id":"1766"}',
    '/carrinhos/createProduct/9/1': '{"erro":true}',
    '/carrinhos/updateCoupon': (body) => (body.includes('VALE10') ? '{"Cupom":{"codigo":"VALE10"}}' : '{"Cupom":[],"Errors":"Cupom inexistente."}'),
  });
  assert.equal(await bravo.addToCart(ORIGIN, [{ productId: '1766' }], session), `${ORIGIN}/carrinho`);
  assert.equal(await bravo.addToCart(ORIGIN, [{ productId: '9' }], session), null);
  assert.equal(await bravo.applyCoupon(ORIGIN, 'VALE10', session), true);
  assert.equal(await bravo.applyCoupon(ORIGIN, 'FALSO', session), false);
});

test('iset: inclui itens e deixa o cupom para o usuário', async () => {
  const session = scripted({ '/cart/add': (body) => `{"product_cart_id":${body.match(/id_produto=(\d+)/)[1]}}` });
  assert.equal(await meca.addToCart(ORIGIN, [{ productId: '1109' }], session), `${ORIGIN}/cart`);
  assert.equal(meca.applyCoupon, undefined);
});

const trayPage = '<a href="/loja/cartService.php?loja=1&amp;acao=incluir&amp;IdProd=9">Comprar</a>';

test('fillCart usa a sessão recebida e informa se o cupom não foi aplicado', async () => {
  const session = {
    async get(url) {
      if (url.includes('cartService')) return { url: 'https://loja.com/checkout/cart?session_id=abc', text: '' };
      return { url, text: trayPage };
    },
  };
  const result = await fillCart([{ url: 'https://loja.com/a' }], 'VALE10', session);
  assert.deepEqual(result, { cartUrl: 'https://loja.com/loja/redirect_cart_service.php?loja=1', couponApplied: false });
});

test('fillCart aplica o cupom e sobrevive a falha na rota de cupom', async () => {
  const page = '<meta name="generator" content="Loja Integrada" /><script>var PRODUTO_ID = \'1\';</script>';
  const session = {
    async get(url) { return { url, text: url.includes('/carrinho/index') ? '<tr data-produto-id="1"></tr>' : page }; },
    async post() { throw new Error('timeout'); },
  };
  const result = await fillCart([{ url: 'https://loja.com/a' }], 'VALE10', session);
  assert.deepEqual(result, { cartUrl: 'https://loja.com/carrinho/index', couponApplied: false });
});

test('fillCart não acessa site só manual nem loja sem carrinho anônimo', async () => {
  const blocked = { get: async () => { throw new Error('não deveria acessar'); } };
  assert.equal(await fillCart([{ url: 'https://www.amazon.com.br/dp/X' }], '', blocked), null);
  assert.equal(await fillCart([{ url: 'https://www.mercadolivre.com.br/p/X' }], '', blocked), null);

  const pira = { get: async (url) => ({ url, text: '<link rel="canonical" href="https://piranoboardgame.com.br/jogo/x" />' }) };
  assert.equal(await fillCart([{ url: 'https://piranoboardgame.com.br/jogo/x' }], '', pira), null);
});
