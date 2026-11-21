/** Fuel economy (lib/fuel-economy.ts): EPA's entries offered for a decoded vehicle, one confirmed, and a year's fuel in money. */
import type { ItemFuelEconomyStatus, VehicleInfo } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { EiaFuel } from "../src/adapters/local/eia";
import { FuelEconomyGov } from "../src/adapters/local/fueleconomy";
import { item } from "../src/db/schema";
import { gradeOf, likelyOption, pickModels, priceFor } from "../src/lib/fuel-economy";
import { setVehiclesEnabled } from "../src/lib/vehicles";
import type { ElectricityPrices, FuelEconomy, FuelPrices } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const ACCORD: VehicleInfo = { vin: "1HGCM66543A000000", status: "found", make: "Honda", model: "Accord", year: 2003, trim: "EX-V6", body: "Sedan", engine: "3.0 L 6-cylinder, gasoline", drive: "FWD", decodedAt: "2026-11-20T00:00:00Z" };

class FakeFuelEconomy implements FuelEconomy {
  asked: string[] = [];
  async models(year: number, make: string) {
    this.asked.push(`models ${year} ${make}`);
    return year === 2003 && make === "Honda" ? ["Accord", "Accord Wagon", "Civic", "Insight Electric"] : [];
  }
  async options(year: number, make: string, model: string) {
    this.asked.push(`options ${model}`);
    if (model === "Accord") return [{ id: "18655", text: "Auto 5-spd, 4 cyl, 2.4 L" }, { id: "18657", text: "Auto 5-spd, 6 cyl, 3.0 L" }];
    if (model === "Accord Wagon") return [{ id: "18660", text: "Auto 5-spd, 4 cyl, 2.4 L" }];
    return [];
  }
  async vehicle(id: string) {
    this.asked.push(`vehicle ${id}`);
    if (id !== "18657") return null;
    return { id, year: 2003, make: "Honda", model: "Accord", fuel: "Regular Gasoline", kind: null, city: 19, highway: 27, combined: 22, kwhPer100Miles: null, rangeMiles: null, epaYearCents: 275000, url: "https://www.fueleconomy.gov/feg/noframes/18657.shtml" };
  }
}

async function withVehicle(fuelPrices?: FuelPrices, electricity?: ElectricityPrices) {
  const fuelEconomy = new FakeFuelEconomy();
  const s = await setup({ fuelEconomy, fuelPrices, electricity });
  const ann = await s.user("ann");
  const car = await ann.addItem({ name: "Car" });
  await s.db.update(item).set({ vehicle: ACCORD }).where(eq(item.id, car.id));
  return { ...s, ann, car, fuelEconomy };
}

