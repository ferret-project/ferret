/** Importing: spreadsheets (any CSV, Ferret's own export, Amazon orders) and Home Assistant's devices. */
import { detectPreset, draftRows, guessMapping, IMPORT_FIELDS, parseCsv, parseDate, parseMoney } from "@ferret/shared/utils";
import { describe, expect, it } from "vitest";
import { websocketUrl } from "../src/adapters/local/home-assistant";
import { tidyRegistry } from "../src/lib/home-assistant";
import { splitPath } from "../src/lib/imports";
import { type HaRegistry, type HomeAssistant, HomeAssistantError } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const drafts = (csv: string) => {
  const table = parseCsv(csv);
  return draftRows(table, guessMapping(table[0]!));
};

describe("reading a spreadsheet", () => {
  it("parses quotes, line breaks, a BOM and semicolons", () => {
    expect(parseCsv('﻿Name,Notes\r\n"Drill, cordless","Says ""DeWalt""\non it"\r\nSaw,\r\n\r\n')).toEqual([
      ["Name", "Notes"],
      ["Drill, cordless", 'Says "DeWalt"\non it'],
      ["Saw", ""],
    ]);
    expect(parseCsv("Name;Price\nLamp;12,50\n")).toEqual([["Name", "Price"], ["Lamp", "12,50"]]);
  });

  it("reads money and dates the ways people write them", () => {
    expect([parseMoney("$1,234.56"), parseMoney("12,50 €"), parseMoney("1.234,56"), parseMoney("free"), parseMoney("80")]).toEqual([123456, 1250, 123456, null, 8000]);
    expect([parseDate("2024-03-05"), parseDate("3/5/2024"), parseDate("25/12/2023"), parseDate("5.3.2024"), parseDate("Mar 5, 2024"), parseDate("13/13/2024"), parseDate("soon")]).toEqual([
      "2024-03-05", "2024-03-05", "2023-12-25", "2024-03-05", "2024-03-05", null, null,
    ]);
  });

  it("guesses the columns of any spreadsheet, and says what it couldn't read", () => {
    const rows = drafts("Item,Manufacturer,Model #,Qty,Price,Room,Purchased,Tags,Comments,Colour\nTV,Sony,XBR-55,1,$899.99,Family Room,2021-11-26,electronics; living,Wall mounted,black\n,Nobody,,,,,,,,\nLamp,,,,cheap,,someday,,,\n");
    expect(rows[0]).toEqual({
      line: 2,
      problems: [],
      unlikely: false,
      draft: { name: "TV", brand: "Sony", model: "XBR-55", quantity: 1, purchasePriceCents: 89999, place: "Family Room", purchaseDate: "2021-11-26", tags: ["electronics", "living"], notes: "Wall mounted" },
    });
    expect(rows[1]).toMatchObject({ draft: null, problems: ["No name"] });
    expect(rows[2]!.problems).toEqual(['Couldn\'t read Price "cheap"', 'Couldn\'t read Purchased "someday" as a date']);
  });

  it("knows Ferret's own export and Amazon's order history, and reads prefixed columns", () => {
    const ferret = 'Item,Where,In box,Category,Brand,Model,Serial number,Quantity,Condition,Purchase date,Price paid (each),Value (each),Total value,Photos,Receipts & documents,Warranty until,Tags,Description,Notes,Ferret ID\nDrill,Highland House › Garage,Red toolbox,Tools,DeWalt,DCD777,SN1,1,good,2022-05-01,99.00,80.00,80.00,2,1,2025-05-01,tools,,,abc\n';
    expect(detectPreset(parseCsv(ferret)[0]!)).toBe("ferret");
    expect(drafts(ferret)[0]!.draft).toEqual({
      name: "Drill", place: "Highland House › Garage", notes: "In box: Red toolbox", category: "Tools", brand: "DeWalt", model: "DCD777", serialNumber: "SN1", quantity: 1,
      condition: "good", purchaseDate: "2022-05-01", purchasePriceCents: 9900, valueCents: 8000, warrantyEnds: "2025-05-01", tags: ["tools"],
    });

    const prefixed = "INV.import_ref,INV.location,INV.labels,INV.quantity,INV.name,INV.description,INV.serial_number,INV.model_number,INV.manufacturer,INV.notes,INV.purchase_from,INV.purchase_price,INV.purchase_time,INV.warranty_expires,INV.sold_to,INV.sold_price,INV.sold_time\n1,Garage / Shelf,tools;power,1,Circular saw,,CS-9,7-1/4,Skil,,Home Depot,59.99,2020-06-01,,Bob,40,2024-08-01\n";
    expect(detectPreset(parseCsv(prefixed)[0]!)).toBe(null);
    expect(drafts(prefixed)[0]!.draft).toEqual({
      place: "Garage / Shelf", tags: ["tools", "power"], quantity: 1, name: "Circular saw", serialNumber: "CS-9", model: "7-1/4", brand: "Skil",
      notes: "INV.purchase_from: Home Depot\nINV.sold_to: Bob", purchasePriceCents: 5999, purchaseDate: "2020-06-01", soldCents: 4000, soldOn: "2024-08-01",
    });

    const amazon = 'Website,Order ID,Order Date,Currency,Unit Price,Unit Price Tax,Total Owed,ASIN,Product Condition,Quantity,Order Status,Product Name\nAmazon.com,112-1,2024-03-05T17:01:02Z,USD,24.99,1.80,53.58,B0ABCDEFGH,New,2,Closed,"Anker USB-C charger"\nAmazon.com,112-2,2024-04-01T10:00:00Z,USD,9.99,0,9.99,B0ZZZZZZZZ,New,1,Cancelled,Phone case\n';
    expect(detectPreset(parseCsv(amazon)[0]!)).toBe("amazon");
    const [charger, cancelled] = drafts(amazon);
    expect(charger!.draft).toMatchObject({
      name: "Anker USB-C charger", purchasePriceCents: 2499, quantity: 2, condition: "new", notes: "Bought on Amazon\nOrder ID: 112-1",
      links: [{ url: "https://www.amazon.com/dp/B0ABCDEFGH", label: "On Amazon" }],
    });
    expect(charger!.draft!.purchaseDate).toMatch(/^2024-03-0[45]$/);
    expect(cancelled!.unlikely).toBe(true);
    // Every guess is a field the screen can show.
    for (const f of guessMapping(parseCsv(amazon)[0]!)) if (f) expect(IMPORT_FIELDS[f]).toBeTruthy();
  });

  it("splits place paths only where they're meant to be split", () => {
    expect(splitPath("Main › Kitchen")).toEqual(["Main", "Kitchen"]);
    expect(splitPath("Garage / Shelf 2 > Top")).toEqual(["Garage", "Shelf 2", "Top"]);
    expect(splitPath("A/V closet")).toEqual(["A/V closet"]);
  });
});

