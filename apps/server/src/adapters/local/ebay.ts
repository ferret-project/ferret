/**
 * eBay's Browse API: listings for sale now, by barcode (GTIN) or words, on one marketplace. The server admin's keyset
 * (an App ID and Cert ID, pasted with a space) gets an application token by OAuth's client credentials, kept until
 * shortly before it runs out. Only what's searched for is sent — nothing about anyone. Sellers' names are dropped here,
 * so nothing about eBay's users is ever kept. Plain fetch, so it runs on Workers too.
 */
import type { MarketListing } from "@ferret/shared";
import type { MarketListings, MarketQuery } from "../../ports";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const SCOPE = "https://api.ebay.com/oauth/api_scope";

type Money = { value?: string; currency?: string };
type Summary = {
  title?: string;
  price?: Money;
  currentBidPrice?: Money;
  bidCount?: number;
  buyingOptions?: string[];
  condition?: string;
  itemEndDate?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: { imageUrl?: string }[];
  itemWebUrl?: string;
  shippingOptions?: { shippingCostType?: string; shippingCost?: Money }[];
};

const cents = (m: Money | undefined) => {
  const n = Number(m?.value);
  return m?.value != null && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const https = (url: string | undefined) => (url && /^https:\/\//.test(url) ? url : null);

/** One summary as Ferret shows it; null when it lacks a price or a link. */
export function toListing(s: Summary): MarketListing | null {
  const auction = !s.buyingOptions?.includes("FIXED_PRICE") && Boolean(s.buyingOptions?.includes("AUCTION"));
  const money = auction ? (s.currentBidPrice ?? s.price) : (s.price ?? s.currentBidPrice);
  const priceCents = cents(money);
  const url = https(s.itemWebUrl);
  if (priceCents == null || !money?.currency || !url || !s.title) return null;
  const ship = s.shippingOptions?.[0];
  return {
    title: s.title.slice(0, 200),
    priceCents,
    currency: money.currency,
    shippingCents: ship?.shippingCostType === "FIXED" || ship?.shippingCost ? cents(ship.shippingCost) : null,
    condition: s.condition?.slice(0, 60) ?? null,
    buyingOption: auction ? "auction" : "fixed",
    bids: auction ? (s.bidCount ?? 0) : null,
    endsAt: auction ? (s.itemEndDate ?? null) : null,
    imageUrl: https(s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl),
    url,
  };
}

/** "APPID CERTID" (any whitespace between) → the Basic credentials, or null when it isn't two parts. */
function basic(key: string) {
  const [id, secret, ...rest] = key.trim().split(/\s+/);
  if (!id || !secret || rest.length) return null;
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

export class EbayListings implements MarketListings {
  private token: { key: string; value: string; until: number } | null = null;

  constructor(
    private readonly key: () => Promise<string | null>,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /** An application token for these keys; null when eBay refuses them. */
  private async newToken(key: string): Promise<{ value: string; until: number } | null> {
    const auth = basic(key);
    if (!auth) return null;
    const res = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    // invalid_client answers 401; a malformed or unknown one sometimes 400.
    if (res.status === 400 || res.status === 401) return null;
    if (!res.ok) throw new Error(`eBay token: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("eBay token: no access_token in the reply");
    // Two hours, usually; renewed five minutes early.
    return { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 7200) - 300) * 1000 };
  }

  private async tokenFor(key: string, fresh = false) {
    if (!fresh && this.token?.key === key && this.token.until > Date.now()) return this.token.value;
    const t = await this.newToken(key);
    if (!t) throw new Error("eBay refused the saved keys — check them in Settings → Server");
    this.token = { key, ...t };
    return t.value;
  }

  async check(key: string) {
    const t = await this.newToken(key);
    if (t) this.token = { key, ...t };
    return Boolean(t);
  }

  async search(q: MarketQuery) {
    const key = await this.key();
    if (!key) return null;
    const params = new URLSearchParams({ limit: String(Math.min(Math.max(q.limit, 1), 50)) });
    if (q.gtin) params.set("gtin", q.gtin);
    if (q.text) params.set("q", q.text.slice(0, 100));
    params.set("filter", "buyingOptions:{FIXED_PRICE|AUCTION}");
    const ask = async (fresh: boolean) =>
      this.fetcher(`${SEARCH_URL}?${params}`, {
        headers: { Authorization: `Bearer ${await this.tokenFor(key, fresh)}`, "X-EBAY-C-MARKETPLACE-ID": q.marketplace, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    let res = await ask(false);
    // A token eBay stopped taking early: once more with a new one.
    if (res.status === 401) res = await ask(true);
    if (!res.ok) throw new Error(`eBay search: HTTP ${res.status}`);
    const body = (await res.json()) as { total?: number; itemSummaries?: Summary[] };
    const listings = (body.itemSummaries ?? []).map(toListing).filter((l): l is MarketListing => l !== null);
    return { total: body.total ?? listings.length, listings };
  }
}
