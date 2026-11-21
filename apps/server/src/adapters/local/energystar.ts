/**
 * ENERGY STAR's certified products (data.energystar.gov, the US EPA's open data; no key): appliances by brand and model
 * number — fridges, freezers, washers, dryers, dishwashers, dehumidifiers, room air conditioners, water heaters,
 * furnaces, TVs, air cleaners, electric cooking — or by barcode, with their energy use. Plain fetch to fixed
 * addresses; only the brand and model (or the barcode) are sent.
 */
import type { EnergyStarMatch } from "@ferret/shared";
import type { EnergyStar } from "../../ports";

const API = "https://data.energystar.gov/resource";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";

type Dataset = { id: string; kind: string; slug: string; kwh?: string; standard?: string; percent?: string; afue?: string; type?: string };

/** The household appliances' datasets: what each calls its figures. */
export const DATASETS: Dataset[] = [
  { id: "p5st-her9", kind: "Refrigerator", slug: "certified-residential-refrigerators", kwh: "annual_energy_use_kwh_yr", standard: "us_federal_standard_kwh_yr", percent: "percent_less_energy_use_than_us_federal_standard", type: "type" },
  { id: "8t9c-g3tn", kind: "Freezer", slug: "certified-residential-freezers", kwh: "annual_energy_use_kwh_yr", standard: "us_federal_standard_kwh_yr", percent: "percent_less_energy_use_than_us_federal_standard", type: "type" },
  { id: "bghd-e2wd", kind: "Clothes washer", slug: "certified-clothes-washers", kwh: "annual_energy_use_kwh_year" },
  { id: "t9u7-4d2j", kind: "Clothes dryer", slug: "certified-clothes-dryers", kwh: "estimated_annual_energy_use_kwh_yr", type: "type" },
  { id: "q8py-6w3f", kind: "Dishwasher", slug: "certified-residential-dishwashers", kwh: "annual_energy_use_kwh_year", standard: "us_federal_standard_kwh_year", type: "type" },
  { id: "mgiu-hu4z", kind: "Dehumidifier", slug: "certified-dehumidifiers", kwh: "annual_energy_consumption_kwh_yr" },
  { id: "5xn2-dv4h", kind: "Room air conditioner", slug: "certified-room-air-conditioners", kwh: "annual_energy_use_kwh_yr", percent: "percent_less_energy_use_than_us_federal_standard", type: "type" },
  { id: "pbpq-swnu", kind: "Water heater", slug: "certified-water-heaters", kwh: "electric_usage_kwh_yr", type: "type" },
  { id: "i97v-e8au", kind: "Furnace", slug: "certified-furnaces", afue: "efficiency_afue", type: "fuel_type" },
  { id: "pd96-rr3d", kind: "Television", slug: "certified-televisions", kwh: "reported_annual_energy_consumption_kwh", type: "product_type" },
  { id: "gaa3-swy6", kind: "Air cleaner", slug: "certified-room-air-cleaners", kwh: "annual_energy_use_kwh_yr" },
  { id: "m6gi-ng33", kind: "Electric cooking", slug: "certified-residential-electric-cooking-products", kwh: "annual_energy_consumption_kwh_yr", type: "product_type" },
];
const UPCS = "8edu-y555";

