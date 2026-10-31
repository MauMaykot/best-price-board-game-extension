import assert from 'node:assert/strict';
import test from 'node:test';
import { formatZipCode, maskZipCode } from '../src/freight/delivery.js';
import { createQuoter, isManualOnly } from '../src/freight/quoter.js';

const trayPage = '<a href="/loja/cartService.php?loja=1&amp;acao=incluir&amp;IdProd=9">Comprar</a>';

const fakeSession = (pages) => ({
  async get(url) {
    if (url.includes('cartService')) return { url: 'https://loja.com/checkout/cart?session_id=abc', text: '' };
    if (url.includes('/cart/api/shipping')) {
      return { url, text: JSON.stringify({ data: { quotations: [{ name: 'PAC', value: '10', pickup: '0', minPeriod: '1', maxPeriod: '2' }] } }) };
    }
    return { url, text: pages[url] };
  },
});

test('escolhe o adaptador pela página do produto', async () => {
  const url = 'https://loja.com/a';
  const quote = createQuoter({ zipCode: '01310100', createSession: () => fakeSession({ [url]: trayPage }) });
  assert.equal((await quote({ id: 'x' }, [{ url }])).cost, 10);
});

test('plataforma desconhecida fica sem cotação', async () => {
  const url = 'https://outra.com/a';
  const quote = createQuoter({ zipCode: '01310100', createSession: () => fakeSession({ [url]: '<html></html>' }) });
  assert.equal(await quote({ id: 'x' }, [{ url }]), null);
});

test('produto que deixou de ser comprável invalida o carrinho', async () => {
  const urls = ['https://loja.com/a', 'https://loja.com/b'];
  const quote = createQuoter({
    zipCode: '01310100',
    createSession: () => fakeSession({ [urls[0]]: trayPage, [urls[1]]: '<html>esgotado</html>' }),
  });
  assert.equal(await quote({ id: 'x' }, urls.map((url) => ({ url }))), null);
});

test('site só manual não recebe nenhuma requisição', async () => {
  let sessions = 0;
  const quote = createQuoter({ zipCode: '01310100', createSession: () => { sessions += 1; return fakeSession({}); } });
  assert.equal(await quote({ id: 'amazon' }, [{ url: 'https://www.amazon.com.br/dp/B0CWJB3VM7' }]), null);
  assert.equal(sessions, 0);
  assert.equal(isManualOnly('https://www.amazon.com.br/dp/X'), true);
  assert.equal(isManualOnly('https://www.mercadolivre.com.br/p/MLB1'), true);
  assert.equal(isManualOnly('https://amazon.com.br.golpe.com/dp/X'), false);
});

test('cada cotação usa uma sessão nova', async () => {
  const url = 'https://loja.com/a';
  let sessions = 0;
  const quote = createQuoter({
    zipCode: '01310100',
    createSession: () => { sessions += 1; return fakeSession({ [url]: trayPage }); },
  });
  await quote({ id: 'x' }, [{ url }]);
  await quote({ id: 'x' }, [{ url }]);
  assert.equal(sessions, 2);
});

test('formata o CEP enquanto o usuário digita', () => {
  assert.equal(maskZipCode(''), '');
  assert.equal(maskZipCode('01310'), '01310');
  assert.equal(maskZipCode('013101'), '01310-1');
  assert.equal(maskZipCode('01310100'), '01310-100');
  assert.equal(maskZipCode('01310-100'), '01310-100');
  assert.equal(maskZipCode('01310-10099'), '01310-100');
  assert.equal(maskZipCode('cep 01310 100'), '01310-100');
});

test('formata o CEP', () => {
  assert.equal(formatZipCode('01310100'), '01310-100');
  assert.equal(formatZipCode('01310-100'), '01310-100');
});
