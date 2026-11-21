/** ENERGY STAR (lib/energy.ts): a thing's certified energy use, looked up by brand and model or barcode, kept a month. */
import type { EnergyStarMatch, ItemEnergy } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { EnergyStarProducts, kindsOf, modelMatches } from "../src/adapters/local/energystar";
import { EiaElectricity } from "../src/adapters/local/eia";
import { stateCode } from "../src/lib/energy";
import type { ElectricityPrices, EnergyStar } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const FRIDGE: EnergyStarMatch = {
  kind: "Refrigerator",
  brand: "Samsung",
  model: "RF28T5001**",
  type: "Bottom Freezer",
  kwhPerYear: 645,
  federalKwhPerYear: 717,
  percentBetter: 10,
  afue: null,
  mostEfficient: false,
  url: "https://www.energystar.gov/productfinder/product/certified-residential-refrigerators/details/1",
};

class FakeEnergyStar implements EnergyStar {
  asked: string[] = [];
  async forModel(brand: string, model: string) {
    this.asked.push(`model ${brand} ${model}`);
    return brand === "Samsung" && modelMatches("RF28T5001**", model) ? [FRIDGE] : [];
  }
  async forBarcode(code: string) {
    this.asked.push(`barcode ${code}`);
    return [];
  }
}

