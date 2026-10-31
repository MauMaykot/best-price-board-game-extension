// Regras comuns às plataformas para decidir o que é entrega de verdade.

// Estas opções vêm na mesma lista com valor perto de zero, mas não são entrega: retirada
// exige ir à loja, "juntar ao pedido" exige um pedido já aberto e "a combinar" deixa o
// custo real por conta do comprador.
const NOT_A_DELIVERY = /retirada|retirar|pedido anterior|pedido existente|juntar|combinar/i;

// Os nomes vêm do cadastro das lojas, e um espaço não separável escaparia do filtro.
export function isDelivery(description) {
  return !NOT_A_DELIVERY.test(description.replace(/\s+/g, ' '));
}

export function cheapest(deliveries) {
  if (deliveries.length === 0) return null;
  return deliveries.reduce((best, delivery) => (delivery.cost < best.cost ? delivery : best));
}

// Para o campo do painel: formata enquanto o usuário digita, sem hífen sobrando no fim.
export function maskZipCode(text) {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

export function formatZipCode(zipCode) {
  const digits = zipCode.replace(/\D/g, '');
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}
