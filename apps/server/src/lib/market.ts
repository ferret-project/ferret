/**
 * "On eBay now" (deps.marketListings, eBay's Browse API): on a thing's page and beside a drafted listing, what the same
 * thing is listed for on eBay right now — up to five listings and the range of asking prices — found by its barcode,
 * else its brand and model. On once the server admin saves an eBay keyset (Settings → Server). Only the barcode or
 * those words are sent, on the marketplace of the household's country (from its Amazon store's).
 *
 * eBay's API License Agreement shapes it: listings may be shown to help people browse eBay, kept apart from other
 * content, and no more than six hours old; eBay content must be deleted once it's no longer needed. So answers are kept
 * **in memory only**, for an hour (never in the database, so never in a backup or an export), and nothing is ever
 * written to a thing — no value, no price. Sold prices are a restricted API; these are asking prices, and say so.
 */
import type { ItemMarketListings, MarketListing, MarketListingsStatus, OwnMarketListing } from "@ferret/shared";
import { ebayListing } from "@ferret/shared/utils";
import { HTTPException } from "hono/http-exception";
import type { Db, Deps, MarketQuery } from "../ports";
import { householdAmazon } from "./household-time";
import { type Caller, getItem } from "./inventory";
import { savedKeyHints, saveServerKey } from "./server-keys";

export const EBAY_KEY = "market.ebay.key";
const FRESH_MS = 60 * 60 * 1000;
const KEEP_AT_MOST = 500;
/** Asked for (the range is over these); the card shows the first few. */
const ASK_FOR = 20;
const SHOW = 5;

/** Amazon store → eBay marketplace and site; anywhere else, eBay US. */
const MARKETS: Record<string, { id: string; site: string }> = {
  "www.amazon.ca": { id: "EBAY_CA", site: "www.ebay.ca" },
  "www.amazon.co.uk": { id: "EBAY_GB", site: "www.ebay.co.uk" },
  "www.amazon.ie": { id: "EBAY_IE", site: "www.ebay.ie" },
  "www.amazon.de": { id: "EBAY_DE", site: "www.ebay.de" },
  "www.amazon.fr": { id: "EBAY_FR", site: "www.ebay.fr" },
  "www.amazon.it": { id: "EBAY_IT", site: "www.ebay.it" },
  "www.amazon.es": { id: "EBAY_ES", site: "www.ebay.es" },
  "www.amazon.nl": { id: "EBAY_NL", site: "www.ebay.nl" },
  "www.amazon.com.be": { id: "EBAY_BE", site: "www.befr.ebay.be" },
  "www.amazon.pl": { id: "EBAY_PL", site: "www.ebay.pl" },
  "www.amazon.sg": { id: "EBAY_SG", site: "www.ebay.com.sg" },
  "www.amazon.com.au": { id: "EBAY_AU", site: "www.ebay.com.au" },
};
const US = { id: "EBAY_US", site: "www.ebay.com" };
export const marketFor = (amazonSite: string) => MARKETS[amazonSite] ?? US;

type Answer = { total: number; listings: MarketListing[]; at: number };
/** marketplace|gtin|words → eBay's answer. Memory only (see the top); the oldest go first past KEEP_AT_MOST. */
const kept = new Map<string, Answer>();

/** Forget every kept answer (new keys; tests). */
export function forgetMarketListings() {
  ownKept.clear();
  kept.clear();
}

export async function marketStatus(deps: Pick<Deps, "db" | "marketListings">): Promise<MarketListingsStatus> {
  return { available: Boolean(deps.marketListings), hint: (await savedKeyHints(deps.db, EBAY_KEY)).get(EBAY_KEY) ?? null };
}

async function hasKey(db: Db) {
  return (await savedKeyHints(db, EBAY_KEY)).size > 0;
}

/** Save the eBay keyset (checked with eBay first), or remove it with null. */
export async function setMarketKey(deps: Pick<Deps, "db" | "marketListings">, filesKey: string, key: string | null) {
  if (!deps.marketListings) throw new HTTPException(409, { message: "eBay listings aren't available on this server" });
  if (key != null) {
    if (key.trim().split(/\s+/).length !== 2) throw new HTTPException(422, { message: "Paste the App ID and the Cert ID with a space between them" });
    const ok = await deps.marketListings.check(key).catch(() => {
      throw new HTTPException(502, { message: "Couldn't reach eBay to check the keys — try again in a while" });
    });
    if (!ok) throw new HTTPException(422, { message: "eBay didn't accept those keys — copy the Production App ID and Cert ID again" });
  }
  await saveServerKey(deps.db, filesKey, EBAY_KEY, key);
  forgetMarketListings();
  return marketStatus(deps);
}

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

type Thing = { name: string; brand?: string | null; model?: string | null; barcode?: string | null };

/**
 * What to search eBay for: the barcode, and the brand with a model number (one with a digit — "DCD771", not "Classic",
 * which would match too much). A 13-digit code starting with 0 is sent as the 12-digit UPC-A eBay's US listings carry. Null words when there's no model number; null altogether when there's neither.
 */
