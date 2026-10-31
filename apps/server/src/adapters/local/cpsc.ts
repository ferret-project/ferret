/**
 * The CPSC's recall API (saferproducts.gov): public, no key. Asked per brand — recalls with it in their title, and
 * those it made — never for everything. Plain fetch to a fixed address.
 * (Its UPC search is ignored by the API — it answers with every recall — so it's never used.)
 */
import type { RawRecall, Recalls } from "../../ports";

const BASE = "https://www.saferproducts.gov/RestWebServices/Recall";

async function get(query: string): Promise<RawRecall[]> {
  const res = await fetch(`${BASE}?format=json&${query}`, {
    headers: { Accept: "application/json", "User-Agent": "Ferret home inventory (recall check)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`CPSC recalls: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("CPSC recalls: unexpected answer");
  // A filter the API didn't understand comes back as everything: never take that as an answer.
  if (body.length > 2000) throw new Error("CPSC recalls: the search wasn't applied");
  return body as RawRecall[];
}

export class CpscRecalls implements Recalls {
  async forBrand(brand: string) {
    const q = encodeURIComponent(brand);
    const [titled, made] = await Promise.all([get(`RecallTitle=${q}`), get(`Manufacturer=${q}`)]);
    const seen = new Set<number>();
    return [...titled, ...made].filter((r) => !seen.has(r.RecallID) && seen.add(r.RecallID));
  }
}
