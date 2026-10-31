import assert from 'node:assert/strict';
import test from 'node:test';
import { cheapestDelivery, parseProduct, quoteCart } from '../src/freight/paladins.js';

const productJson = (id) => `{"idproduto":"${id}","Loja":{"idloja":"216"},"Marca":{"nome":"DEVIR"},"preco":"169.9","peso":"0.2"}`;

const page = (id, subproduct) => `<!DOCTYPE html><html><script type="text/javascript">
  function add_item_carrinho(page_direciona){
    $.ajax({
       type: 'POST',
       url: '/mediaplus/controller/cpcontroller',
       data: 'metodo=add_item_carrinho&param1=${productJson(id)}&param2='+idsubproduto+'&param3='+qtd,
    });
  }
  function defineSubproduto(id){ $('#idsubproduto').attr('value', id); }
  </script>
  <input type="hidden" id="idsubproduto" name="idsubproduto" value="" />
  <script type="text/javascript">
    ${subproduct ? `defineSubproduto(${subproduct});` : ''}
  </script></html>`;

const option = (code, price, term, name) => `mp*-*-*${code}*-*-*${price}****${term}****${name}`;
const pac = option('fp_pac.correios_89', 'R$ 23,69', '6 a 7 dias �teis', 'Pac correios');
const sedex = option('fp_sedex.correios_90', 'R$ 53,49', '2 a 3 dias �teis', 'Sedex correios');
const pickup = option('fretepersonalizado_1338', 'Gr�tis', '1 dia �til', 'Retirar na loja');
const options = (...items) => items.join('--mp--');

const cartLine = (id, subproduct) => `<input type="text" class="qt" id="qtd_${id}_${subproduct}" value="1" maxlength="4" />`;

test('lê o produto e o subproduto da página', () => {
  assert.deepEqual(parseProduct(page('2596285', '4568916')), {
    productId: '2596285',
    subproductId: '4568916',
    productJson: productJson('2596285'),
  });
});

test('rejeita páginas de outras plataformas', () => {
  const tray = '<a href="/loja/cartService.php?loja=123&acao=incluir&IdProd=456">Comprar</a>';
  const nuvemshop = '<form id="product_form" action="/comprar/"><input type="hidden" name="add_to_cart" value="222" /></form>';
  const citation = '<img src="https://commerceplus.com.br/loja/logo.png" /><script>defineSubproduto(1);</script>';
  for (const html of [tray, nuvemshop, citation, '<html>outra plataforma</html>']) {
    assert.equal(parseProduct(html), null);
  }
});

test('produto sem item padrão ou com JSON ilegível não é cotado', () => {
  assert.equal(parseProduct(page('2596285', null)), null);
  assert.equal(parseProduct(page('2596285', '4568916').replace('"idproduto"', 'idproduto')), null);
});

test('escolhe a entrega mais barata com prazo', () => {
  assert.deepEqual(cheapestDelivery(options(sedex, pac, pickup)), {
    cost: 23.69,
    service: 'Pac correios',
    minDays: 6,
    maxDays: 7,
  });
});

test('aceita frete grátis real', () => {
  const free = option('fp_pac.correios_89', 'Gr�tis', '6 a 7 dias �teis', 'Pac correios');
  const delivery = cheapestDelivery(options(free, sedex, pickup));
  assert.equal(delivery.cost, 0);
  assert.equal(delivery.service, 'Pac correios');
});

test('entende valor com milhar, prazo de um dia e descrição depois do zero', () => {
  const delivery = cheapestDelivery('mp*-*-*tnt*-*-*R$ 1.234,56****1 dia �til****0****Transportadora');
  assert.deepEqual(delivery, { cost: 1234.56, service: 'Transportadora', minDays: 1, maxDays: 1 });
});

test('ignora o endereço que vem depois das opções', () => {
  const delivery = cheapestDelivery(`${options(pac, sedex)}__________Rua Exemplo, S�o Paulo`);
  assert.equal(delivery.cost, 23.69);
});

test('opções que não são entrega ficam de fora', () => {
  const delivery = cheapestDelivery(options(
    pickup,
    option('retirar_na_loja', 'R$ 0,00', '1 dia', 'Loja'),
    option('fretepersonalizado_1', 'Gr�tis', '1 dia', 'Retira na loja'),
    option('fretepersonalizado_2', 'Gr�tis', '1 dia', 'Juntar com o pedido anterior'),
    option('fretepersonalizado_3', 'Gr�tis', '1 dia', 'Valor a combinar'),
    option('orcamento', 'R$ 0,00', 'Prazo a definir', 'Or�ar Frete - Transportadoras'),
    option('fretepersonalizado_4', 'Pre�o a definir', 'Prazo a definir', 'Transportadora'),
    sedex,
  ));
  assert.equal(delivery.service, 'Sedex correios');
});

test('opção com erro não entra na conta', () => {
  const failed = option('fp_pac.correios_89', 'R$ 1,00', 'erro2', 'Pac correios');
  assert.equal(cheapestDelivery(options(failed, sedex)).service, 'Sedex correios');
});

