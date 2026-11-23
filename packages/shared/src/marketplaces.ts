/**
 * Listings on secondhand marketplaces among a thing's links — someone's own listing when they're selling it (a link
 * marked `selling`), so the app can name it ("Your eBay listing") and say it's already listed. Only eBay's listings are
 * ever looked up (with the server's eBay keys, lib/market.ts); the rest are just links. Without URL, which this
 * package's types don't have.
 */

/** Marketplaces whose listing pages Ferret recognises: brand names, shown as they are. */
const SITES: { name: string; host: RegExp; path: RegExp }[] = [
  { name: "eBay", host: /^(?:www\.|m\.|befr\.|benl\.)?ebay\.(?:com|ca|co\.uk|ie|de|fr|it|es|nl|be|pl|at|ch|com\.au|com\.sg|com\.my|ph|in)$/, path: /^\/itm\/(?:[^/]+\/)?\d{9,15}(?:\/|$)/ },
  { name: "Facebook Marketplace", host: /^(?:www\.|m\.|web\.)?facebook\.com$/, path: /^\/marketplace\/item\/\d+/ },
  { name: "Craigslist", host: /^(?:[a-z0-9-]+\.)?craigslist\.org$/, path: /\/\d{6,}\.html$/ },
  { name: "OfferUp", host: /^(?:www\.)?offerup\.com$/, path: /^\/item\/detail\// },
  { name: "Mercari", host: /^(?:www\.)?mercari\.com$/, path: /^\/(?:[a-z]{2}\/)?item\// },
  { name: "Poshmark", host: /^(?:www\.)?poshmark\.(?:com|ca)$/, path: /^\/listing\// },
  { name: "Kijiji", host: /^(?:www\.)?kijiji\.ca$/, path: /^\/v-/ },
  { name: "Gumtree", host: /^(?:www\.)?gumtree\.(?:com|com\.au)$/, path: /^\/(?:p|s-ad)\// },
  { name: "Vinted", host: /^(?:www\.)?vinted\.[a-z.]{2,6}$/, path: /^\/items\// },
];

function parts(url: string) {
  const m = /^https?:\/\/([^/?#:@]+)(\/[^?#]*)?/i.exec(url.trim());
  return m ? { host: m[1]!.toLowerCase(), path: m[2] ?? "/" } : null;
}

/** The marketplace a link is a listing page on ("eBay", "Facebook Marketplace"…), or null. */
export function marketplaceOf(url: string): string | null {
  const p = parts(url);
  return (p && SITES.find((s) => s.host.test(p.host) && s.path.test(p.path))?.name) ?? null;
}

/** An eBay listing page's item number and site ("www.ebay.co.uk"), or null. */
export function ebayListing(url: string): { itemId: string; site: string } | null {
  if (marketplaceOf(url) !== "eBay") return null;
  const p = parts(url)!;
  const itemId = /^\/itm\/(?:[^/]+\/)?(\d{9,15})/.exec(p.path)![1]!;
  return { itemId, site: p.host.startsWith("www.") ? p.host : `www.${p.host.replace(/^m\./, "")}` };
}

/** The links someone marked as their own listing, with the marketplace each is on (null: a site Ferret doesn't know). */
export const sellingLinksOf = <T extends { url: string; selling?: boolean | null }>(links: T[] | null | undefined) =>
  (links ?? []).filter((l) => l.selling).map((l) => ({ ...l, marketplace: marketplaceOf(l.url) }));
