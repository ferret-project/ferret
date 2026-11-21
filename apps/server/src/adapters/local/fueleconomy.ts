/**
 * fueleconomy.gov's web services (the US EPA and Department of Energy): the models a make had in a year, each model's
 * entries (transmission and engine), and an entry's fuel economy. Free, no key; only a year, make and model — or an
 * entry's id — are sent. Plain fetch, so any runtime can use it.
 */
import type { FuelEconomy } from "../../ports";

const API = "https://www.fueleconomy.gov/ws/rest";

type Menu = { menuItem?: { text: string; value: string } | { text: string; value: string }[] } | null;

/** A menu of one item comes back as an object, not a list; none as null. */
const items = (m: Menu) => (m?.menuItem ? (Array.isArray(m.menuItem) ? m.menuItem : [m.menuItem]) : []);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class FuelEconomyGov implements FuelEconomy {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async get<T>(path: string): Promise<T | null> {
    const res = await this.fetcher(`${API}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fueleconomy.gov: HTTP ${res.status}`);
    const text = await res.text();
    return text.trim() && text.trim() !== "null" ? (JSON.parse(text) as T) : null;
  }

  async models(year: number, make: string) {
    return items(await this.get<Menu>(`/vehicle/menu/model?${new URLSearchParams({ year: String(year), make })}`)).map((m) => m.value);
  }

  async options(year: number, make: string, model: string) {
    return items(await this.get<Menu>(`/vehicle/menu/options?${new URLSearchParams({ year: String(year), make, model })}`)).map((m) => ({ id: m.value, text: m.text }));
  }

  async vehicle(id: string) {
    if (!/^\d{1,8}$/.test(id)) return null;
    const v = await this.get<Record<string, string>>(`/vehicle/${id}`);
    if (!v?.id) return null;
    const combined = num(v.comb08);
    if (!combined) return null;
    return {
      id: v.id,
      year: Number(v.year),
      make: v.make ?? "",
      model: v.model ?? "",
      fuel: v.fuelType1 || v.fuelType || "",
      kind: v.atvType?.trim() || null,
      city: num(v.city08) ?? combined,
      highway: num(v.highway08) ?? combined,
      combined,
      kwhPer100Miles: num(v.combE),
      rangeMiles: num(v.range),
      epaYearCents: num(v.fuelCost08) ? Math.round(num(v.fuelCost08)! * 100) : null,
      url: `https://www.fueleconomy.gov/feg/noframes/${v.id}.shtml`,
    };
  }
}
