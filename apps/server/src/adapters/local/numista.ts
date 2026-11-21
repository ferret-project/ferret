/**
 * Numista (numista.com): coins by words, issuer (country) and year; a coin's issues (years and mints) and their
 * prices by grade in any currency. Needs the server admin's free key (`Numista-API-Key`; the free allowance is
 * monthly, which is why lib/collectibles.ts keeps what it says). Plain fetch; only the words searched are sent.
 */
import type { CoinIssue, CoinIssuer, CollectibleInfo, CollectiblePrice } from "@ferret/shared";
import { coinGrades } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type CollectibleCatalog } from "../../ports";

const API = "https://api.numista.com/v3";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";

type Brief = {
  id: number;
  title: string;
  category?: string;
  object_type?: { name?: string };
  issuer?: { code?: string; name?: string };
  min_year?: number | null;
  max_year?: number | null;
  obverse_thumbnail?: string | null;
  reverse_thumbnail?: string | null;
};
type Side = { picture?: string | null; thumbnail?: string | null; picture_copyright?: string | null };
type Type = Brief & {
  url?: string;
  value?: { text?: string | null };
  composition?: { text?: string | null };
  size?: number | null;
  obverse?: Side;
  reverse?: Side;
};
type Issue = { id: number; is_dated?: boolean; year?: number | null; gregorian_year?: number | null; mint_letter?: string | null; mintage?: number | null; comment?: string | null };

const https = (url: string | null | undefined) => (url?.startsWith("https://") ? url : null);

export function toCoin(t: Brief | Type): CollectibleInfo {
  const full = t as Type;
  return {
    kind: "coin",
    id: String(t.id),
    name: t.title,
    year: t.min_year ?? null,
    yearTo: t.max_year != null && t.max_year !== t.min_year ? t.max_year : null,
    issuer: t.issuer?.name ?? null,
    coinType: t.object_type?.name ?? null,
    denomination: full.value?.text?.trim() || null,
    composition: full.composition?.text?.trim() || null,
    diameterMm: full.size ?? null,
    image: https(full.obverse?.thumbnail ?? t.obverse_thumbnail),
    imageLarge: https(full.obverse?.picture ?? full.obverse?.thumbnail ?? t.obverse_thumbnail),
    imageBack: https(full.reverse?.thumbnail ?? t.reverse_thumbnail),
    pictureBy: full.obverse?.picture_copyright ?? null,
    url: `https://en.numista.com/${t.id}`,
  };
}

/** "1965", "1968 D", "1965 · SMS (Special Mint Set)", "Undated". */
export function issueLabel(i: Issue) {
  const year = i.is_dated === false ? "Undated" : String(i.year ?? i.gregorian_year ?? "?");
  return [[year, i.mint_letter].filter(Boolean).join(" "), i.comment].filter(Boolean).join(" · ");
}

export const toIssue = (i: Issue): CoinIssue => ({ id: String(i.id), year: i.gregorian_year ?? i.year ?? null, label: issueLabel(i), mintage: i.mintage ?? null });

export class NumistaCoins implements CollectibleCatalog {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async json<T>(key: string, path: string, params: Record<string, string> = {}): Promise<T | null> {
    const res = await this.fetcher(`${API}${path}?${new URLSearchParams({ lang: "en", ...params })}`, {
      headers: { Accept: "application/json", "Numista-API-Key": key, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) throw new CatalogKeyError("Numista refused the key");
    if (res.status === 429) throw new CatalogLimitError("Numista: this month's allowance is used up");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Numista: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async check(key: string) {
    try {
      return Boolean(await this.json(key, "/types/55"));
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async find(key: string, q: { text: string; issuer?: string | null; year?: number | null }) {
    const params: Record<string, string> = { category: "coin", count: "50" };
    if (q.text.trim()) params.q = q.text.trim();
    if (q.issuer) params.issuer = q.issuer;
    if (q.year != null) params.year = String(q.year);
    if (!params.q && !params.issuer) return [];
    const got = await this.json<{ types?: Brief[] }>(key, "/types", params);
    return (got?.types ?? []).map(toCoin);
  }

  async get(key: string, id: string) {
    if (!/^\d+$/.test(id)) return null;
    const [type, issues] = await Promise.all([this.json<Type>(key, `/types/${id}`), this.json<Issue[]>(key, `/types/${id}/issues`)]);
    if (!type?.id) return null;
    return { ...toCoin(type), issues: (issues ?? []).map(toIssue) };
  }

  async prices(key: string, id: string, issue: string, currency: string): Promise<CollectiblePrice[]> {
    if (!/^\d+$/.test(id) || !/^\d+$/.test(issue)) return [];
    const got = await this.json<{ currency?: string; prices?: { grade: string; price: number }[] }>(key, `/types/${id}/issues/${issue}/prices`, { currency });
    const grades = new Set<string>(coinGrades);
    return (got?.prices ?? [])
      .filter((p) => grades.has(p.grade) && typeof p.price === "number" && p.price > 0)
      .map((p) => ({ grade: p.grade as CollectiblePrice["grade"], cents: Math.round(p.price * 100), currency: got?.currency ?? currency, source: "Numista" }));
  }

  async issuers(key: string): Promise<CoinIssuer[]> {
    const got = await this.json<{ issuers?: { code: string; name: string; level?: number; parent?: { name?: string } }[] }>(key, "/issuers");
    // Countries and their first parts (a country's own coinage is often one level down, e.g. the US Mint's).
    return (got?.issuers ?? []).filter((i) => (i.level ?? 1) <= 2).map((i) => ({ code: i.code, name: i.name, ...(i.parent?.name ? { parent: i.parent.name } : {}) }));
  }
}
