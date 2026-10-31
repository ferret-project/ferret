/** The Overview screen: value, warranties to act on, what's missing, recent changes. */
import { today } from "@ferret/shared/utils";
import type { ItemSearch, Overview, PlacesTree } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { pdf, photo, setup } from "./helpers";

const daysFromNow = (days: number) => today(new Date(Date.now() + days * 86_400_000)); // local, as the server counts

describe("overview", () => {
  it("adds up value, finds what's missing, and lists warranties and changes", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const post = (url: string, data: object) => ann.as(url, { method: "POST", body: JSON.stringify(data) });
    const home = (await (await post("/api/v1/properties", { name: "Home" })).json()) as { id: string };
    const garage = (await (await post("/api/v1/locations", { propertyId: home.id, name: "Garage" })).json()) as { id: string };

    const drill = await ann.addItem({ name: "Drill", valueCents: 10000, quantity: 2, locationId: garage.id });
    await ann.upload(drill.id, await photo(), "drill.png");
    await ann.upload(drill.id, pdf(), "receipt.pdf", "document");
    const mixer = await ann.addItem({ name: "Mixer", purchasePriceCents: 30000, purchaseDate: "2024-03-09" });
    await ann.addItem({ name: "Mystery box" });

    await post(`/api/v1/items/${mixer.id}/warranties`, { endsOn: daysFromNow(20), provider: "KitchenAid" });
    await post(`/api/v1/items/${drill.id}/warranties`, { endsOn: daysFromNow(400) }); // fine for now: not listed

    const o = (await (await ann.as("/api/v1/overview")).json()) as Overview;
    expect(o.total).toEqual({ valueCents: 50000, items: 3, itemsWithoutValue: 1 });
    expect([o.properties, o.locations]).toEqual([1, 1]);
    // Worth over time: by when things came in — bought, else added (the drill, today).
    expect(o.byMonth).toEqual([
      { month: "2024-03", valueCents: 30000 },
      { month: today().slice(0, 7), valueCents: 20000 },
    ]);
    expect(o.byRoom.map((r) => [r.name, r.valueCents])).toEqual([
      ["Not placed", 30000],
      ["Home › Garage", 20000],
    ]);
    expect(o.missing).toEqual({ photo: 2, value: 1, place: 2, document: 2, category: 3 });
    expect(o.warranties).toEqual([expect.objectContaining({ itemName: "Mixer", provider: "KitchenAid", status: "expiring" })]);
    expect(o.activity[0]).toMatchObject({ actorName: "ann", via: "web" });

    // The places tree says what each room holds is worth.
    const tree = (await (await ann.as("/api/v1/locations/tree")).json()) as PlacesTree;
    expect(tree.properties[0]!.locations[0]).toMatchObject({ name: "Garage", itemCount: 1, valueCents: 20000 });

    // Each "missing" count opens the matching items.
    const noPhoto = (await (await ann.as("/api/v1/items?missing=photo")).json()) as ItemSearch;
    expect(noPhoto.data.map((i) => i.name).sort()).toEqual(["Mixer", "Mystery box"]);
    const noValue = (await (await ann.as("/api/v1/items?missing=value")).json()) as ItemSearch;
    expect(noValue.data.map((i) => i.name)).toEqual(["Mystery box"]);
  });

  it("counts what's in places nested inside a room, leaving out deleted and gone things", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const post = (url: string, data: object) => ann.as(url, { method: "POST", body: JSON.stringify(data) });
    const home = (await (await post("/api/v1/properties", { name: "Home" })).json()) as { id: string };
    const garage = (await (await post("/api/v1/locations", { propertyId: home.id, name: "Garage" })).json()) as { id: string };
    const shelf = (await (await post("/api/v1/locations", { propertyId: home.id, parentId: garage.id, name: "Shelf" })).json()) as { id: string };
    const bin = (await (await post("/api/v1/locations", { propertyId: home.id, parentId: shelf.id, name: "Bin" })).json()) as { id: string };
    await ann.addItem({ name: "Ladder", locationId: garage.id, valueCents: 5000 });
    await ann.addItem({ name: "Paint", locationId: shelf.id, valueCents: 1000 });
    await ann.addItem({ name: "Screws", locationId: bin.id, valueCents: 200 });
    const deleted = await ann.addItem({ name: "Old saw", locationId: bin.id, valueCents: 900 });
    await ann.as(`/api/v1/items/${deleted.id}`, { method: "DELETE" });
    const sold = await ann.addItem({ name: "Sold bike", locationId: shelf.id, valueCents: 9000 });
    await ann.as(`/api/v1/items/${sold.id}`, { method: "PATCH", body: JSON.stringify({ disposition: "sold" }) });

    const tree = (await (await ann.as("/api/v1/locations/tree")).json()) as PlacesTree;
    const g = tree.properties[0]!.locations[0]!;
    expect(g).toMatchObject({ name: "Garage", itemCount: 1, totalCount: 3, valueCents: 5000, totalValueCents: 6200 });
    expect(g.children[0]).toMatchObject({ name: "Shelf", itemCount: 1, totalCount: 2 });
    expect(g.children[0]!.children[0]).toMatchObject({ name: "Bin", itemCount: 1, totalCount: 1 });
  });

  it("only counts the caller's household", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    await ann.addItem({ name: "Drill", valueCents: 10000 });
    const bob = await user("bob");
    const o = (await (await bob.as("/api/v1/overview")).json()) as Overview;
    expect(o.total.items).toBe(0);
    expect(o.missing.photo).toBe(0);
    expect(o.activity).toEqual([]);
  });
});
