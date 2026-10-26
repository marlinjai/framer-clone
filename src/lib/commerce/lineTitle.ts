// src/lib/commerce/lineTitle.ts
//
// What a bought item is called, the same in the cart and on the receipt
// invoice: the product and its variant ("Stacking ring, 54 / Silver"), the
// product alone when its variant has no title of its own, and never an
// internal id. An invoice must name what was sold, so a variant title alone
// ("54 / Silver") is not enough.

export function lineTitle(
  productTitle: string | null | undefined,
  variantTitle: string | null | undefined,
  sku: string | null | undefined,
  fallback: string,
): string {
  const product = productTitle?.trim() || null;
  const variant = variantTitle?.trim() || null;
  if (product && variant && variant !== product) return `${product}, ${variant}`;
  return product ?? variant ?? (sku?.trim() || fallback);
}