describe("importing", () => {
  it("makes items, the places and categories they name, and can be undone", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Highland House" }));
    const garage = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Garage" }));
    await ann.addItem({ name: "Old drill", serialNumber: "SN-OLD" });

    const res = await send(ann, "POST", "/api/v1/import", {
      source: "csv",
      name: "stuff.csv",
      propertyId: home.id,
      rows: [
        { name: "Drill", place: "Highland House › Garage › Shelf", category: "Tools › Power tools", tags: ["tools"], purchaseDate: "2022-05-01", warrantyEnds: "2025-05-01" },
        { name: "Saw", place: "garage", category: "tools", quantity: 2 },
        { name: "Mixer", place: "Main › Kitchen", soldOn: "2024-01-02", soldCents: 5000 },
        { name: "Same old drill", serialNumber: "sn-old" },
        { name: "Bad place", locationId: "nope" },
      ],
    });
    expect(res.status).toBe(201);
    const result = await json<{ batchId: string; created: number; skipped: { index: number; reason: string }[]; placesCreated: number; categoriesCreated: number }>(res);
    expect(result).toMatchObject({ created: 3, placesCreated: 3, categoriesCreated: 2 });
    expect(result.skipped).toEqual([
      { index: 3, reason: "Already in Ferret (serial number sn-old)" },
      { index: 4, reason: "Place not found" },
    ]);

    const tree = await json<{ properties: { locations: { name: string; id: string; children: { name: string }[] }[] }[] }>(ann.as("/api/v1/locations/tree"));
    const rooms = tree.properties[0]!.locations;
    expect(rooms.map((r) => r.name).sort()).toEqual(["Garage", "Main"]);
    expect(rooms.find((r) => r.id === garage.id)!.children.map((c) => c.name)).toEqual(["Shelf"]);

    const items = await json<{ data: { name: string; place: string | null; category: string | null; tags: string[]; quantity: number }[] }>(ann.as("/api/v1/items?limit=50"));
    expect(items.data.map((i) => [i.name, i.place, i.category, i.quantity]).sort()).toEqual([
      ["Drill", "Highland House › Garage › Shelf", "Tools › Power tools", 1],
      ["Old drill", null, null, 1],
      ["Saw", "Highland House › Garage", "Tools", 2],
    ]);
    expect(await json(ann.as("/api/v1/items?gone=only"))).toMatchObject({ data: [{ name: "Mixer", disposition: "sold", disposalCents: 5000 }] });
    const drill = items.data.find((i) => i.name === "Drill") as unknown as { id: string };
    expect(await json(ann.as(`/api/v1/items/${drill.id}/warranties`))).toMatchObject({ data: [{ endsOn: "2025-05-01", startsOn: "2022-05-01" }] });

    // A second part of the same file goes in the same import.
    await send(ann, "POST", "/api/v1/import", { source: "csv", name: "stuff.csv", batchId: result.batchId, rows: [{ name: "Hammer" }] });
    expect(await json(ann.as("/api/v1/import"))).toMatchObject({ data: [{ id: result.batchId, name: "stuff.csv", items: 4, undoneAt: null }] });

    expect(await json(send(ann, "POST", `/api/v1/import/${result.batchId}/undo`))).toEqual({ removed: 4 });
    expect((await json<{ data: { name: string }[] }>(ann.as("/api/v1/items"))).data.map((i) => i.name)).toEqual(["Old drill"]);
    expect((await json<{ data: { name: string }[] }>(ann.as("/api/v1/trash/items"))).data.map((i) => i.name).sort()).toEqual(["Drill", "Hammer", "Mixer", "Saw"]);
    expect((await send(ann, "POST", `/api/v1/import/${result.batchId}/undo`)).status).toBe(409);
    expect((await send(ann, "POST", "/api/v1/import", { source: "csv", name: "x", batchId: result.batchId, rows: [{ name: "Late" }] })).status).toBe(409);
  });

  it("keeps imports to the household, and away from viewers", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const r = await json<{ batchId: string }>(send(ann, "POST", "/api/v1/import", { source: "csv", name: "a.csv", rows: [{ name: "Lamp" }] }));
    expect((await send(bob, "POST", `/api/v1/import/${r.batchId}/undo`)).status).toBe(404);
    expect((await send(bob, "POST", "/api/v1/import", { source: "csv", name: "b.csv", batchId: r.batchId, rows: [{ name: "Sneaky" }] })).status).toBe(404);
    expect(await json(bob.as("/api/v1/import"))).toEqual({ data: [] });
    // New places need a property to go in.
    expect((await send(ann, "POST", "/api/v1/import", { source: "csv", name: "c.csv", rows: [{ name: "Lamp", place: "Den" }] })).status).toBe(422);
  });
});

