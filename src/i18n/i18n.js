// Idioma do painel: português para qualquer variante pt, inglês para os demais. Os preços
// continuam em reais, porque as lojas são brasileiras; muda só a formatação.

import { en, pt } from './messages.js';

const LOCALES = {
  pt: { messages: pt, tag: 'pt-BR' },
  en: { messages: en, tag: 'en-US' },
};

export function detectLocale(language = '') {
  return /^pt\b/i.test(language) ? 'pt' : 'en';
}

export function createTranslator(locale) {
  const { messages, tag } = LOCALES[locale];
  const t = (key, ...args) => {
    const message = messages[key];
    return typeof message === 'function' ? message(...args) : message;
  };

  return {
    tag,
    t,
    brl: (value) => value.toLocaleString(tag, { style: 'currency', currency: 'BRL' }),
    percent: (value) => `${value.toLocaleString(tag)}%`,
    month: (date) => messages.monthLabel(messages.months[Number(date.slice(5, 7)) - 1], date.slice(0, 4)),
  };
}

// Fora do painel a mensagem fica em português; o painel traduz pela chave.
export function localizedError(key, ...args) {
  const error = new Error(createTranslator('pt').t(key, ...args));
  error.i18n = [key, ...args];
  return error;
}
