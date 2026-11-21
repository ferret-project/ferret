/**
 * Comic Vine (comicvine.gamespot.com): comic issues by series and number, with the cover, publisher and cover date.
 * Needs the server admin's free key (sent as `api_key`, so addresses are never put in errors or logs); Comic Vine asks
 * for no more than one request a second, so calls wait their turn here. Only the words searched are sent.
 */
import type { CollectibleInfo } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type CollectibleCatalog } from "../../ports";

const API = "https://comicvine.gamespot.com/api";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
const GAP_MS = 1000;
const ISSUE_FIELDS = "id,name,issue_number,volume,cover_date,image,site_detail_url";

type Image = { small_url?: string; medium_url?: string; super_url?: string; original_url?: string };
type Issue = { id: number; name?: string | null; issue_number?: string | null; cover_date?: string | null; image?: Image | null; site_detail_url?: string | null; volume?: { id: number; name?: string } | null };
type Volume = { id: number; name?: string; start_year?: string | null; count_of_issues?: number | null; publisher?: { name?: string } | null };
type Reply<T> = { status_code: number; error?: string; results: T };

const https = (url: string | null | undefined) => (url?.startsWith("https://") ? url : null);

/** "Amazing Spider-Man 300", "Saga #1", "Batman (2016) 50", "X-Men 1.5": the series, its year if given, and the issue number. */
export function parseComicQuery(text: string): { series: string; year: number | null; number: string | null } {
  let rest = text.trim().replace(/\s+/g, " ");
  const num = rest.match(/\s#?(\d+(?:\.\d+)?[A-Za-z]?)$/) ?? rest.match(/^#(\d+(?:\.\d+)?[A-Za-z]?)$/);
  const number = num ? num[1]! : null;
  if (num) rest = rest.slice(0, num.index).trim();
  const y = rest.match(/\s?\((\d{4})\)$/);
  const year = y ? Number(y[1]) : null;
  if (y) rest = rest.slice(0, y.index).trim();
  return { series: rest, year, number };
}

export function toComic(i: Issue, publisher?: string | null): CollectibleInfo {
  const series = i.volume?.name ?? "";
  const number = i.issue_number ?? null;
  return {
    kind: "comic",
    id: String(i.id),
    name: [series, number ? `#${number}` : null].filter(Boolean).join(" ") || (i.name ?? ""),
    series: series || null,
    issueNumber: number,
    title: i.name?.trim() || null,
    publisher: publisher ?? null,
    coverDate: i.cover_date ?? null,
    year: i.cover_date ? Number(i.cover_date.slice(0, 4)) || null : null,
    image: https(i.image?.small_url ?? i.image?.medium_url),
    imageLarge: https(i.image?.super_url ?? i.image?.medium_url ?? i.image?.original_url),
    url: https(i.site_detail_url),
  };
}

export class ComicVineIssues implements CollectibleCatalog {
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

  private json<T>(key: string, path: string, params: Record<string, string>): Promise<T | null> {
    return this.turn(async () => {
      const res = await this.fetcher(`${API}${path}?${new URLSearchParams({ api_key: key, format: "json", ...params })}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => null)) as Reply<T> | null;
      if (res.status === 401 || body?.status_code === 100) throw new CatalogKeyError("Comic Vine refused the key");
      if (res.status === 420 || res.status === 429 || body?.status_code === 107) throw new CatalogLimitError("Comic Vine: too many requests this hour");
      if (res.status === 404 || body?.status_code === 101) return null;
      if (!res.ok || !body || body.status_code !== 1) throw new Error(`Comic Vine: HTTP ${res.status}${body?.error && body.error !== "OK" ? ` (${body.error})` : ""}`);
      return body.results;
    });
  }

  async check(key: string) {
    try {
      return (await this.json(key, "/types/", {})) != null;
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async get(key: string, id: string) {
    if (!/^\d+$/.test(id)) return null;
    const issue = await this.json<Issue>(key, `/issue/4000-${id}/`, { field_list: ISSUE_FIELDS });
    if (!issue?.id) return null;
    const volume = issue.volume?.id ? await this.json<Volume>(key, `/volume/4050-${issue.volume.id}/`, { field_list: "id,publisher" }).catch(() => null) : null;
    return toComic(issue, volume?.publisher?.name);
  }

  async find(key: string, q: { text: string }) {
    const { series, year, number } = parseComicQuery(q.text);
    if (!series) return [];
    if (!number) {
      const found = await this.json<Issue[]>(key, "/search/", { query: series, resources: "issue", limit: "20", field_list: ISSUE_FIELDS });
      return (found ?? []).map((i) => toComic(i));
    }
    // A series and an issue: the series that fit (the year it started, enough issues), then that issue of each.
    const volumes = ((await this.json<Volume[]>(key, "/search/", { query: series, resources: "volume", limit: "20", field_list: "id,name,start_year,count_of_issues,publisher" })) ?? [])
      .filter((v) => !year || Number(v.start_year) === year)
      .filter((v) => !/^\d+$/.test(number) || (v.count_of_issues ?? 0) >= Number(number))
      .slice(0, 10);
    if (!volumes.length) return [];
    const issues = (await this.json<Issue[]>(key, "/issues/", { filter: `volume:${volumes.map((v) => v.id).join("|")},issue_number:${number}`, field_list: ISSUE_FIELDS })) ?? [];
    const order = new Map(volumes.map((v, i) => [v.id, i]));
    return issues
      .sort((a, b) => (order.get(a.volume?.id ?? 0) ?? 99) - (order.get(b.volume?.id ?? 0) ?? 99))
      .map((i) => toComic(i, volumes.find((v) => v.id === i.volume?.id)?.publisher?.name));
  }
}