/** Shaped like a real registry: the same Sonos through two integrations, cameras that share a name but not a MAC, software. */
const REGISTRY: HaRegistry = {
  floors: [{ floor_id: "main", name: "Main", level: 1 }, { floor_id: "basement", name: "Basement", level: 0 }],
  areas: [
    { area_id: "kitchen", name: "Kitchen", floor_id: "main" },
    { area_id: "mechanical_room", name: "Mechanical Room", floor_id: "basement" },
    { area_id: "outside", name: "Outside", floor_id: null },
  ],
  configEntries: [
    { entry_id: "e-sonos", domain: "sonos", title: "Sonos" },
    { entry_id: "e-hkc", domain: "homekit_controller", title: "Kitchen Amp" },
    { entry_id: "e-protect", domain: "unifiprotect", title: "UniFi Protect" },
    { entry_id: "e-hacs", domain: "hacs", title: "HACS" },
    { entry_id: "e-met", domain: "met", title: "Home" },
    { entry_id: "e-carrier", domain: "ha_carrier", title: "Carrier" },
  ],
  devices: [
    { id: "d1", name: "Kitchen Fridge Sonos Amp", manufacturer: "Sonos", model: "Amp", area_id: "kitchen", serial_number: "SN-AMP-1", connections: [["mac", "AA:BB:CC:00:00:01"]], primary_config_entry: "e-sonos" },
    { id: "d2", name: "Kitchen Fridge Sonos Amp", manufacturer: "Sonos, Inc.", model: "Amp", area_id: null, primary_config_entry: "e-hkc" },
    { id: "d3", name: "AI Pro", manufacturer: "Ubiquiti", model: "AI Pro", area_id: "outside", connections: [["mac", "aa:00:00:00:00:01"]], primary_config_entry: "e-protect" },
    { id: "d4", name: "AI Pro", manufacturer: "Ubiquiti", model: "AI Pro", area_id: "outside", connections: [["mac", "aa:00:00:00:00:02"]], primary_config_entry: "e-protect" },
    { id: "d5", name: "Back Left", name_by_user: null, manufacturer: "Ubiquiti Inc", model: "AI Pro", area_id: "outside", connections: [["mac", "AA:00:00:00:00:02"]], primary_config_entry: "e-protect" },
    { id: "d6", name: "HACS", manufacturer: "hacs.xyz", model: "", area_id: null, primary_config_entry: "e-hacs" },
    { id: "d7", name: "Forecast", manufacturer: "Met.no", model: "Forecast", entry_type: "service", primary_config_entry: "e-met" },
    { id: "d8", name: "Old switch", manufacturer: "Acme", model: "S1", disabled_by: "user" },
    { id: "d9", name: "Basement", name_by_user: "Furnace thermostat", manufacturer: "Carrier", model: "SYSTXCCITC01-B", area_id: "mechanical_room", configuration_url: "http://10.0.0.50", primary_config_entry: "e-carrier" },
  ],
};

