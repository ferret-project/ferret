/**
 * openFDA (open.fda.gov): the FDA's recall reports for food and medicine, asked for by the date they were reported —
 * a few requests a day for the whole server, well inside the keyless allowance. Nothing about anyone's things is sent:
 * lib/recalls.ts picks out their barcodes and matches them on this server. Plain fetch to a fixed address.
 */
import type { FdaRecalls, RawFdaRecall } from "../../ports";

const API = "https://api.fda.gov";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
const PAGE = 1000;
/** openFDA won't page past this many. */
const MAX_SKIP = 25_000;

export class OpenFdaRecalls implements FdaRecalls {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async reportedSince(kind: "food" | "drug", from: string, to: string): Promise<RawFdaRecall[]> {
    const out: RawFdaRecall[] = [];
    for (let skip = 0; skip <= MAX_SKIP; skip += PAGE) {
      // The range is built here from two dates, never from anything a person typed.
      const search = `report_date:[${from} TO ${to}]`;
      const res = await this.fetcher(`${API}/${kind}/enforcement.json?${new URLSearchParams({ search, limit: String(PAGE), skip: String(skip), sort: "report_date:asc" })}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
      // openFDA answers "no matches" with a 404.
      if (res.status === 404) break;
      if (!res.ok) throw new Error(`openFDA ${kind} recalls: HTTP ${res.status}`);
      const body = (await res.json()) as { results?: RawFdaRecall[]; meta?: { results?: { total?: number } } };
      const page = body.results ?? [];
      out.push(...page.map((r) => ({ ...r, kind })));
      if (page.length < PAGE || out.length >= (body.meta?.results?.total ?? 0)) break;
    }
    return out;
  }
}
