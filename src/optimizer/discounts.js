// Percentuais de desconto de um plano. Tudo é calculado só sobre os jogos, porque nem o
// desconto à vista nem o cupom se aplicam ao frete.

const sumItems = (plan, read) => plan.carts
  .flatMap((cart) => cart.items)
  .reduce((sum, item) => sum + read(item), 0);

export function discountPercent(full, paid) {
  if (!(full > 0) || !(paid < full)) return 0;
  return Math.round((1 - paid / full) * 1000) / 10;
}

export function formatPercent(value) {
  return `${String(value).replace('.', ',')}%`;
}

export function summarizeDiscounts(plan, paymentMode) {
  const list = sumItems(plan, (item) => item.listPrice ?? item.price);
  const cash = sumItems(plan, (item) => item.price);
  const beforeCoupon = paymentMode === 'installment' ? list : cash;

  return {
    cash: discountPercent(list, cash),
    coupon: discountPercent(beforeCoupon, plan.productsTotal),
    combined: discountPercent(list, plan.cashTotal - plan.freightTotal),
  };
}