export function marketQuery(thing: Thing): { gtin: string | null; words: string | null; model: string | null } | null {
  const code = (thing.barcode ?? "").replace(/[\s-]/g, "");
  const gtin = /^\d{13}$/.test(code) ? (code.startsWith("0") ? code.slice(1) : code) : /^\d{8}$|^\d{12}$|^\d{14}$/.test(code) ? code : null;
  const brand = thing.brand?.trim();
  const model = thing.model?.trim();
  const words = model && /\d/.test(model) && model.replace(/[^a-z0-9]/gi, "").length >= 3 ? (brand && !model.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${model}` : model) : null;
  return gtin || words ? { gtin, words, model: words ? squash(model!) : null } : null;
}

/** eBay's answer (from memory within the hour). `peek`: only from memory — undefined when eBay would have to be asked. */
async function ask(deps: Pick<Deps, "marketListings">, q: MarketQuery, peek = false): Promise<Answer | null | undefined> {
  const id = `${q.marketplace}|${q.gtin ?? ""}|${(q.text ?? "").toLowerCase()}`;
  const hit = kept.get(id);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit;
  if (peek) return undefined;
  const found = await deps.marketListings!.search(q);
  if (!found) return null;
  const answer = { ...found, at: Date.now() };
  kept.delete(id);
  kept.set(id, answer);
  while (kept.size > KEEP_AT_MOST) kept.delete(kept.keys().next().value!);
  return answer;
}

const ownKept = new Map<string, { own: OwnMarketListing; at: number }>();

/** Their own listing (a link marked `selling`), on the eBay its link is on — from memory within the hour, like the rest. */
async function ownListing(deps: Pick<Deps, "marketListings">, url: string, itemId: string, site: string): Promise<OwnMarketListing> {
  const id = `${site}|${itemId}`;
  const hit = ownKept.get(id);
  if (hit && Date.now() - hit.at < FRESH_MS) return { ...hit.own, url };
  const marketplace = Object.values(MARKETS).find((m) => m.site === site)?.id ?? "EBAY_US";
  try {
    const found = await deps.marketListings!.listing(itemId, marketplace);
    if (!found) return { url, status: "unavailable" };
    const at = Date.now();
    const own: OwnMarketListing =
      found.status === "gone" ? { url, status: "gone", checkedAt: new Date(at).toISOString() } : { url, status: "listed", ...(found.listing ? { listing: found.listing } : {}), checkedAt: new Date(at).toISOString() };
    ownKept.delete(id);
    ownKept.set(id, { own, at });
    while (ownKept.size > KEEP_AT_MOST) ownKept.delete(ownKept.keys().next().value!);
    return own;
  } catch {
    // Recorded by the service error log (watched).
    return { url, status: "unavailable" };
  }
}

/** The lowest and highest asking prices (postage left out) in the most common currency among the listings. */
function rangeOf(listings: MarketListing[]): ItemMarketListings["range"] {
  if (!listings.length) return null;
  const counts = new Map<string, number>();
  for (const l of listings) counts.set(l.currency, (counts.get(l.currency) ?? 0) + 1);
  const currency = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const prices = listings.filter((l) => l.currency === currency).map((l) => l.priceCents);
  return { lowCents: Math.min(...prices), highCents: Math.max(...prices), currency, of: prices.length };
}

/**
 * A thing's "On eBay now" card. eBay is asked inline (a person is waiting; it answers in about a second) — only when
 * they ask: with `askEbay` false (a thing's page opening) the answer comes from memory if someone checked within the
 * hour, else `ready` (there's something to search for; nothing was sent to eBay).
 */
export async function itemMarketListings(v: Caller, itemId: string, askEbay = true): Promise<ItemMarketListings> {
  const it = await getItem(v, itemId);
  if (!v.deps.marketListings || !(await hasKey(v.db))) return { status: "off" };
  // Their own listing is looked up even before Check eBay: it's theirs, and only its item number is sent.
  const link = (it.links ?? []).find((l) => l.selling && ebayListing(l.url));
  const mine = link ? ebayListing(link.url) : null;
  const own = link && mine ? { own: await ownListing(v.deps, link.url, mine.itemId, mine.site) } : {};
  if (it.isContainer || it.wanted) return { status: "none", ...own };
  const q = marketQuery(it);
  if (!q) return { status: "none", ...own };
  const market = marketFor((await householdAmazon(v.db, v.householdId)).site);
  try {
    let by: "barcode" | "words" = "barcode";
    const peek = !askEbay;
    let answer = q.gtin ? await ask(v.deps, { marketplace: market.id, gtin: q.gtin, limit: ASK_FOR }, peek) : null;
    if (answer === undefined) return { status: "ready", ...own };
    // Many listings carry no barcode: nothing by it → the brand and model.
    if (q.words && (!answer || answer.listings.length === 0)) {
      by = "words";
      answer = await ask(v.deps, { marketplace: market.id, text: q.words, limit: ASK_FOR }, peek);
      if (answer === undefined) return { status: "ready", ...own };
    }
    if (!answer) return { status: "off" };
    const query = by === "barcode" ? q.gtin! : q.words!;
    // eBay's word search is loose ("Makita XFD131" brings other Makita drills): by words, only titles with the model number.
    const close = by === "words" && q.model ? answer.listings.filter((l) => squash(l.title).includes(q.model!)) : answer.listings;
    // Their own listing isn't what others are asking.
    const listings = mine ? close.filter((l) => ebayListing(l.url)?.itemId !== mine.itemId) : close;
    return {
      ...own,
      status: "found",
      by,
      query,
      marketplace: market.id,
      total: answer.total,
      listings: listings.slice(0, SHOW),
      range: rangeOf(listings),
      searchUrl: `https://${market.site}/sch/i.html?_nkw=${encodeURIComponent(query)}`,
      checkedAt: new Date(answer.at).toISOString(),
    };
  } catch {
    // Recorded by the service error log (watched); the card says eBay didn't answer.
    return { status: "unavailable", ...own };
  }
}