test('sem entrega válida devolve nulo', () => {
  assert.equal(cheapestDelivery(pickup), null);
  assert.equal(cheapestDelivery(''), null);
  assert.equal(cheapestDelivery('mp****erro****Cep fora da faixa de endere�os permitidos para entrega.'), null);
  assert.equal(cheapestDelivery('mp****errocep****Cep incorreto. Deve possuir 8 numeros!'), null);
});

const fakeSession = ({ cart, shipping = options(pac, sedex, pickup), addResponses = {} }) => {
  const posts = [];
  return {
    posts,
    async get(url) {
      return { url: url.replace('http://', 'https://'), status: 200, text: cart };
    },
    async post(url, body) {
      posts.push({ url, body });
      const params = new URLSearchParams(body);
      if (params.get('metodo') === 'add_item_carrinho') {
        return { url, status: 200, text: addResponses[params.get('param2')] ?? 'mp*1*1*1' };
      }
      return { url, status: 200, text: shipping };
    },
  };
};

const compile = parseProduct(page('2596285', '4568916'));
const maskmen = parseProduct(page('2659031', '4637664'));

test('inclui os itens e cota o carrinho inteiro', async () => {
  const session = fakeSession({ cart: cartLine('2596285', '4568916') + cartLine('2659031', '4637664') });
  const quote = await quoteCart('https://loja.com', [compile, maskmen], '01310-100', session);
  assert.equal(quote.cost, 23.69);

  const [first, second, freight] = session.posts.map(({ body }) => new URLSearchParams(body));
  assert.equal(session.posts.length, 5);
  assert.equal(first.get('metodo'), 'add_item_carrinho');
  assert.equal(first.get('param1'), compile.productJson);
  assert.equal(first.get('param2'), '4568916');
  assert.equal(first.get('param3'), '1');
  assert.equal(second.get('param2'), '4637664');
  assert.equal(freight.get('metodo'), 'get_opcoes_frete');
  assert.equal(freight.get('param1'), '1');
  assert.equal(freight.get('param2'), '01310100');
});

test('usa a origem final, porque o http redirecionado perderia o corpo dos POSTs', async () => {
  const session = fakeSession({ cart: cartLine('2596285', '4568916') });
  await quoteCart('http://loja.com', [compile], '01310100', session);
  assert.ok(session.posts.every(({ url }) => url === 'https://loja.com/mediaplus/controller/cpcontroller'));
});

test('item recusado pela loja invalida a cotação', async () => {
  const session = fakeSession({
    cart: cartLine('2596285', '4568916'),
    addResponses: { 4637664: 'mp*0*esgotado' },
  });
  assert.equal(await quoteCart('https://loja.com', [compile, maskmen], '01310100', session), null);
  assert.ok(!session.posts.some(({ body }) => body.includes('get_opcoes_frete')));
});

test('item que não aparece no carrinho invalida a cotação', async () => {
  const session = fakeSession({ cart: `${cartLine('2596285', '4568916')} recomendados: 2659031 4637664` });
  assert.equal(await quoteCart('https://loja.com', [compile, maskmen], '01310100', session), null);
  assert.ok(!session.posts.some(({ body }) => body.includes('get_opcoes_frete')));
});

const removed = (session) => session.posts
  .map(({ body }) => new URLSearchParams(body))
  .filter((params) => params.get('metodo') === 'del_item_carrinho')
  .map((params) => params.get('param1'));

test('tira os itens do carrinho depois de cotar', async () => {
  const session = fakeSession({ cart: cartLine('2596285', '4568916') + cartLine('2659031', '4637664') });
  await quoteCart('https://loja.com', [compile, maskmen], '01310100', session);
  assert.deepEqual(removed(session), ['4568916', '4637664']);
});

test('item recusado não fica preso: tira só o que entrou', async () => {
  const session = fakeSession({
    cart: cartLine('2596285', '4568916'),
    addResponses: { 4637664: 'mp*0*esgotado' },
  });
  await quoteCart('https://loja.com', [compile, maskmen], '01310100', session);
  assert.deepEqual(removed(session), ['4568916']);
});

test('item fora do carrinho também limpa o que foi incluído', async () => {
  const session = fakeSession({ cart: cartLine('2596285', '4568916') });
  await quoteCart('https://loja.com', [compile, maskmen], '01310100', session);
  assert.deepEqual(removed(session), ['4568916', '4637664']);
});

test('falha ao limpar não derruba a cotação já obtida', async () => {
  const session = fakeSession({ cart: cartLine('2596285', '4568916') });
  const { post } = session;
  session.post = async (url, body) => {
    if (body.includes('del_item_carrinho')) throw new Error('tempo esgotado');
    return post(url, body);
  };
  const quote = await quoteCart('https://loja.com', [compile], '01310100', session);
  assert.equal(quote.cost, 23.69);
});

test('resposta vazia para CEP sem cotação devolve nulo', async () => {
  const session = fakeSession({ cart: cartLine('2596285', '4568916'), shipping: '' });
  assert.equal(await quoteCart('https://loja.com', [compile], '00000000', session), null);
});
