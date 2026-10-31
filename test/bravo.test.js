import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/bravo.js';

const page = (stock = 'data-id="100" data-stock="200"') => `
  <link href="https://11111.cdn.simplo7.net/static/11111/configuracao/favicon.png" rel="icon" />
  <li class="product-list-item product-simple" data-sku="999" data-id="888"></li>
  <h1 class="product-name" itemprop="name" data-gift="0" ${stock}>Jogo de Teste</h1>`;

const option = (Id, Nome, Valor, PrazoEntrega = 3) => ({ Id, Nome, Valor, PrazoEntrega, alerta_fretegratis: null });

const freeShippingNotice = {
  Id: '107',
  Nome: 'Comprando mais R$ 20,01 O <span>frete Grátis-SP estará disponível</span>.',
  Valor: null,
  PrazoEntrega: 0,
  alerta_fretegratis: true,
};

const detail = (id, overrides = {}) => ({
  id,
  produto_id: `p${id}`,
  sku: `SKU${id}`,
  altura: '13',
  largura: '30',
  comprimento: '45',
  peso: '1.1',
  valor_venda_unitario: 59.9,
  estoque_disponivel: '5',
  disponivel: true,
  frete_gratis: false,
  ...overrides,
});

test('lê o produto e o estoque do título, ignorando os relacionados', () => {
  assert.deepEqual(parseProduct(page()), { productId: '100', stockId: '200' });
});

test('reconhece a página de um produto esgotado, que é tratado na cotação', () => {
  assert.deepEqual(parseProduct(`${page()}<a class="btn btn-tell-me">Avise-me</a>`), { productId: '100', stockId: '200' });
});

test('rejeita outras plataformas e páginas sem produto', () => {
  const tray = '<a href="/loja/cartService.php?loja=123&acao=incluir&IdProd=456">Comprar</a>';
  const nuvemshop = '<form id="product_form"><input name="add_to_cart" value="222" /></form>';
  const sameTitleElsewhere = '<h1 class="product-name" data-id="100" data-stock="200">Jogo</h1>';
  const categoryPage = '<img src="https://11111.cdn.simplo7.net/static/x.png" /><h1 class="title">Jogos</h1>';

  assert.equal(parseProduct(tray), null);
  assert.equal(parseProduct(nuvemshop), null);
  assert.equal(parseProduct(sameTitleElsewhere), null);
  assert.equal(parseProduct(categoryPage), null);
});

test('escolhe a entrega mais barata e lê o prazo', () => {
  const delivery = cheapestDelivery([option('1', 'PAC', '19.38', 9), option('2', 'Sedex', '14.98', 3)]);
  assert.deepEqual(delivery, { cost: 14.98, service: 'Sedex', maxDays: 3 });
});

test('aceita frete grátis real', () => {
  const delivery = cheapestDelivery([option('1', 'PAC', '23.17', 9), option('107', 'Grátis-SP', '0.00', 4)]);
  assert.deepEqual(delivery, { cost: 0, service: 'Grátis-SP', maxDays: 4 });
});

test('retirada na loja com valor zero não é entrega', () => {
  const delivery = cheapestDelivery([option('10', 'Retirar na Loja', '0.00', 2), option('5', 'Motoboy', '45.00', 2)]);
  assert.equal(delivery.service, 'Motoboy');
});

test('o aviso de frete grátis por valor não vira frete grátis', () => {
  const delivery = cheapestDelivery([option('2', 'Sedex', '14.98'), freeShippingNotice]);
  assert.equal(delivery.service, 'Sedex');
  assert.equal(cheapestDelivery([freeShippingNotice]), null);
});

test('sem prazo informado, omite o prazo', () => {
  assert.deepEqual(cheapestDelivery([option('2', 'Sedex', '14.98', 0)]), { cost: 14.98, service: 'Sedex' });
});

test('sem entrega válida ou com resposta inesperada devolve nulo', () => {
  assert.equal(cheapestDelivery([option('10', 'Retirar na Loja', '0.00')]), null);
  assert.equal(cheapestDelivery({ Erro: { MsgErro: 'Nenhuma forma de entrega disponível para este Carrinho' } }), null);
  assert.equal(cheapestDelivery([option('2', 'Sedex', '14.98'), { 0: option('3', 'Lote', '1.00') }]), null);
  assert.equal(cheapestDelivery(null), null);
});

const fakeSession = ({ details, quote = [option('2', 'Sedex', '22.05', 3), option('1', 'PAC', '29.47', 9)] }) => {
  const requests = [];
  return {
    requests,
    async get(url) { throw new Error(`GET inesperado: ${url}`); },
    async post(url, body) {
      const { pathname } = new URL(url);
      requests.push({ pathname, body });
      if (pathname === '/shipping/quote') return { text: JSON.stringify(quote) };
      const response = details[pathname.split('/').pop()];
      return { text: typeof response === 'string' ? response : JSON.stringify(response) };
    },
  };
};

const products = [{ productId: '1', stockId: '11' }, { productId: '2', stockId: '22' }];

test('cota os itens juntos numa única chamada, sem tocar no carrinho', async () => {
  const session = fakeSession({ details: { 1: detail('11'), 2: detail('22') } });
  const quote = await quoteCart('https://loja.com', products, '01310100', session);
  assert.deepEqual(quote, { cost: 22.05, service: 'Sedex', maxDays: 3 });

  assert.deepEqual(session.requests.map(({ pathname }) => pathname), [
    '/produto/combinacao/readDetalhamento/1',
    '/produto/combinacao/readDetalhamento/2',
    '/shipping/quote',
  ]);

  const form = new URLSearchParams(session.requests[2].body);
  const { Item } = JSON.parse(form.get('carrinho'));
  assert.deepEqual(Item.map((item) => item.produto_estoque_id), ['11', '22']);
  assert.equal(Item[0].valor_unitario, 59.9);
  assert.equal(Item[0].peso, '1.1');
  assert.equal(Item[0].quantidade, 1);
  assert.deepEqual(JSON.parse(form.get('cep')), { Cep: '01310-100' });
  assert.equal(form.get('product_only'), 'true');
});

test('item esgotado invalida a cotação, antes de pedir o frete', async () => {
  const soldOut = detail('22', { disponivel: false, estoque_disponivel: '0' });
  const session = fakeSession({ details: { 1: detail('11'), 2: soldOut } });
  assert.equal(await quoteCart('https://loja.com', products, '01310100', session), null);
  assert.ok(!session.requests.some(({ pathname }) => pathname === '/shipping/quote'));
});

test('produto removido da loja ou de outro estoque invalida a cotação', async () => {
  const removed = fakeSession({ details: { 1: detail('11'), 2: detail(null, { disponivel: false }) } });
  assert.equal(await quoteCart('https://loja.com', products, '01310100', removed), null);

  const otherVariant = fakeSession({ details: { 1: detail('11'), 2: detail('33') } });
  assert.equal(await quoteCart('https://loja.com', products, '01310100', otherVariant), null);
});

test('resposta que não é JSON devolve nulo', async () => {
  const session = fakeSession({ details: { 1: '<!DOCTYPE html><title>Não encontrado</title>' } });
  assert.equal(await quoteCart('https://loja.com', products, '01310100', session), null);
});

test('sem entrega para o CEP devolve nulo', async () => {
  const session = fakeSession({
    details: { 1: detail('11'), 2: detail('22') },
    quote: { Erro: { MsgErro: 'Nenhuma forma de entrega disponível para este Carrinho' } },
  });
  assert.equal(await quoteCart('https://loja.com', products, '01310100', session), null);
});
