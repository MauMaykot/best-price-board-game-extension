// Cotação de frete na Bravo Jogos (plataforma Simplo7), por HTTP e sem abrir aba.
//
// O carrinho não é usado de propósito: nesta plataforma, incluir um item reserva uma unidade
// do estoque real, e um carrinho abandonado deixa o produto esgotado para os outros clientes.
// A rota de frete aceita a lista de itens no corpo e dá o mesmo resultado do carrinho, com
// frete unificado e frete grátis por valor:
//   1. A página do produto informa o id do produto e do estoque.
//   2. POST /produto/combinacao/readDetalhamento/{id} devolve medidas, preço e disponibilidade.
//   3. POST /shipping/quote com product_only devolve as opções de envio dos itens juntos.

import { cheapest, formatZipCode, isDelivery } from './delivery.js';

const PLATFORM = /\.cdn\.simplo7\.net\//;
const PRODUCT_TITLE = /<h1 class="product-name"[^>]*\bdata-id="(\d+)"[^>]*\bdata-stock="(\d+)"/;

const readJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function parseProduct(html) {
  const match = PLATFORM.test(html) && html.match(PRODUCT_TITLE);
  return match ? { productId: match[1], stockId: match[2] } : null;
}

export function cheapestDelivery(response) {
  // A página trata entradas sem Id como grupos de opções, que nunca apareceram nesta loja.
  // Sem saber como os valores do grupo se somam, é melhor não cotar.
  if (!Array.isArray(response) || response.some((option) => option.Id === undefined)) return null;

  // A linha "Comprando mais R$ X o frete grátis estará disponível" vem na mesma lista, com
  // Valor nulo. Por isso parseFloat: Number(null) a transformaria em frete grátis.
  return cheapest(response
    .filter((option) => isDelivery(option.Nome))
    .map((option) => ({
      cost: parseFloat(option.Valor),
      service: option.Nome,
      ...(option.PrazoEntrega > 0 ? { maxDays: Number(option.PrazoEntrega) } : {}),
    }))
    .filter((delivery) => Number.isFinite(delivery.cost)));
}

// Os mesmos campos que a página do produto envia ao simular o frete.
const toQuoteItem = (detail) => ({
  produto_estoque_id: detail.id,
  produto_id: detail.produto_id,
  sku_produto: detail.sku,
  valor_unitario: detail.valor_venda_unitario,
  altura: detail.altura,
  largura: detail.largura,
  comprimento: detail.comprimento,
  peso: detail.peso,
  tempo_producao: detail.tempo_producao,
  estoque_disponivel: detail.estoque_disponivel,
  estoque_avancado: detail.estoque_avancado,
  estoque_situacao: detail.estoque_avancado_situacao,
  estoque_situacao_sem: detail.estoque_avancado_situacao_sem,
  frete_gratis: detail.frete_gratis,
  quantidade: 1,
  perguntas: [],
  parametros: [],
});

// Reserva estoque, então só roda quando o usuário pede para ir à loja, nunca ao cotar.
export async function addToCart(origin, products, session) {
  const body = new URLSearchParams({ CombinacaoAtributo: '[]', Pergunta: '[]', Lista: '0', Depois: '0' }).toString();
  for (const { productId } of products) {
    const { text } = await session.post(`${origin}/carrinhos/createProduct/${productId}/1`, body);
    if (readJson(text)?.produto_id !== productId) return null;
  }
  return `${origin}/carrinho`;
}

export async function applyCoupon(origin, code, session) {
  const { text } = await session.post(
    `${origin}/carrinhos/updateCoupon`,
    new URLSearchParams({ Cupom: JSON.stringify({ codigo: code }) }).toString(),
  );
  const result = readJson(text);
  return Boolean(result && !result.Errors && Object.keys(result.Cupom ?? {}).length > 0);
}

export async function quoteCart(origin, products, zipCode, session) {
  const items = [];
  for (const { productId, stockId } of products) {
    const { text } = await session.post(
      `${origin}/produto/combinacao/readDetalhamento/${productId}`,
      'CombinacaoAtributo=%5B%5D',
    );
    const detail = readJson(text);

    // Um item esgotado não poderia estar no carrinho, e cotar sem ele daria frete menor que o
    // real. Id diferente do da página, ou nulo em produto removido, também invalida a cotação.
    if (detail?.id !== stockId || detail.disponivel !== true) return null;
    items.push(toQuoteItem(detail));
  }

  // Sem product_only a rota ignora os itens enviados e lê o carrinho da sessão.
  const { text } = await session.post(`${origin}/shipping/quote`, new URLSearchParams({
    carrinho: JSON.stringify({ Item: items }),
    cep: JSON.stringify({ Cep: formatZipCode(zipCode) }),
    product_only: 'true',
  }).toString());
  return cheapestDelivery(readJson(text));
}