class FakeHomeAssistant implements HomeAssistant {
  seen: { url: string; token: string }[] = [];
  reg = structuredClone(REGISTRY);
  async registry(url: string, token: string) {
    this.seen.push({ url, token });
    if (token === "x".repeat(30)) throw new HomeAssistantError("Home Assistant didn't accept that token");
    return structuredClone(this.reg);
  }
}

describe("Home Assistant", () => {
  it("folds duplicates together, keeps distinct devices apart, and marks the software", () => {
    const view = tidyRegistry(REGISTRY);
    expect(view.hidden).toBe(2);
    expect(view.floors.map((f) => f.name)).toEqual(["Basement", "Main"]);
    const byName = Object.fromEntries(view.devices.map((d) => [d.name, d]));
    expect(view.devices.map((d) => d.name)).toEqual(["AI Pro", "Back Left", "Furnace thermostat", "Kitchen Fridge Sonos Amp", "HACS"]);
    expect(byName["Kitchen Fridge Sonos Amp"]).toMatchObject({ id: "d1", alsoIds: ["d2"], areaId: "kitchen", serialNumber: "SN-AMP-1", integration: "Sonos", virtual: false });
    expect(byName["Back Left"]).toMatchObject({ alsoIds: ["d4"] }); // same MAC as the unnamed AI Pro
    expect(byName["AI Pro"]).toMatchObject({ id: "d3", alsoIds: [] });
    expect(byName["Furnace thermostat"]).toMatchObject({ manufacturer: "Carrier", configurationUrl: "http://10.0.0.50", areaId: "mechanical_room" });
    expect(byName.HACS!.virtual).toBe(true);
    // Renamed in HA: still one thing with its other copy.
    const renamed = structuredClone(REGISTRY);
    renamed.devices[0]!.name_by_user = "Fridge Amp";
    expect(tidyRegistry(renamed).devices.find((d) => d.id === "d1")).toMatchObject({ name: "Fridge Amp", alsoIds: ["d2"] });
  });

  it("reads devices for owners and admins only, and knows what it already imported", async () => {
    const ha = new FakeHomeAssistant();
    const { user } = await setup({ homeAssistant: ha });
    const ann = await user("ann");
    const token = "t".repeat(40);
    const view = await json<{ devices: { id: string; itemId: string | null }[] }>(send(ann, "POST", "/api/v1/import/home-assistant/devices", { url: "http://homeassistant.local:8123", token }));
    expect(view.devices).toHaveLength(5);
    expect(ha.seen).toEqual([{ url: "http://homeassistant.local:8123", token }]);

    const bad = await send(ann, "POST", "/api/v1/import/home-assistant/devices", { url: "http://homeassistant.local:8123", token: "x".repeat(30) });
    expect(bad.status).toBe(502);
    expect(await json(bad)).toMatchObject({ error: { message: "Home Assistant didn't accept that token" } });
    expect((await send(ann, "POST", "/api/v1/import/home-assistant/devices", { url: "file:///etc/passwd", token })).status).toBe(422);

    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const first = await json<{ created: number }>(
      send(ann, "POST", "/api/v1/import", { source: "homeassistant", name: "Home Assistant", propertyId: home.id, rows: [{ name: "Kitchen Fridge Sonos Amp", brand: "Sonos", haDeviceId: "d1", place: "Main › Kitchen" }] }),
    );
    expect(first.created).toBe(1);
    const again = await json<{ created: number; skipped: unknown[] }>(
      send(ann, "POST", "/api/v1/import", { source: "homeassistant", name: "Home Assistant", propertyId: home.id, rows: [{ name: "Amp", haDeviceId: "d1" }] }),
    );
    expect(again).toMatchObject({ created: 0, skipped: [{ index: 0, reason: "Already in Ferret" }] });
    const after = await json<{ devices: { id: string; itemId: string | null }[] }>(send(ann, "POST", "/api/v1/import/home-assistant/devices", { url: "http://homeassistant.local:8123", token }));
    expect(after.devices.find((d) => d.id === "d1")!.itemId).toBeTruthy();
  });

  it("makes rooms without things, under their floor or in their own property, and finds them again", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const shop = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Shop" }));
    const rooms = (propertyId: string, places: object[]) =>
      json<{ batchId: string; created: number; placesCreated: number }>(send(ann, "POST", "/api/v1/import", { source: "homeassistant", name: "Home Assistant", propertyId, places, rows: [] }));

    expect(await rooms(home.id, [
      { path: "Main › Kitchen", haAreaId: "kitchen", haFloorId: "main" },
      { path: "Main › Pantry", haAreaId: "pantry", haFloorId: "main" },
    ])).toEqual({ batchId: "", created: 0, skipped: [], placesCreated: 3, categoriesCreated: 0 });
    expect(await rooms(shop.id, [{ path: "Shop Floor", haAreaId: "shop_floor" }])).toMatchObject({ placesCreated: 1 });
    // Again: nothing new. Then the floor is renamed in Ferret, and HA gets a new room on it: it still goes under it.
    expect(await rooms(home.id, [{ path: "Main › Kitchen", haAreaId: "kitchen", haFloorId: "main" }])).toMatchObject({ placesCreated: 0 });
    const tree = async () => json<{ properties: { name: string; locations: { id: string; name: string; children: { name: string }[] }[] }[] }>(ann.as("/api/v1/locations/tree"));
    const main = (await tree()).properties.find((p) => p.name === "Home")!.locations[0]!;
    await send(ann, "PATCH", `/api/v1/locations/${main.id}`, { name: "Main floor" });
    expect(await rooms(home.id, [{ path: "Main › Den", haAreaId: "den", haFloorId: "main" }])).toMatchObject({ placesCreated: 1 });
    const after = await tree();
    expect(after.properties.find((p) => p.name === "Home")!.locations.map((l) => [l.name, l.children.map((c) => c.name)])).toEqual([["Main floor", ["Den", "Kitchen", "Pantry"]]]);
    expect(after.properties.find((p) => p.name === "Shop")!.locations.map((l) => l.name)).toEqual(["Shop Floor"]);

    // A device in a room goes to that room's place, whatever the property.
    await send(ann, "POST", "/api/v1/import", { source: "homeassistant", name: "Home Assistant", propertyId: home.id, rows: [{ name: "Table saw", haDeviceId: "saw", haAreaId: "shop_floor" }] });
    expect(await json(ann.as("/api/v1/items"))).toMatchObject({ data: [{ name: "Table saw", place: "Shop › Shop Floor" }] });
  });

  it("offers what Home Assistant changed since the import, once, and what it no longer has", async () => {
    const ha = new FakeHomeAssistant();
    const { user } = await setup({ homeAssistant: ha });
    const ann = await user("ann");
    const token = "t".repeat(40);
    const read = () => json<{ devices: { id: string; itemId: string | null; changes: unknown[] }[]; areas: { id: string; locationId: string | null }[]; removed: { name: string }[] }>(
      send(ann, "POST", "/api/v1/import/home-assistant/devices", { url: "http://ha.local:8123", token }),
    );
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    await send(ann, "POST", "/api/v1/import", {
      source: "homeassistant", name: "Home Assistant", propertyId: home.id,
      places: [{ path: "Main › Kitchen", haAreaId: "kitchen", haFloorId: "main" }, { path: "Basement › Mechanical Room", haAreaId: "mechanical_room", haFloorId: "basement" }],
      rows: [
        { name: "Kitchen Fridge Sonos Amp", brand: "Sonos", model: "Amp", serialNumber: "SN-AMP-1", haDeviceId: "d1", haAreaId: "kitchen" },
        { name: "Furnace thermostat", brand: "Carrier", model: "SYSTXCCITC01-B", haDeviceId: "d9", haAreaId: "mechanical_room" },
      ],
    });
    const first = await read();
    expect(first.devices.every((d) => d.changes.length === 0)).toBe(true);
    expect(first.areas.find((a) => a.id === "kitchen")!.locationId).toBeTruthy();

    // In HA: the amp is renamed and moved; the thermostat is gone. In Ferret, someone renamed the amp themselves too.
    const amp = ha.reg.devices.find((d) => d.id === "d1")!;
    amp.name = "Fridge Amp";
    amp.area_id = "mechanical_room";
    ha.reg.devices = ha.reg.devices.filter((d) => d.id !== "d9");
    const ampItem = first.devices.find((d) => d.id === "d1")!.itemId!;
    await send(ann, "PATCH", `/api/v1/items/${ampItem}`, { name: "Kitchen speakers" });

    const second = await read();
    expect(second.devices.find((d) => d.id === "d1")!.changes).toEqual([
      { field: "name", ferret: "Kitchen speakers", ha: "Fridge Amp" },
      { field: "area", ferret: "Home › Main › Kitchen", ha: "Mechanical Room" },
    ]);
    expect(second.removed).toEqual([{ itemId: expect.any(String), name: "Furnace thermostat" }]);

    // Take the room, keep Ferret's name: both remembered, so neither is offered again.
    const snapshot = { name: "Fridge Amp", manufacturer: "Sonos", model: "Amp", serialNumber: "SN-AMP-1", areaId: "mechanical_room" };
    expect(await json(send(ann, "POST", "/api/v1/import/home-assistant/apply", { updates: [{ itemId: ampItem, haAreaId: "mechanical_room", snapshot }] }))).toEqual({ updated: 1 });
    expect(await json(ann.as(`/api/v1/items/${ampItem}`))).toMatchObject({ name: "Kitchen speakers", place: "Home › Basement › Mechanical Room" });
    expect((await read()).devices.find((d) => d.id === "d1")!.changes).toEqual([]);
    // Moving to a room that has no place yet is refused.
    expect((await send(ann, "POST", "/api/v1/import/home-assistant/apply", { updates: [{ itemId: ampItem, haAreaId: "outside", snapshot }] })).status).toBe(422);
  });

  it("turns an address into its WebSocket", () => {
    expect(websocketUrl("http://homeassistant.local:8123")).toBe("ws://homeassistant.local:8123/api/websocket");
    expect(websocketUrl("https://ha.example.com/proxy/")).toBe("wss://ha.example.com/proxy/api/websocket");
    expect(websocketUrl("https://ha.example.com/api/websocket")).toBe("wss://ha.example.com/api/websocket");
    expect(() => websocketUrl("http://me:pw@ha.local")).toThrow(/token signs in/);
  });
});
