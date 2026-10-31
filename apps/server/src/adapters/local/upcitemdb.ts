/**
 * UPCitemdb (upcitemdb.com): barcode → product. The free tier needs no key and
 * allows 100 lookups a day; a paid key raises that.
 */
import type { ProductInfo, ProductLookup, ProductQuota } from "../../ports";

interface Offer {
  price?: number;
}
interface Item {
  title?: string;
  brand?: string;
  model?: string;
  description?: string;
  category?: string;
  images?: string[];
  offers?: Offer[];
  lowest_recorded_price?: number;
  highest_recorded_price?: number;
}

const cents = (dollars: number | undefined) => (dollars && dollars > 0 ? Math.round(dollars * 100) : undefined);
const text = (s: string | undefined) => s?.trim() || undefined;

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export class UpcItemDb implements ProductLookup {
  private last: ProductQuota | null = null;
  constructor(private readonly key?: string) {}

  /** From the last answer's X-RateLimit-* headers: the day's lookups (or, just after a burst, the minute's). */
  quota() {
    return this.last;
  }

  private remember(res: Response) {
    const n = (h: string) => Number(res.headers.get(h) ?? NaN);
    const limit = n("x-ratelimit-limit");
    const remaining = n("x-ratelimit-remaining");
    const reset = n("x-ratelimit-reset");
    if (Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.last = { limit, remaining, resetsAt: new Date(reset * 1000) };
    }
  }

  async lookup(barcode: string): Promise<ProductInfo | null> {
    const url = this.key
      ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${encodeURIComponent(barcode)}`
      : `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...(this.key ? { user_key: this.key, key_type: "3scale" } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    this.remember(res);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`UPCitemdb ${res.status}${res.status === 429 ? " (daily limit reached)" : ""}`);
    const body = (await res.json()) as { code?: string; items?: Item[] };
    const it = body.items?.[0];
    if (body.code !== "OK" || !it?.title) return null;
    const prices = (it.offers ?? []).map((o) => o.price ?? 0).filter((p) => p > 0);
    return {
      barcode,
      title: it.title.trim(),
      brand: text(it.brand),
      model: text(it.model),
      description: text(it.description)?.slice(0, 2000),
      category: text(it.category),
      images: (it.images ?? []).filter((u) => /^https:\/\//.test(u)).slice(0, 8),
      typicalPriceCents: cents(median(prices)),
      lowestPriceCents: cents(it.lowest_recorded_price),
      highestPriceCents: cents(it.highest_recorded_price),
      source: "UPCitemdb",
    };
  }
}
