/** Lifespans and the replacement forecast (lib/lifespans.ts): estimates from a thing's own, its category's or the typical lifespan. */
import type { CategoryNode, ItemListing, Overview, ReplacementForecast } from "@ferret/shared";
import { typicalLifespanFor } from "@ferret/shared/utils";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const year = new Date().getFullYear();

describe("typical lifespans", () => {
  it("match on whole words, the more specific kind first", () => {
    expect(typicalLifespanFor("Rheem 50 gal water heater")?.key).toBe("water-heater");
    expect(typicalLifespanFor("Rinnai tankless water heater")?.key).toBe("tankless-water-heater");
    expect(typicalLifespanFor("Bosch plunge router")?.key).toBe("power-tool");
    expect(typicalLifespanFor("Netgear router")?.key).toBe("router");
    expect(typicalLifespanFor("Pressure washer")?.key).toBe("pressure-washer");
    expect(typicalLifespanFor("Console table")).toBeNull();
    // Accessories and supplies aren't the thing.
    expect(typicalLifespanFor("TV stand")).toBeNull();
    expect(typicalLifespanFor("JET 717531 drum collection bags (5-pack)", "Dust collector")).toBeNull();
    expect(typicalLifespanFor("Furnace filter 16x25x1")).toBeNull();
    expect(typicalLifespanFor("Table saw")?.key).toBe("power-tool");
    // The name first, then the category's names.
    expect(typicalLifespanFor("Whirlpool WRF555", "Refrigerators")?.key).toBe("refrigerator");
  });
});

describe("lifespans", () => {
  it("an item's own beats its category's (or a parent's), which beats the typical one", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const appliances = await json<CategoryNode>(send(ann, "POST", "/api/v1/categories", { name: "Appliances" }));
    const fridges = await json<CategoryNode>(send(ann, "POST", "/api/v1/categories", { name: "Kitchen", parentId: appliances.id }));
    const fridge = await ann.addItem({ name: "Fridge", purchaseDate: `${year - 5}-03-01`, purchasePriceCents: 150000, categoryId: fridges.id });

    let it = await json<ItemListing>(ann.as(`/api/v1/items/${fridge.id}`));
    expect(it.lifespan).toMatchObject({ years: 13, source: "typical", from: "refrigerator", since: `${year - 5}-03-01`, sinceFrom: "bought", dueYear: year + 8, past: false, costCents: 150000, costFrom: "price" });

    await send(ann, "PATCH", `/api/v1/categories/${appliances.id}`, { lifespanYears: 10 });
    it = await json<ItemListing>(ann.as(`/api/v1/items/${fridge.id}`));
    expect(it.lifespan).toMatchObject({ years: 10, source: "category", from: "Appliances", dueYear: year + 5 });

    await send(ann, "PATCH", `/api/v1/items/${fridge.id}`, { lifespanYears: 3, replacementCents: 180000, quantity: 2 });
    it = await json<ItemListing>(ann.as(`/api/v1/items/${fridge.id}`));
    expect(it.lifespan).toMatchObject({ years: 3, source: "item", from: null, dueYear: year - 2, past: true, costCents: 360000, costFrom: "replacement" });
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${fridge.id}/history`));
    expect(history.data[0]!.summary).toContain("expected to last 3 years");

    // Unknown kinds have none; boxes never do.
    const vase = await ann.addItem({ name: "Vase" });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${vase.id}`))).lifespan).toBeNull();
    const bin = await ann.addItem({ name: "TV box", isContainer: true });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${bin.id}`))).lifespan).toBeNull();
  });

  it("forecasts by year: past their typical life, then each year — gone things left out", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    await ann.addItem({ name: "Old water heater", purchaseDate: `${year - 12}-06-01`, purchasePriceCents: 90000 });
    await ann.addItem({ name: "Laptop", purchaseDate: `${year - 3}-01-15`, valueCents: 50000 });
    await ann.addItem({ name: "Laptop", purchaseDate: `${year - 3}-09-15` }); // no price
    await ann.addItem({ name: "New TV" }); // added today: due in 8 years
    await ann.addItem({ name: "Vase" });
    const sold = await ann.addItem({ name: "Microwave", purchaseDate: `${year - 20}-01-01`, purchasePriceCents: 10000 });
    await send(ann, "PATCH", `/api/v1/items/${sold.id}`, { disposition: "sold" });

    const f = await json<ReplacementForecast>(ann.as("/api/v1/replacements?years=10"));
    expect(f.past).toMatchObject({ items: 1, cents: 90000, unpriced: 0 });
    expect(f.years[2]).toMatchObject({ year: year + 2, items: 2, cents: 50000, unpriced: 1 });
    expect(f.years[8]).toMatchObject({ year: year + 8, items: 1 });
    expect(f.unknown).toBe(1);
    expect(f.items.map((i) => i.name)).toEqual(["Old water heater", "Laptop", "Laptop", "New TV"]);

    const o = await json<Overview>(ann.as("/api/v1/overview"));
    expect(o.replacements.past.items).toBe(1);
    expect(o.replacements.years).toHaveLength(5);
    expect(o.replacements.years[2]!.items).toBe(2);
  });
});
