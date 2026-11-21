/**
 * Discogs (discogs.com): records, CDs and tapes — the exact pressing by barcode, or by artist and title — with the
 * cover, label, country and format, and marketplace prices: the suggested price for each condition, and the lowest
 * price for sale now. Needs the server admin's free personal access token. Plain fetch; Discogs allows 60 requests a
 * minute, so calls wait their turn here. Only the words or barcode searched are sent.
 */
import type { CollectibleInfo, CollectiblePrice } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type CollectibleCatalog } from "../../ports";

const API = "https://api.discogs.com";
const USER_AGENT = "Ferret/1 +https://github.com/ferret-project/ferret";
const GAP_MS = 1100;
/** Discogs' conditions, best first (its own words: Goldmine's grading). */
export const RECORD_CONDITIONS = ["Mint (M)", "Near Mint (NM or M-)", "Very Good Plus (VG+)", "Very Good (VG)", "Good Plus (G+)", "Good (G)", "Fair (F)", "Poor (P)"];

type Hit = { id: number; title: string; year?: string | number; country?: string; format?: string[]; label?: string[]; cover_image?: string; thumb?: string; uri?: string };
type Release = {
  id: number;
  title: string;
  year?: number;
  country?: string;
  released?: string;
  uri?: string;
  artists?: { name: string }[];
  labels?: { name: string; catno?: string }[];
  formats?: { name: string; qty?: string; descriptions?: string[] }[];
  images?: { uri?: string; uri150?: string; type?: string }[];
  genres?: string[];
  styles?: string[];
};

const https = (url: string | null | undefined) => (url?.startsWith("https://") ? url : null);
/** "Nirvana (2)" → "Nirvana": Discogs numbers artists who share a name. */
const artistName = (name: string) => name.replace(/\s\(\d+\)$/, "").trim();

/** A search hit: "Nirvana - Nevermind" with its formats, label and country. */
export function hitToRecord(h: Hit): CollectibleInfo {
  const [artist, ...rest] = h.title.split(" - ");
  const title = rest.length ? rest.join(" - ") : h.title;
  return {
    kind: "record",
    id: String(h.id),
    name: rest.length ? `${artistName(artist!)} – ${title}` : h.title,
    artist: rest.length ? artistName(artist!) : null,
    title,
    year: Number(h.year) || null,
    country: h.country ?? null,
    label: h.label?.[0] ?? null,
    formatText: h.format?.join(", ") ?? null,
    image: https(h.thumb) ?? https(h.cover_image),
    imageLarge: https(h.cover_image),
    url: `https://www.discogs.com/release/${h.id}`,
  };
}

export function toRecord(r: Release): CollectibleInfo {
  const artist = r.artists?.map((a) => artistName(a.name)).join(", ") || null;
  const front = r.images?.find((i) => i.type === "primary") ?? r.images?.[0];
  return {
    kind: "record",
    id: String(r.id),
    name: artist ? `${artist} – ${r.title}` : r.title,
    artist,
    title: r.title,
    year: r.year || null,
    country: r.country ?? null,
    label: r.labels?.[0] ? [r.labels[0].name, r.labels[0].catno && r.labels[0].catno !== "none" ? r.labels[0].catno : null].filter(Boolean).join(" ") : null,
    formatText: r.formats?.map((f) => [`${f.qty && f.qty !== "1" ? `${f.qty}×` : ""}${f.name}`, ...(f.descriptions ?? [])].join(", ")).join(" + ") ?? null,
    genres: [...(r.genres ?? []), ...(r.styles ?? [])].slice(0, 4),
    image: https(front?.uri150) ?? https(front?.uri),
    imageLarge: https(front?.uri),
    url: https(r.uri) ?? `https://www.discogs.com/release/${r.id}`,
  };
}

/** Official pressings before unofficial ones (bootlegs, CD-Rs): Discogs lists them all together. */
const officialFirst = (records: CollectibleInfo[]) => [...records.filter((r) => !/Unofficial/i.test(r.formatText ?? "")), ...records.filter((r) => /Unofficial/i.test(r.formatText ?? ""))];

export class DiscogsRecords implements CollectibleCatalog {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly gapMs = GAP_MS,
  ) {}

  private turn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await work();
      } finally {
        this.last = Date.now();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Null for 404; `{ refused }` when Discogs says this token can't ask (price suggestions before seller settings). */
  private json<T>(key: string, path: string, params: Record<string, string> = {}): Promise<T | null> {
    return this.turn(async () => {
      const query = new URLSearchParams(params).toString();
      const res = await this.fetcher(`${API}${path}${query ? `?${query}` : ""}`, {
        headers: { Accept: "application/json", Authorization: `Discogs token=${key}`, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401) throw new CatalogKeyError("Discogs refused the token");
      if (res.status === 429) throw new CatalogLimitError("Discogs: too many requests this minute");
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`Discogs: HTTP ${res.status}`);
      return (await res.json()) as T;
    });
  }

  async check(key: string) {
    try {
      return Boolean(await this.json(key, "/oauth/identity"));
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async get(key: string, id: string) {
    if (!/^\d+$/.test(id)) return null;
    const r = await this.json<Release>(key, `/releases/${id}`);
    return r?.id ? toRecord(r) : null;
  }

  async find(key: string, q: { text: string; year?: number | null }) {
    const text = q.text.trim();
    if (!text) return [];
    const digits = text.replace(/[\s-]/g, "");
    const params: Record<string, string> = { type: "release", per_page: "24", ...(/^\d{8,14}$/.test(digits) ? { barcode: digits } : { q: text }), ...(q.year ? { year: String(q.year) } : {}) };
    const got = await this.json<{ results?: Hit[] }>(key, "/database/search", params);
    return officialFirst((got?.results ?? []).map(hitToRecord));
  }

  /** The suggested price for each condition (once the token's account has saved seller settings), and the lowest for sale now. */
  async prices(key: string, id: string, _issue: string, currency: string): Promise<CollectiblePrice[]> {
    if (!/^\d+$/.test(id)) return [];
    const [suggested, stats] = await Promise.all([
      this.json<Record<string, { value?: number; currency?: string }> & { message?: string }>(key, `/marketplace/price_suggestions/${id}`).catch(() => null),
      this.json<{ num_for_sale?: number; lowest_price?: { value?: number; currency?: string } | null }>(key, `/marketplace/stats/${id}`, { curr_abbr: currency }),
    ]);
    const out: CollectiblePrice[] = [];
    // Suggestions come in the account's own currency: kept only when that's the household's.
    for (const condition of RECORD_CONDITIONS) {
      const p = suggested?.[condition];
      if (p?.value && p.value > 0 && p.currency === currency) out.push({ condition, cents: Math.round(p.value * 100), currency, source: "Discogs" });
    }
    const low = stats?.lowest_price;
    if (low?.value && low.value > 0) out.push({ lowest: true, forSale: stats?.num_for_sale ?? null, cents: Math.round(low.value * 100), currency: low.currency ?? currency, source: "Discogs" });
    return out;
  }
}
