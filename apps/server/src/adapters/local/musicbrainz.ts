/**
 * MusicBrainz (musicbrainz.org, the MetaBrainz Foundation's — its data is CC0): a CD's or record's barcode → the
 * release (album, artist, label, year, format), and its cover from the Cover Art Archive. No key, plain fetch, only
 * the barcode is sent. MusicBrainz asks for at most one request a second and a User-Agent saying who's asking, so
 * calls wait their turn here.
 *
 * A music barcode looks like any other UPC/EAN, so this is asked only when someone scans as music ("Scan music").
 */
import type { ProductInfo } from "@ferret/shared";
import type { ProductLookup } from "../../ports";

const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
/** A little over MusicBrainz's one a second. */
const GAP_MS = 1100;
/** After a 503, wait this long (then twice as long) before asking again. */
const RETRY_MS = 2000;

type Release = {
  id: string;
  title?: string;
  score?: number;
  date?: string;
  country?: string;
  barcode?: string | null;
  status?: string;
  "artist-credit"?: { name?: string; joinphrase?: string | null }[];
  "label-info"?: { label?: { name?: string } | null }[];
  media?: { format?: string | null; "track-count"?: number }[];
  "release-group"?: { id?: string; "primary-type"?: string | null };
};

/** "2×CD", "Vinyl", "CD + DVD". */
export function formatOf(media: Release["media"]) {
  const counts = new Map<string, number>();
  for (const m of media ?? []) {
    const f = m.format?.trim();
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts].map(([f, n]) => (n > 1 ? `${n}×${f}` : f)).join(" + ");
}

/**
 * The release to offer: its barcode exactly this one, official before bootlegs, then the earliest (MusicBrainz's own
 * order isn't stable between asks, and pressings sharing a barcode differ only in country or label).
 */
export function pickRelease(releases: Release[], code: string): Release | undefined {
  const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const want = digits(code);
  const exact = releases.filter((r) => r.title?.trim() && digits(r.barcode) === want);
  const rank = (r: Release) => [r.status === "Official" ? 0 : 1, r.date || "9999", r.id] as const;
  return exact.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]);
  })[0];
}

export function toProduct(code: string, r: Release, cover: string | null): ProductInfo {
  const artist = (r["artist-credit"] ?? []).map((a) => `${a.name ?? ""}${a.joinphrase ?? ""}`).join("").trim();
  const label = r["label-info"]?.map((l) => l.label?.name?.trim()).find(Boolean);
  const year = r.date?.slice(0, 4);
  const about = [formatOf(r.media) || null, year || null, label || null, r.country || null].filter(Boolean).join(" · ");
  return {
    barcode: code,
    title: r.title!.trim(),
    ...(artist ? { brand: artist } : {}),
    ...(about ? { description: about } : {}),
    category: "Music",
    images: cover ? [cover] : [],
    source: "MusicBrainz",
    kind: "music",
  };
}

export class MusicBrainzReleases implements ProductLookup {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  /** One MusicBrainz call at a time, a second or so apart. */
  private turn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.last + GAP_MS - Date.now();
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

  async lookup(code: string): Promise<ProductInfo | null> {
    // A placeholder barcode (all or nearly all zeros) would match whatever someone typed in for a release without one.
    if (code.replace(/^0+/, "").length < 6) return null;
    // MusicBrainz keeps barcodes as printed: a UPC-A's 12 digits, or 13 for an EAN. Ask for both spellings.
    const short = code.replace(/^0+(?=\d{12}$)/, "");
    const spellings = [...new Set([code, short])].join(" OR ");
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(`barcode:(${spellings})`)}&fmt=json&limit=25`;
    const ask = () => this.turn(() => this.fetcher(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) }));
    let res = await ask();
    // 503: MusicBrainz is busy, or we asked too soon after someone else on this address — wait and try again.
    for (let i = 1; res.status === 503 && i <= 2; i++) {
      await new Promise((r) => setTimeout(r, RETRY_MS * i));
      res = await ask();
    }
    if (!res.ok) throw new Error(`MusicBrainz: HTTP ${res.status}`);
    const body = (await res.json()) as { releases?: Release[] };
    const release = pickRelease(body.releases ?? [], code);
    if (!release) return null;
    return toProduct(code, release, await this.cover(release));
  }

  /** The release's own front cover, else its album's (most pressings have none of their own). Null when neither. */
  private async cover(r: Release): Promise<string | null> {
    const tries = [`https://coverartarchive.org/release/${r.id}/front-500`, r["release-group"]?.id && `https://coverartarchive.org/release-group/${r["release-group"].id}/front-500`];
    for (const url of tries) {
      if (!url) continue;
      try {
        const res = await this.fetcher(url, { method: "HEAD", redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
        if (res.status >= 300 && res.status < 400) return url; // the archive answers with a redirect to the picture
        if (res.ok) return url;
      } catch {
        // No cover is fine.
      }
    }
    return null;
  }
}
