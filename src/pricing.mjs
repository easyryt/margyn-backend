export const money = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
export const paise = (value) => Math.round(Number(value) * 100);
export function unitPrice(product, quantity) {
  const tiers = [...(product.tiers || [])].sort(
    (a, b) => a.minCartons - b.minCartons,
  );
  return (
    tiers.filter((tier) => quantity >= tier.minCartons).at(-1)?.price ??
    product.price
  );
}
export function linePrice(product, quantity) {
  const unit = paise(unitPrice(product, quantity));
  const subtotal = unit * product.packSize * quantity;
  const tax = Math.round((subtotal * product.gstRate) / 100);
  return {
    unitPrice: unit / 100,
    subtotal: subtotal / 100,
    tax: tax / 100,
    total: (subtotal + tax) / 100,
  };
}
export function priceRange(product) {
  const prices = [
    product.price,
    ...(product.tiers || []).map((tier) => tier.price),
  ];
  const low = Math.min(...prices),
    high = Math.max(...prices);
  return low === high ? money(low) : `${money(low)} – ${money(high)}`;
}
