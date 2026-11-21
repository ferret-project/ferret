/**
 * PCGS (pcgs.com): a graded coin by the certificate number on its slab — the coin, its grade, how many PCGS has graded
 * the same and higher, and PCGS's price guide for it. Needs the server admin's free API token (sent as a Bearer token).
 * Plain fetch; only the certificate number is sent.
 */
import type { GradedInfo } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type Grading } from "../../ports";

const API = "https://api.pcgs.com/publicapi";

type Facts = {
  PCGSNo?: string;
  CertNo?: string;
  Name?: string;
  Year?: number;
  Denomination?: string;
  MintMark?: string | null;
  Grade?: string;
  PriceGuideValue?: number | null;
  Population?: number | null;
  PopHigher?: number | null;
  CoinFactsLink?: string | null;
  Images?: ({ Url?: string; Fullsize?: string; Thumbnail?: string } | string)[] | null;
  IsValidRequest?: boolean;
  ServerMessage?: string;
};

const link = (s: string | null | undefined) => (s ? (s.startsWith("http") ? s.replace(/^http:/, "https:") : `https://${s}`) : null);

export function toGraded(cert: string, f: Facts): GradedInfo | null {
  if (!f.Name || !f.Grade) return null;
  const first = f.Images?.[0];
  const image = typeof first === "string" ? first : (first?.Fullsize ?? first?.Url ?? first?.Thumbnail ?? null);
  return {
    by: "pcgs",
    cert: f.CertNo || cert,
    // "1916-D STANDING 25C" — the year (and mint) when PCGS gives them apart from the name.
    name: f.Year ? `${f.Year}${f.MintMark ? `-${f.MintMark}` : ""} ${f.Name}` : f.Name,
    year: f.Year || null,
    grade: f.Grade,
    population: f.Population ?? null,
    popHigher: f.PopHigher ?? null,
    priceCents: f.PriceGuideValue && f.PriceGuideValue > 0 ? Math.round(f.PriceGuideValue * 100) : null,
    image: image?.startsWith("https://") ? image : null,
    url: link(f.CoinFactsLink) ?? `https://www.pcgs.com/cert/${encodeURIComponent(cert)}`,
  };
}

export class PcgsGrading implements Grading {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async json(key: string, path: string): Promise<Facts> {
    const res = await this.fetcher(`${API}${path}`, { headers: { Accept: "application/json", Authorization: `bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new CatalogKeyError("PCGS refused the token");
    if (res.status === 429) throw new CatalogLimitError("PCGS: today's allowance is used up");
    if (!res.ok) throw new Error(`PCGS: HTTP ${res.status}`);
    return (await res.json()) as Facts;
  }

  async check(key: string) {
    try {
      return (await this.json(key, "/coindetail/GetCoinFactsByGrade?PCGSNo=5703&GradeNo=65&PlusGrade=false")).IsValidRequest !== false;
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async byCert(key: string, cert: string) {
    const digits = cert.replace(/\D/g, "");
    if (digits.length < 5) return null;
    return toGraded(digits, await this.json(key, `/coindetail/GetCoinFactsByCertNo/${digits}`));
  }
}
