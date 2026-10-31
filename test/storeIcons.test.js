import assert from 'node:assert/strict';
import test from 'node:test';
import { findFavicon, loadStoreIcons } from '../src/catalog/storeIcons.js';

const PAGE = 'https://loja.com/produtos/ruins/';

test('lê o favicon declarado e resolve endereço relativo', () => {
  assert.equal(findFavicon('<link rel="icon" href="/img/fav.png">', PAGE), 'https://loja.com/img/fav.png');
  assert.equal(findFavicon('<link href="//cdn.com/f.ico" rel="shortcut icon" />', PAGE), 'https://cdn.com/f.ico');
  assert.equal(findFavicon("<LINK REL='icon' HREF='https://cdn.com/a.png?x=1&amp;y=2'>", PAGE), 'https://cdn.com/a.png?x=1&y=2');
});

test('ignora links que não são favicon', () => {
  const html = '<link rel="stylesheet" href="/a.css"><link rel="mask-icon" href="/m.svg"><link rel="icon" href="/f.png">';
  assert.equal(findFavicon(html, PAGE), 'https://loja.com/f.png');
});

test('sem favicon declarado usa o endereço padrão', () => {
  assert.equal(findFavicon('<html></html>', PAGE), 'https://loja.com/favicon.ico');
});

const offer = (storeId, url) => ({ storeId, url });

test('lê cada loja uma vez e reaproveita o que já conhece', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { url, text: async () => '<link rel="icon" href="/f.png">' };
  };
  const icons = await loadStoreIcons(
    [offer('a', 'https://a.com/1'), offer('a', 'https://a.com/2'), offer('b', 'https://b.com/1')],
    { b: 'https://b.com/antigo.png' },
    fetchImpl,
  );
  assert.deepEqual(icons, { b: 'https://b.com/antigo.png', a: 'https://a.com/f.png' });
  assert.equal(urls.length, 1);
});

test('site só manual não recebe requisição', async () => {
  const icons = await loadStoreIcons(
    [offer('amazon', 'https://www.amazon.com.br/dp/X'), offer('ml', 'https://www.mercadolivre.com.br/p/X')],
    {},
    async () => { throw new Error('não deveria acessar'); },
  );
  assert.deepEqual(icons, {});
});

test('falha ao ler a loja não derruba as outras', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('quebrada')) throw new Error('timeout');
    return { url, text: async () => '' };
  };
  const icons = await loadStoreIcons([offer('q', 'https://quebrada.com/1'), offer('b', 'https://b.com/1')], {}, fetchImpl);
  assert.deepEqual(icons, { b: 'https://b.com/favicon.ico' });
});
