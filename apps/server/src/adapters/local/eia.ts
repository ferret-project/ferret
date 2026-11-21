/**
 * The US Energy Information Administration's open data (api.eia.gov): the average price homes pay for electricity in
 * each state, by year — to put an appliance's ENERGY STAR kWh in money. Needs the server admin's free key, which this
 * adapter is given a way to fetch (kept sealed — lib/server-keys.ts); without one it knows nothing. One request a month
 * for the whole server; nothing about anyone is sent.
 */
import type { ElectricityPrices, FuelGrade, FuelPrices } from "../../ports";

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

const FUEL_API = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";
/** EIA's product codes for the grades a car's fuel is priced at. */
const GRADES: Record<string, FuelGrade> = { EPMR: "regular", EPMM: "midgrade", EPMP: "premium", EPD2D: "diesel" };
/** EIA's areas: the US, the states it prices on their own, and the regions (PADDs, with East Coast and West Coast parts). */
const AREAS: Record<string, string> = {
  NUS: "US", SCA: "CA", SCO: "CO", SFL: "FL", SMA: "MA", SMN: "MN", SNY: "NY", SOH: "OH", STX: "TX", SWA: "WA",
  R10: "R10", R1X: "R1X", R1Y: "R1Y", R1Z: "R1Z", R20: "R20", R30: "R30", R40: "R40", R50: "R50", R5XCA: "R5XCA",
};

/**
 * The EIA's weekly retail fuel prices (regular, midgrade and premium gasoline, and diesel) for the US, its regions and
 * the states it prices on their own — to put a vehicle's fuel in money. The same key as electricity prices; one
 * request a week for the whole server, nothing about anyone sent.
 */
export class EiaFuel implements FuelPrices {
  constructor(
    private readonly key: () => Promise<string | null>,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async weekly() {
    const key = await this.key();
    if (!key) return null;
    const q = new URLSearchParams({ api_key: key, frequency: "weekly", "data[0]": "value", "sort[0][column]": "period", "sort[0][direction]": "desc", length: "200" });
    for (const code of Object.keys(GRADES)) q.append("facets[product][]", code);
    const res = await this.fetcher(`${FUEL_API}?${q}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`EIA: HTTP ${res.status}`);
    const rows = ((await res.json()) as { response?: { data?: { period: string; duoarea: string; product: string; value: number | string | null }[] } }).response?.data ?? [];
    const week = rows[0]?.period;
    if (!week) return null;
    const centsPerGallon: Record<FuelGrade, Record<string, number>> = { regular: {}, midgrade: {}, premium: {}, diesel: {} };
    for (const r of rows) {
      const grade = GRADES[r.product];
      const area = AREAS[r.duoarea];
      const dollars = Number(r.value);
      // The latest week only (a region late with its number is left out rather than mixed in from last week).
      if (r.period === week && grade && area && Number.isFinite(dollars) && dollars > 0) centsPerGallon[grade][area] = Math.round(dollars * 1000) / 10;
    }
    return { week, centsPerGallon };
  }
}
