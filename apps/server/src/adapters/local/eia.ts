/**
 * The US Energy Information Administration's open data (api.eia.gov): the average price homes pay for electricity in
 * each state, by year — to put an appliance's ENERGY STAR kWh in money. Needs the server admin's free key, which this
 * adapter is given a way to fetch (kept sealed — lib/server-keys.ts); without one it knows nothing. One request a month
 * for the whole server; nothing about anyone is sent.
 */
import type { ElectricityPrices } from "../../ports";

const API = "https://api.eia.gov/v2/electricity/retail-sales/data/";

type Row = { period: string; stateid: string; price: number | string | null };

export class EiaElectricity implements ElectricityPrices {
  constructor(
    private readonly key: () => Promise<string | null>,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private ask(key: string, length: number) {
    const q = new URLSearchParams({ api_key: key, frequency: "annual", "data[0]": "price", "facets[sectorid][]": "RES", "sort[0][column]": "period", "sort[0][direction]": "desc", length: String(length) });
    return this.fetcher(`${API}?${q}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  }

  async check(key: string) {
    const res = await this.ask(key, 1);
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) throw new Error(`EIA: HTTP ${res.status}`);
    return true;
  }

  async residential() {
    const key = await this.key();
    if (!key) return null;
    const res = await this.ask(key, 200);
    if (!res.ok) throw new Error(`EIA: HTTP ${res.status}`);
    const rows = ((await res.json()) as { response?: { data?: Row[] } }).response?.data ?? [];
    const year = rows[0]?.period;
    if (!year) return null;
    // The latest year only; states and the US average (two-letter ids — census regions like "MTN" are left out).
    const centsPerKwh: Record<string, number> = {};
    for (const r of rows) {
      const price = Number(r.price);
      if (r.period === year && /^[A-Z]{2}$/.test(r.stateid) && Number.isFinite(price) && price > 0) centsPerKwh[r.stateid] = price;
    }
    return { year: Number(year), centsPerKwh };
  }
}
