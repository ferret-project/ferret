/**
 * Buying again on Amazon: an item's Amazon product page (an imported order's "On Amazon" link, or one typed in) gives
 * its product (ASIN) and which Amazon it's on; Amazon's add-to-cart address puts one or several in the cart. Amazon asks
 * the person to sign in first if they aren't — nothing about them or Ferret is sent along.
 */

/** The Amazon product an address is a product page of — `site` is its host (www.amazon.com, amazon.co.uk…). */
export function amazonProduct(url: string): { site: string; asin: string } | null {
  // Scheme, host (no user, no port), path — without URL, which this package's types don't have.
  const m = /^https?:\/\/([^/?#:@]+)(\/[^?#]*)?(?:[?#]|$)/i.exec(url.trim());
  if (!m || !/^(www\.|smile\.)?amazon\.[a-z.]{2,6}$/i.test(m[1]!)) return null;
  const path = m[2] ?? "/";
  const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(path.endsWith("/") ? path : `${path}/`)?.[1];
  return asin ? { site: m[1]!.toLowerCase().replace(/^smile\./, "www."), asin: asin.toUpperCase() } : null;
}

/** The address that puts these in the cart on `site` (each at least 1). */
export function amazonCartUrl(site: string, lines: { asin: string; quantity: number }[]) {
  const query = lines.map((l, i) => `ASIN.${i + 1}=${encodeURIComponent(l.asin)}&Quantity.${i + 1}=${Math.max(1, Math.round(l.quantity))}`).join("&");
  return `https://${site}/gp/aws/cart/add.html?${query}`;
}

/** The first Amazon product among an item's links. */
export const amazonProductOf = (links: { url: string }[] | null | undefined) =>
  (links ?? []).map((l) => amazonProduct(l.url)).find((p) => p !== null) ?? null;

/** Which Amazon a household most likely buys from, by its currency (amazon.com when it's none of these; euros → .de). */
const SITE_BY_CURRENCY: Record<string, string> = {
  USD: "www.amazon.com",
  CAD: "www.amazon.ca",
  MXN: "www.amazon.com.mx",
  BRL: "www.amazon.com.br",
  GBP: "www.amazon.co.uk",
  EUR: "www.amazon.de",
  SEK: "www.amazon.se",
  PLN: "www.amazon.pl",
  TRY: "www.amazon.com.tr",
  AED: "www.amazon.ae",
  SAR: "www.amazon.sa",
  INR: "www.amazon.in",
  JPY: "www.amazon.co.jp",
  SGD: "www.amazon.sg",
  AUD: "www.amazon.com.au",
};

/**
 * Until a thing has an Amazon product link (then it's "Add to cart"): a search on Amazon for it — its part or model
 * number with the brand ("JET 717531"), else its barcode, else its name. Only those words go to Amazon, when the person
 * opens it.
 */
export function amazonSearchUrl(
  thing: { name: string; brand?: string | null; model?: string | null; barcode?: string | null },
  currency?: string | null,
) {
  const model = thing.model?.trim();
  const brand = thing.brand?.trim();
  const query = model ? (brand && !model.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${model}` : model) : thing.barcode?.trim() || thing.name.trim();
  if (!query) return null;
  return `https://${SITE_BY_CURRENCY[currency ?? ""] ?? "www.amazon.com"}/s?k=${encodeURIComponent(query)}`;
}
