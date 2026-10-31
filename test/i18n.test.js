import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTranslator, detectLocale, localizedError } from '../src/i18n/i18n.js';
import { en, pt } from '../src/i18n/messages.js';

test('escolhe o idioma pelo navegador', () => {
  assert.equal(detectLocale('pt-BR'), 'pt');
  assert.equal(detectLocale('pt-PT'), 'pt');
  assert.equal(detectLocale('PT'), 'pt');
  assert.equal(detectLocale('en-US'), 'en');
  assert.equal(detectLocale('es-AR'), 'en');
  assert.equal(detectLocale('pl'), 'en');
  assert.equal(detectLocale(undefined), 'en');
});

test('as duas tabelas têm as mesmas chaves e parâmetros', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  for (const key of Object.keys(pt)) {
    assert.equal(typeof en[key], typeof pt[key], key);
    if (typeof pt[key] === 'function') assert.equal(en[key].length, pt[key].length, key);
  }
});

test('toda chave usada no HTML existe', () => {
  const html = readFileSync(new URL('../panel/panel.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(([, key]) => key);
  assert.ok(keys.length > 20);
  for (const key of keys) assert.ok(key in pt, key);
});

test('toda chave usada no painel existe', () => {
  const source = readFileSync(new URL('../panel/panel.js', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map(([, key]) => key);
  assert.ok(keys.length > 40);
  for (const key of keys) assert.ok(key in pt, key);
});

test('formata valores conforme o idioma, sempre em reais', () => {
  const portuguese = createTranslator('pt');
  const english = createTranslator('en');
  assert.match(portuguese.brl(1234.5), /^R\$\s*1\.234,50$/);
  assert.match(english.brl(1234.5), /^R\$\s*1,234\.50$/);
  assert.equal(portuguese.percent(7.7), '7,7%');
  assert.equal(english.percent(7.7), '7.7%');
  assert.equal(portuguese.percent(10), '10%');
  assert.equal(portuguese.month('2026-02-15'), 'fev/2026');
  assert.equal(english.month('2026-02-15'), 'Feb 2026');
});

test('plural acompanha a quantidade', () => {
  const { t } = createTranslator('en');
  assert.equal(t('gameCount', 1), '1 game');
  assert.equal(t('gameCount', 2), '2 games');
  assert.equal(createTranslator('pt').t('quotesDone', 1), '1 cotação feita.');
});

test('erro compartilhado pode ser traduzido pelo painel', () => {
  const error = localizedError('gameNotFound', 'ruins');
  assert.equal(error.message, 'Jogo não encontrado: ruins.');
  assert.equal(createTranslator('en').t(...error.i18n), 'Game not found: ruins.');
});