describe("ENERGY STAR", () => {
  it("is off until switched on, then looks a thing up in the background and keeps the answer — even none", async () => {
    const energyStar = new FakeEnergyStar();
    const { user, jobs } = await setup({ energyStar });
    const ann = await user("ann");
    const fridge = await ann.addItem({ name: "Fridge", brand: "Samsung", model: "RF28T5001SR" });
    const lamp = await ann.addItem({ name: "Lamp", brand: "Ikea", model: "HEKTAR22" });
    const mug = await ann.addItem({ name: "Mug" });

    expect(await json(ann.as(`/api/v1/items/${fridge.id}/energy`))).toEqual({ status: "off" });
    expect(await json(send(ann, "PUT", "/api/v1/server/energy-star", { enabled: true }))).toMatchObject({ available: true, enabled: true, kept: 0 });
    expect(await json(ann.as(`/api/v1/items/${fridge.id}/energy`))).toEqual({ status: "pending" });
    await jobs.drain();
    expect(await json<ItemEnergy>(ann.as(`/api/v1/items/${fridge.id}/energy`))).toEqual({ status: "found", matches: [FRIDGE], cost: null });
    // Not certified: "none", kept too — not asked again.
    await json(ann.as(`/api/v1/items/${lamp.id}/energy`));
    await jobs.drain();
    expect(await json(ann.as(`/api/v1/items/${lamp.id}/energy`))).toEqual({ status: "none" });
    await json(ann.as(`/api/v1/items/${lamp.id}/energy`));
    await jobs.drain();
    expect(energyStar.asked.filter((a) => a.startsWith("model Ikea"))).toHaveLength(1);
    // Nothing to ask by.
    expect(await json(ann.as(`/api/v1/items/${mug.id}/energy`))).toEqual({ status: "none" });
    expect(await json(ann.as("/api/v1/server/energy-star"))).toMatchObject({ kept: 2 });
    const bob = await user("bob");
    expect((await send(bob, "PUT", "/api/v1/server/energy-star", { enabled: false })).status).toBe(403);
  });

  it("puts the kWh in money at the property's state's average rate, with the server admin's EIA key", async () => {
    const energyStar = new FakeEnergyStar();
    const electricity: ElectricityPrices = {
      check: async (key) => key === "good-eia-key",
      residential: async () => ({ year: 2025, centsPerKwh: { CO: 17.17, CA: 31.35, US: 17.0 } }),
    };
    const { user, jobs } = await setup({ energyStar, electricity });
    const ann = await user("ann");
    await send(ann, "PUT", "/api/v1/server/energy-star", { enabled: true });
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home", region: "Colorado", country: "United States" }));
    const kitchen = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { name: "Kitchen", propertyId: home.id }));
    const fridge = await ann.addItem({ name: "Fridge", brand: "Samsung", model: "RF28T5001SR", locationId: kitchen.id });
    await json(ann.as(`/api/v1/items/${fridge.id}/energy`));
    await jobs.drain();
    // No key yet: no cost.
    expect(await json(ann.as(`/api/v1/items/${fridge.id}/energy`))).toMatchObject({ status: "found", cost: null });
    expect((await send(ann, "PUT", "/api/v1/server/energy-star/electricity", { key: "wrong-key" })).status).toBe(422);
    expect(await json(send(ann, "PUT", "/api/v1/server/energy-star/electricity", { key: "good-eia-key" }))).toMatchObject({ electricity: { available: true, hint: "…-key" } });
    await jobs.drain();
    // 645 kWh at 17.17¢ = $110.75.
    expect(await json(ann.as(`/api/v1/items/${fridge.id}/energy`))).toMatchObject({ cost: { cents: 11075, currency: "USD", state: "CO", centsPerKwh: 17.17, year: 2025 } });
    // Somewhere without a state: the household's only one.
    const garage = await ann.addItem({ name: "Garage fridge", brand: "Samsung", model: "RF28T5001SR" });
    expect(await json(ann.as(`/api/v1/items/${garage.id}/energy`))).toMatchObject({ cost: { state: "CO" } });
    expect(await json(ann.as("/api/v1/server/energy-star"))).toMatchObject({ electricity: { year: 2025 } });
  });

  it("reads US states from addresses, and asks the EIA for yearly home prices", async () => {
    expect(stateCode("Colorado", "United States")).toBe("CO");
    expect(stateCode("co.", null)).toBe("CO");
    expect(stateCode("New York", "USA")).toBe("NY");
    expect(stateCode("Ontario", "Canada")).toBeNull();
    expect(stateCode("Mazowieckie", "Poland")).toBeNull();
    let asked: URL | null = null;
    const fetcher = (async (input: string | URL | Request) => {
      asked = new URL(String(input));
      return new Response(JSON.stringify({ response: { data: [{ period: "2025", stateid: "CO", price: 17.17 }, { period: "2025", stateid: "MTN", price: 15 }, { period: "2025", stateid: "US", price: 17 }, { period: "2024", stateid: "CO", price: 16 }] } }), { status: 200 });
    }) as typeof fetch;
    expect(await new EiaElectricity(async () => "k", fetcher).residential()).toEqual({ year: 2025, centsPerKwh: { CO: 17.17, US: 17 } });
    expect(asked!.searchParams.get("frequency")).toBe("annual");
    expect(asked!.searchParams.get("facets[sectorid][]")).toBe("RES");
    expect(await new EiaElectricity(async () => null, fetcher).residential()).toBeNull();
  });

  it("matches ENERGY STAR's wildcard model numbers, and leaves commercial and lab equipment out", () => {
    expect(modelMatches("RF28T5001**", "RF28T5001SR")).toBe(true);
    expect(modelMatches("WM4000H*A", "WM4000HWA")).toBe(true);
    expect(modelMatches("SHX78CM**", "SHX78CM5N")).toBe(true);
    expect(modelMatches("RF28T5001**", "RF28T5001SR/AA")).toBe(true); // a suffix of up to three
    expect(modelMatches("RF28T5001**", "RF28T5002SR")).toBe(false);
    expect(modelMatches("AB*", "ABC")).toBe(false); // too short to be sure
    expect(kindsOf("Consumer Refrigeration Products")).toEqual(["Refrigerator", "Freezer"]);
    expect(kindsOf("Commercial Refrigerators and Freezers")).toEqual([]);
    expect(kindsOf("Clothes Washers")).toEqual(["Clothes washer"]);
  });

  it("asks each list for the brand and the model's first letters, with nothing but letters and digits in the query", async () => {
    const wheres: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      wheres.push(url.searchParams.get("$where") ?? "");
      const rows = url.pathname.includes("p5st-her9") ? [{ pd_id: "1", brand_name: "Samsung", model_number: "RF28T5001**", type: "Bottom Freezer", annual_energy_use_kwh_yr: "645" }] : [];
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as typeof fetch;
    const found = await new EnergyStarProducts(fetcher).forModel("Sam'sung", "rf28t5001sr");
    expect(found).toMatchObject([{ kind: "Refrigerator", kwhPerYear: 645, url: "https://www.energystar.gov/productfinder/product/certified-residential-refrigerators/details/1" }]);
    expect(wheres[0]).toBe("upper(brand_name) like '%SAM SUNG%' AND upper(model_number) like 'RF2%'");
    expect(wheres.every((w) => !w.includes("'s"))).toBe(true);
  });
});