describe("fuel economy", () => {
  it("is off until switched on, then offers EPA's entries — the VIN's engine first — and keeps the one confirmed", async () => {
    const { ann, car, jobs, fuelEconomy, db, user } = await withVehicle();
    const url = `/api/v1/items/${car.id}/fuel-economy`;
    expect(await json(ann.as(url))).toEqual({ status: "off" });
    await setVehiclesEnabled(db, true);
    expect(await json(send(ann, "PUT", "/api/v1/server/fuel-economy", { enabled: true }))).toMatchObject({ available: true, enabled: true, vehicles: 0 });
    expect(await json(ann.as(url))).toEqual({ status: "pending" });
    await jobs.drain();
    const offered = await json<ItemFuelEconomyStatus>(ann.as(url));
    expect(offered.status).toBe("choose");
    // The 3.0 L V6 matches the VIN's engine: first. The wagon is offered too; the electric one isn't.
    expect(offered.options!.map((o) => [o.id, o.model, o.likely])).toEqual([
      ["18657", "Accord", true],
      ["18655", "Accord", false],
      ["18660", "Accord Wagon", false],
    ]);
    expect(fuelEconomy.asked).not.toContain("options Insight Electric");

    // Not one of them: refused. A viewer can't choose.
    expect((await send(ann, "PUT", url, { id: "99999" })).status).toBe(422);
    const bob = await user("bob");
    expect((await send(bob, "PUT", url, { id: "18657" })).status).toBe(404);

    expect(await json(send(ann, "PUT", url, { id: "18657" }))).toEqual({ status: "pending" });
    await jobs.drain();
    const found = await json<ItemFuelEconomyStatus>(ann.as(url));
    expect(found).toMatchObject({ status: "found", vehicle: { combined: 22, city: 19, highway: 27, text: "Accord · Auto 5-spd, 6 cyl, 3.0 L" } });
    // No EIA key: EPA's own estimate at US prices.
    expect(found.cost).toEqual({ cents: 275000, currency: "USD", source: "epa", unitCents: null, unit: null, state: null, asOf: null, miles: 15000 });
    expect(await json(ann.as("/api/v1/server/fuel-economy"))).toMatchObject({ vehicles: 1 });
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${car.id}/history`));
    expect(history.data.some((h) => h.summary.includes("Fuel economy for Car"))).toBe(true);

    // "Not this one": offered again (from what's kept — nothing asked twice).
    const asked = fuelEconomy.asked.length;
    expect(await json(send(ann, "DELETE", url))).toMatchObject({ status: "choose" });
    // "None of these": nothing offered for that vehicle.
    expect(await json(send(ann, "PUT", url, { id: null }))).toEqual({ status: "none" });
    expect(fuelEconomy.asked.length).toBe(asked);

    // Another VIN (another model year): asked about again.
    await db.update(item).set({ vehicle: { ...ACCORD, year: 2004 } }).where(eq(item.id, car.id));
    expect(await json(ann.as(url))).toEqual({ status: "pending" });
  });

  it("prices a year's fuel at the state's weekly price with the EIA key, and gives nothing abroad", async () => {
    const fuelPrices: FuelPrices = { weekly: async () => ({ week: "2026-11-16", centsPerGallon: { regular: { CO: 351.3, R40: 369.6, US: 380.5 }, midgrade: {}, premium: {}, diesel: {} } }) };
    const electricity: ElectricityPrices = { check: async (key) => key === "good-eia-key", residential: async () => ({ year: 2025, centsPerKwh: { CO: 15.2, US: 16.5 } }) };
    const { ann, car, jobs, db } = await withVehicle(fuelPrices, electricity);
    const url = `/api/v1/items/${car.id}/fuel-economy`;
    await setVehiclesEnabled(db, true);
    await send(ann, "PUT", "/api/v1/server/fuel-economy", { enabled: true });
    await json(ann.as(url));
    await jobs.drain();
    await send(ann, "PUT", url, { id: "18657" });
    await jobs.drain();

    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home", region: "Colorado", country: "United States" }));
    await send(ann, "PUT", "/api/v1/server/energy-star/electricity", { key: "good-eia-key" });
    await jobs.drain();
    expect(await json(ann.as("/api/v1/server/fuel-economy"))).toMatchObject({ prices: { available: true, week: "2026-11-16" } });
    const priced = await json<ItemFuelEconomyStatus>(ann.as(url));
    expect(priced.cost).toEqual({ cents: Math.round((15000 / 22) * 351.3), currency: "USD", source: "state", unitCents: 351.3, unit: "gallon", state: "CO", asOf: "2026-11-16", miles: 15000 });

    // The only home is abroad: US prices say nothing there.
    await send(ann, "PATCH", `/api/v1/properties/${home.id}`, { region: "Mazowieckie", country: "Poland" });
    expect((await json<ItemFuelEconomyStatus>(ann.as(url))).cost).toBeNull();
  });

  it("matches NHTSA's models to EPA's, and prices by state, then region, then the US", () => {
    const ford = ["F150 Pickup 2WD", "F150 Pickup 4WD", "F150 Pickup 4WD FFV", "F150 Pickup 2WD FFV", "Fiesta FWD", "Focus Electric", "Focus FWD"];
    expect(pickModels(ford, { model: "F-150", drive: "4WD/4-Wheel Drive/4x4", engine: "3.5 L 6-cylinder, gasoline" })).toEqual(["F150 Pickup 4WD", "F150 Pickup 4WD FFV"]);
    expect(pickModels(ford, { model: "Focus", drive: null, engine: "electric" })).toEqual(["Focus Electric"]);
    expect(pickModels(ford, { model: "Focus", drive: "FWD", engine: "2.0 L 4-cylinder, gasoline" })).toEqual(["Focus FWD"]);
    expect(pickModels(ford, { model: "Mustang" })).toEqual([]);

    expect(likelyOption("Auto (S6), 6 cyl, 3.5 L, Turbo", "3.5 L 6-cylinder, gasoline")).toBe(true);
    expect(likelyOption("Auto (S6), 6 cyl, 2.7 L, Turbo", "3.5 L 6-cylinder, gasoline")).toBe(false);
    expect(likelyOption("Auto (S6), 6 cyl, 2.7 L, Turbo", null)).toBe(false);

    expect([gradeOf("Regular Gasoline"), gradeOf("Premium Gasoline"), gradeOf("Diesel"), gradeOf("Electricity"), gradeOf("E85")]).toEqual(["regular", "premium", "diesel", "electricity", null]);

    const prices = { week: "2026-11-16", centsPerGallon: { regular: { CA: 538.7, R50: 493.3, R40: 369.6, US: 380.5 }, midgrade: {}, premium: {}, diesel: { R10: 578.2, US: 593.7 } } };
    expect(priceFor(prices, "regular", "CA")).toEqual({ cents: 538.7, source: "state", state: "CA" });
    expect(priceFor(prices, "regular", "UT")).toEqual({ cents: 369.6, source: "region", state: "UT" });
    // Nevada's part of the West Coast missing: the whole West Coast's.
    expect(priceFor(prices, "regular", "NV")).toEqual({ cents: 493.3, source: "region", state: "NV" });
    expect(priceFor(prices, "diesel", "VT")).toEqual({ cents: 578.2, source: "region", state: "VT" });
    expect(priceFor(prices, "regular", null)).toEqual({ cents: 380.5, source: "us", state: null });
  });

  it("reads fueleconomy.gov's menus (one entry comes back as an object) and the EIA's weekly prices", async () => {
    const answers: Record<string, unknown> = {
      "/vehicle/menu/options?year=2015&make=Ford&model=Focus+Electric": { menuItem: { text: "Auto (A1)", value: "35970" } },
      "/vehicle/menu/options?year=2015&make=Ford&model=Nope": null,
      "/vehicle/35970": { id: "35970", year: "2015", make: "Ford", model: "Focus Electric", fuelType1: "Electricity", atvType: "EV", city08: "110", highway08: "99", comb08: "105", combE: "32.0", range: "76", fuelCost08: "700" },
    };
    const gov = new FuelEconomyGov(async (input) => {
      const path = String(input).replace("https://www.fueleconomy.gov/ws/rest", "");
      return path in answers ? new Response(JSON.stringify(answers[path])) : new Response("", { status: 404 });
    });
    expect(await gov.options(2015, "Ford", "Focus Electric")).toEqual([{ id: "35970", text: "Auto (A1)" }]);
    expect(await gov.options(2015, "Ford", "Nope")).toEqual([]);
    expect(await gov.vehicle("35970")).toMatchObject({ fuel: "Electricity", kind: "EV", combined: 105, kwhPer100Miles: 32, rangeMiles: 76, epaYearCents: 70000 });
    expect(await gov.vehicle("1")).toBeNull();
    expect(await gov.vehicle("../x")).toBeNull();

    const urls: string[] = [];
    const eia = new EiaFuel(async () => "k", async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ response: { data: [
        { period: "2026-11-16", duoarea: "SCO", product: "EPMR", value: "3.513" },
        { period: "2026-11-16", duoarea: "NUS", product: "EPD2D", value: 5.937 },
        { period: "2026-11-16", duoarea: "YDEN", product: "EPMR", value: 3.344 },
        { period: "2026-11-09", duoarea: "R40", product: "EPMR", value: 3.7 },
      ] } }));
    });
    expect(await eia.weekly()).toEqual({ week: "2026-11-16", centsPerGallon: { regular: { CO: 351.3 }, midgrade: {}, premium: {}, diesel: { US: 593.7 } } });
    expect(urls[0]).toContain("facets%5Bproduct%5D%5B%5D=EPMR");
    expect(await new EiaFuel(async () => null).weekly()).toBeNull();
  });
});
