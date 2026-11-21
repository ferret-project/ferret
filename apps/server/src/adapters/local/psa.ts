/**
 * PSA (psacard.com): a graded card by the certificate number on its slab — the card, its grade and population.
 * Needs the server admin's API token (sent as a Bearer token; PSA approves accounts for its API). Plain fetch; only
 * the certificate number is sent. PSA's API gives no prices.
 */
import type { GradedInfo } from "@ferret/shared";
import { CatalogKeyError, CatalogLimitError, type Grading } from "../../ports";

const API = "https://api.psacard.com/publicapi";

type Cert = {
  CertNumber?: string;
  Year?: string;
  Brand?: string;
  Category?: string;
  CardNumber?: string;
  Subject?: string;
  Variety?: string;
  CardGrade?: string;
  GradeDescription?: string;
  TotalPopulation?: number;
  PopulationHigher?: number;
};

export function toGraded(cert: string, c: Cert): GradedInfo | null {
  if (!c.Subject && !c.Brand) return null;
  const grade = c.CardGrade || c.GradeDescription;
  if (!grade) return null;
  return {
    by: "psa",
    cert: c.CertNumber || cert,
    name: [c.Year, c.Brand, c.Subject, c.CardNumber ? `#${c.CardNumber}` : null, c.Variety].filter(Boolean).join(" "),
    year: Number(c.Year) || null,
    grade: grade,
    population: c.TotalPopulation ?? null,
    popHigher: c.PopulationHigher ?? null,
    priceCents: null,
    image: null,
    url: `https://www.psacard.com/cert/${encodeURIComponent(c.CertNumber || cert)}`,
  };
}

export class PsaGrading implements Grading {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async cert(key: string, cert: string) {
    const res = await this.fetcher(`${API}/cert/GetByCertNumber/${encodeURIComponent(cert)}`, { headers: { Accept: "application/json", Authorization: `bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new CatalogKeyError("PSA refused the token (or hasn't approved it for its API yet)");
    if (res.status === 429) throw new CatalogLimitError("PSA: today's allowance is used up");
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`PSA: HTTP ${res.status}`);
    return ((await res.json()) as { PSACert?: Cert }).PSACert ?? null;
  }

  async check(key: string) {
    try {
      await this.cert(key, "00000000");
      return true;
    } catch (err) {
      if (err instanceof CatalogKeyError) return false;
      throw err;
    }
  }

  async byCert(key: string, cert: string) {
    const digits = cert.replace(/\D/g, "");
    if (digits.length < 5) return null;
    const c = await this.cert(key, digits);
    return c ? toGraded(digits, c) : null;
  }
}
