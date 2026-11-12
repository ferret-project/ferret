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

/** Amazon's stores, for the household's choice (Settings → Household). */
export const AMAZON_SITES = [
  { site: "www.amazon.com", country: "United States" },
  { site: "www.amazon.ca", country: "Canada" },
  { site: "www.amazon.com.mx", country: "Mexico" },
  { site: "www.amazon.com.br", country: "Brazil" },
  { site: "www.amazon.co.uk", country: "United Kingdom" },
  { site: "www.amazon.ie", country: "Ireland" },
  { site: "www.amazon.de", country: "Germany" },
  { site: "www.amazon.fr", country: "France" },
  { site: "www.amazon.it", country: "Italy" },
  { site: "www.amazon.es", country: "Spain" },
  { site: "www.amazon.nl", country: "Netherlands" },
  { site: "www.amazon.com.be", country: "Belgium" },
  { site: "www.amazon.se", country: "Sweden" },
  { site: "www.amazon.pl", country: "Poland" },
  { site: "www.amazon.com.tr", country: "Türkiye" },
  { site: "www.amazon.ae", country: "United Arab Emirates" },
  { site: "www.amazon.sa", country: "Saudi Arabia" },
  { site: "www.amazon.eg", country: "Egypt" },
  { site: "www.amazon.co.za", country: "South Africa" },
  { site: "www.amazon.in", country: "India" },
  { site: "www.amazon.co.jp", country: "Japan" },
  { site: "www.amazon.sg", country: "Singapore" },
  { site: "www.amazon.com.au", country: "Australia" },
] as const;
export type AmazonSite = (typeof AMAZON_SITES)[number]["site"];
export const isAmazonSite = (site: string): site is AmazonSite => AMAZON_SITES.some((s) => s.site === site);

const zones = (site: AmazonSite, names: string) => names.split(" ").map((z) => [z, site] as const);
/** Time zones that say which country a household is in (most of a continent's are someone else's; those fall to currency). */
const SITE_BY_ZONE = new Map<string, AmazonSite>([
  ...zones("www.amazon.ca", "America/Toronto America/Montreal America/Vancouver America/Edmonton America/Winnipeg America/Regina America/Halifax America/St_Johns America/Moncton America/Glace_Bay America/Goose_Bay America/Whitehorse America/Dawson America/Yellowknife America/Iqaluit America/Inuvik America/Cambridge_Bay America/Rankin_Inlet America/Resolute America/Swift_Current America/Dawson_Creek America/Fort_Nelson America/Creston America/Atikokan America/Blanc-Sablon America/Thunder_Bay America/Nipigon America/Rainy_River"),
  ...zones("www.amazon.com.mx", "America/Mexico_City America/Cancun America/Merida America/Monterrey America/Matamoros America/Chihuahua America/Ciudad_Juarez America/Ojinaga America/Mazatlan America/Bahia_Banderas America/Hermosillo America/Tijuana"),
  ...zones("www.amazon.com.br", "America/Sao_Paulo America/Bahia America/Fortaleza America/Recife America/Belem America/Manaus America/Cuiaba America/Campo_Grande America/Porto_Velho America/Boa_Vista America/Rio_Branco America/Eirunepe America/Araguaina America/Maceio America/Santarem America/Noronha"),
  ...zones("www.amazon.co.uk", "Europe/London Europe/Belfast Europe/Guernsey Europe/Jersey Europe/Isle_of_Man"),
  ...zones("www.amazon.ie", "Europe/Dublin"),
  ...zones("www.amazon.de", "Europe/Berlin Europe/Busingen Europe/Vienna Europe/Zurich Europe/Vaduz"),
  ...zones("www.amazon.fr", "Europe/Paris Europe/Monaco Europe/Luxembourg"),
  ...zones("www.amazon.it", "Europe/Rome Europe/Vatican Europe/San_Marino"),
  ...zones("www.amazon.es", "Europe/Madrid Atlantic/Canary Africa/Ceuta Europe/Lisbon Atlantic/Madeira Atlantic/Azores"),
  ...zones("www.amazon.nl", "Europe/Amsterdam"),
  ...zones("www.amazon.com.be", "Europe/Brussels"),
  ...zones("www.amazon.se", "Europe/Stockholm"),
  ...zones("www.amazon.pl", "Europe/Warsaw"),
  ...zones("www.amazon.com.tr", "Europe/Istanbul Asia/Istanbul"),
  ...zones("www.amazon.ae", "Asia/Dubai"),
  ...zones("www.amazon.sa", "Asia/Riyadh"),
  ...zones("www.amazon.eg", "Africa/Cairo"),
  ...zones("www.amazon.co.za", "Africa/Johannesburg"),
  ...zones("www.amazon.in", "Asia/Kolkata Asia/Calcutta"),
  ...zones("www.amazon.co.jp", "Asia/Tokyo"),
  ...zones("www.amazon.sg", "Asia/Singapore"),
]);
/** And currencies, when the zone doesn't say (euros → .de, the largest). */
const SITE_BY_CURRENCY: Record<string, AmazonSite> = {
  USD: "www.amazon.com", CAD: "www.amazon.ca", MXN: "www.amazon.com.mx", BRL: "www.amazon.com.br", GBP: "www.amazon.co.uk",
  EUR: "www.amazon.de", SEK: "www.amazon.se", PLN: "www.amazon.pl", TRY: "www.amazon.com.tr", AED: "www.amazon.ae",
  SAR: "www.amazon.sa", EGP: "www.amazon.eg", ZAR: "www.amazon.co.za", INR: "www.amazon.in", JPY: "www.amazon.co.jp",
  SGD: "www.amazon.sg", AUD: "www.amazon.com.au",
};

/**
 * Which Amazon a household buys from: the one it chose (Settings → Household), else where its time zone is, else its
 * currency's, else amazon.com.
 */
export function amazonSiteFor(h: { chosen?: string | null; timeZone?: string | null; currency?: string | null }): AmazonSite {
  if (h.chosen && isAmazonSite(h.chosen)) return h.chosen;
  const zone = h.timeZone ?? "";
  return SITE_BY_ZONE.get(zone) ?? (zone.startsWith("Australia/") ? "www.amazon.com.au" : undefined) ?? SITE_BY_CURRENCY[h.currency ?? ""] ?? "www.amazon.com";
}

/**
 * Until a thing has an Amazon product link (then it's "Add to cart"): a search on Amazon for it — its part or model
 * number with the brand ("JET 717531"), else its barcode, else its name. Only those words go to Amazon, when the person
 * opens it.
 */
export function amazonSearchUrl(thing: { name: string; brand?: string | null; model?: string | null; barcode?: string | null }, site: string) {
  const model = thing.model?.trim();
  const brand = thing.brand?.trim();
  const query = model ? (brand && !model.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${model}` : model) : thing.barcode?.trim() || thing.name.trim();
  if (!query) return null;
  return `https://${site}/s?k=${encodeURIComponent(query)}`;
}