/** Letters and digits, in capitals: model numbers are written every which way ("WRT318-FZD W" → "WRT318FZDW"). */
export const squashModel = (s: string) => s.toUpperCase().replace(/[^A-Z0-9*#]/g, "");

/**
 * Whether a thing's model is one ENERGY STAR's (wildcard) model number covers: `*` and `#` stand for any one
 * character, and the thing's may end in up to three more (a colour or revision suffix: "WRT318FZDW00").
 */
export function modelMatches(listed: string, model: string) {
  const pattern = squashModel(listed);
  const mine = squashModel(model).replace(/[*#]/g, "");
  if (pattern.replace(/[*#]/g, "").length < 4 || mine.length < 4) return false;
  const re = new RegExp(`^${pattern.replace(/[*#]/g, ".")}.{0,3}$`);
  return re.test(mine);
}

/** A string for a SoQL literal: letters, digits, spaces and a few marks only — never a quote. */
const literal = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 &.\-]/g, " ").replace(/\s+/g, " ").trim();

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function toMatch(ds: Dataset, r: Record<string, string>): EnergyStarMatch {
  return {
    kind: ds.kind,
    brand: r.brand_name ?? "",
    model: r.model_number ?? "",
    type: (ds.type && r[ds.type]) || null,
    kwhPerYear: ds.kwh ? num(r[ds.kwh]) : null,
    federalKwhPerYear: ds.standard ? num(r[ds.standard]) : null,
    percentBetter: ds.percent ? num(r[ds.percent]) : null,
    afue: ds.afue ? num(r[ds.afue]) : null,
    mostEfficient: r.meets_most_efficient_criteria === "Yes",
    url: r.pd_id ? `https://www.energystar.gov/productfinder/product/${ds.slug}/details/${encodeURIComponent(r.pd_id)}` : "https://www.energystar.gov/productfinder/",
  };
}

export class EnergyStarProducts implements EnergyStar {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async rows(dataset: string, where: string): Promise<Record<string, string>[]> {
    const res = await this.fetcher(`${API}/${dataset}.json?${new URLSearchParams({ $where: where, $limit: "200" })}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ENERGY STAR: HTTP ${res.status}`);
    return (await res.json()) as Record<string, string>[];
  }

  async forModel(brand: string, model: string): Promise<EnergyStarMatch[]> {
    const b = literal(brand);
    const prefix = squashModel(model).replace(/[*#]/g, "").slice(0, 3);
    if (b.length < 2 || prefix.length < 3) return [];
    // The brand anywhere in theirs ("GE" in "GE Appliances"), and models starting the same — narrowed here by wildcard.
    const where = `upper(brand_name) like '%${b}%' AND upper(model_number) like '${prefix}%'`;
    // A listing may name sibling models too ("additional_model_information": "AWC152DBLSS; AWC152DPRGRH").
    const covers = (r: Record<string, string>) => [r.model_number ?? "", ...(r.additional_model_information ?? "").split(/[;,]/)].some((m) => m.trim() && modelMatches(m, model));
    const found = await Promise.all(DATASETS.map(async (ds) => (await this.rows(ds.id, where)).filter(covers).map((r) => toMatch(ds, r))));
    // A listing may appear twice (one per market): once each.
    const seen = new Set<string>();
    return found.flat().filter((m) => !seen.has(`${m.kind}:${m.model}:${m.url}`) && seen.add(`${m.kind}:${m.model}:${m.url}`));
  }

  async forBarcode(code: string): Promise<EnergyStarMatch[]> {
    const digits = code.replace(/\D/g, "");
    if (digits.length < 8) return [];
    const variants = [...new Set([digits, digits.replace(/^0+/, ""), digits.padStart(12, "0"), digits.padStart(13, "0")])];
    const hits = await this.rows(UPCS, `upc in (${variants.map((v) => `'${v}'`).join(",")})`);
    if (!hits.length) return [];
    // The barcode book says which product: its full record (and figures) from its own list.
    const out: EnergyStarMatch[] = [];
    for (const hit of hits.slice(0, 3)) {
      if (!hit.pd_id) continue;
      for (const ds of DATASETS.filter((d) => kindsOf(hit.product_program_category ?? "").includes(d.kind))) {
        const [row] = await this.rows(ds.id, `pd_id = '${hit.pd_id.replace(/\D/g, "")}'`);
        if (row) {
          out.push(toMatch(ds, row));
          break;
        }
      }
    }
    return out;
  }
}

/** The barcode book's category → the datasets that may hold it (homes' only: never commercial or lab equipment). */
export function kindsOf(category: string): string[] {
  const c = category.toLowerCase();
  if (/commercial|lab grade/.test(c)) return [];
  if (c.includes("consumer refrigeration")) return ["Refrigerator", "Freezer"];
  if (c.includes("refrigerator")) return ["Refrigerator"];
  if (c.includes("freezer")) return ["Freezer"];
  if (c.includes("clothes washer")) return ["Clothes washer"];
  if (c.includes("clothes dryer")) return ["Clothes dryer"];
  if (c.includes("dishwasher")) return ["Dishwasher"];
  if (c.includes("dehumidifier")) return ["Dehumidifier"];
  if (c.includes("room air conditioner")) return ["Room air conditioner"];
  if (c.includes("water heater")) return ["Water heater"];
  if (c.includes("furnace")) return ["Furnace"];
  if (c.includes("television")) return ["Television"];
  if (c.includes("air cleaner") || c.includes("air purifier")) return ["Air cleaner"];
  if (c.includes("cooking")) return ["Electric cooking"];
  return [];
}
