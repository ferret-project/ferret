/** API keys (Settings → API keys) and the MCP server Claude talks to with them. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activity, member } from "../src/db/schema";
import { FakeAi, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;

async function makeKey(u: User, body: Record<string, unknown> = { name: "Claude" }) {
  const res = await u.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string; start: string; readOnly: boolean };
}

/** Calls the REST API with only an API key (no cookie). */
const withKey = (app: Awaited<ReturnType<typeof setup>>["app"], key: string) => (url: string, init: RequestInit = {}) =>
  app.request(url, {
    ...init,
    headers: {
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${key}`,
      ...init.headers,
    },
  });

/** An MCP client connected in-process, the way Claude connects over HTTP. */
async function connect(app: Awaited<ReturnType<typeof setup>>["app"], key: string, mode: "auto" | "legacy" = "auto") {
  const transport = new StreamableHTTPClientTransport(new URL("http://ferret.test/mcp"), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" }, mode === "auto" ? { versionNegotiation: { mode } } : {});
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]!.text;
    return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
  };
  return { client, call };
}

describe("API keys", () => {
  it("are made, listed and revoked from a signed-in session, and work on the REST API", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    await ann.addItem({ name: "Cordless drill" });

    const made = await makeKey(ann, { name: "Claude Code" });
    expect(made.key).toMatch(/^ferret_/);
    expect(made.start).toBe(made.key.slice(0, 11));

    const list = (await (await ann.as("/api/v1/api-keys")).json()) as { data: { id: string; name: string }[] };
    expect(list.data).toEqual([expect.objectContaining({ id: made.id, name: "Claude Code", readOnly: false })]);
    expect(JSON.stringify(list)).not.toContain(made.key);

    const api = withKey(app, made.key);
    const items = (await (await api("/api/v1/items")).json()) as { data: { name: string }[] };
    expect(items.data.map((i) => i.name)).toEqual(["Cordless drill"]);
    // x-api-key works too
    expect((await app.request("/api/v1/items", { headers: { "x-api-key": made.key } })).status).toBe(200);

    expect((await ann.as(`/api/v1/api-keys/${made.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api("/api/v1/items")).status).toBe(401);
  });

  it("can't manage keys themselves, or be made through Better Auth directly", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const { key } = await makeKey(ann);
    const api = withKey(app, key);
    expect((await api("/api/v1/api-keys")).status).toBe(403);
    expect((await api("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "more" }) })).status).toBe(403);
    // The plugin's own create endpoint is off: it would let a key skip the household binding.
    const direct = await ann.as("/api/auth/api-key/create", { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(direct.status).toBe(404);
    // A key is not a session for Better Auth's endpoints.
    expect(await (await api("/api/auth/get-session")).json()).toBeNull();
  });

  it("are bound to one household", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const bobsDrill = await bob.addItem({ name: "Bob's drill" });
    const { key } = await makeKey(ann);
    const api = withKey(app, key);

    expect((await api(`/api/v1/items/${bobsDrill.id}`)).status).toBe(404);
    expect((await api("/api/v1/items", { headers: { "X-Household-Id": bob.householdId } })).status).toBe(403);
    // Bob's keys don't show up for Ann, and she can't revoke them.
    const bobs = await makeKey(bob);
    expect((await ann.as(`/api/v1/api-keys/${bobs.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("stop working when their owner leaves the household", async () => {
    const { app, db, user } = await setup();
    const ann = await user("ann");
    const { key } = await makeKey(ann);
    await db.delete(member).where(eq(member.organizationId, ann.householdId));
    expect((await withKey(app, key)("/api/v1/items")).status).toBe(403);
  });

  it("can be read-only", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const { key, readOnly } = await makeKey(ann, { name: "Reader", readOnly: true });
    expect(readOnly).toBe(true);
    const api = withKey(app, key);
    expect((await api("/api/v1/items")).status).toBe(200);
    expect((await api("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Nope" }) })).status).toBe(403);
  });

  it("record changes as made via the API", async () => {
    const { app, db, user } = await setup();
    const ann = await user("ann");
    const { key } = await makeKey(ann);
    await withKey(app, key)("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Ladder" }) });
    const [row] = await db.select().from(activity).where(eq(activity.action, "item.create"));
    expect(row?.via).toBe("api");
  });

  it("reject unknown keys", async () => {
    const { app } = await setup();
    expect((await withKey(app, "ferret_not-a-real-key")("/api/v1/items")).status).toBe(401);
  });
});

describe("item updates", () => {
  it("only change the fields sent", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const it = await ann.addItem({ name: "Socks", quantity: 6, favorite: true });
    const res = await ann.as(`/api/v1/items/${it.id}`, { method: "PATCH", body: JSON.stringify({ name: "Wool socks" }) });
    expect(await res.json()).toMatchObject({ name: "Wool socks", quantity: 6, favorite: true });
  });

  it("can't point at another household's location", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const prop = (await (await bob.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Bob's" }) })).json()) as { id: string };
    const loc = (await (
      await bob.as("/api/v1/locations", { method: "POST", body: JSON.stringify({ propertyId: prop.id, name: "Shed" }) })
    ).json()) as { id: string };
    const res = await ann.as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Rake", locationId: loc.id }) });
    expect(res.status).toBe(404);
  });
});

describe("MCP server", () => {
  it("needs an API key", async () => {
    const { app } = await setup();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("serves both protocol eras", async () => {
    const { app, user } = await setup();
    const { key } = await makeKey(await user("ann"));
    for (const mode of ["auto", "legacy"] as const) {
      const { client } = await connect(app, key, mode);
      expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("search_inventory");
    }
  });

  it("sets up places, adds and moves items, and reports their value", async () => {
    const { app, db, user } = await setup();
    const ann = await user("ann");
    const { call } = await connect(app, (await makeKey(ann)).key);

    expect((await call("create_location", { name: "Garage" })).text).toContain("no properties yet");
    const home = (await call("create_property", { name: "Maple House" })).json();
    expect(home).toMatchObject({ name: "Maple House", type: "home" });
    const garage = (await call("create_location", { name: "Garage", children: ["Shelf 1", "Shelf 2", "Shelf 3"] })).json();
    expect(garage.path).toBe("Maple House › Garage");
    expect(garage.children.map((c: { path: string }) => c.path)).toEqual([
      "Maple House › Garage › Shelf 1",
      "Maple House › Garage › Shelf 2",
      "Maple House › Garage › Shelf 3",
    ]);
    const kitchen = (await call("create_location", { name: "Kitchen" })).json();

    const drill = (
      await call("create_item", { name: "Cordless drill", brand: "DeWalt", purchasePriceCents: 12999, locationId: garage.children[1].id })
    ).json();
    expect(drill).toMatchObject({ name: "Cordless drill", location: "Maple House › Garage › Shelf 2", quantity: 1 });
    expect(drill).not.toHaveProperty("householdId");
    expect(drill).not.toHaveProperty("serialNumber"); // empty fields are left out
    await call("create_item", { name: "Stand mixer", valueCents: 30000, locationId: kitchen.id });
    await call("create_item", { name: "Mystery box" });

    const found = (await call("search_inventory", { query: "drill" })).json();
    expect(found.items[0]).toMatchObject({ id: drill.id, location: "Maple House › Garage › Shelf 2", matched: { via: "words" } });

    const inGarage = (await call("list_items", { locationId: garage.id })).json();
    expect(inGarage.items.map((i: { name: string }) => i.name)).toEqual(["Cordless drill"]);

    const moved = (await call("move_item", { id: drill.id, locationId: kitchen.id })).json();
    expect(moved.location).toBe("Maple House › Kitchen");
    const updated = (await call("update_item", { id: drill.id, serialNumber: "SN-42" })).json();
    expect(updated).toMatchObject({ serialNumber: "SN-42", brand: "DeWalt", location: "Maple House › Kitchen" });

    const tree = (await call("list_locations")).json();
    expect(tree.properties[0].locations.map((l: { name: string; itemCount: number }) => [l.name, l.itemCount])).toEqual([
      ["Garage", 0],
      ["Kitchen", 2],
    ]);
    expect(tree.unplacedItems).toBe(1);

    const report = (await call("inventory_report")).json();
    expect(report.total).toEqual({ valueCents: 42999, items: 3, itemsWithoutValue: 1 });
    expect(report.byRoom[0]).toMatchObject({ name: "Maple House › Kitchen", valueCents: 42999 });
    expect(report.mostValuable[0]).toMatchObject({ name: "Stand mixer", valueCents: 30000 });

    const item = (await call("get_item", { id: drill.id })).json();
    expect(item).toMatchObject({ name: "Cordless drill", warranties: [], attachments: [] });

    expect((await call("delete_item", { id: drill.id })).json()).toEqual({ removed: { id: drill.id, name: "Cordless drill" } });
    expect((await call("get_item", { id: drill.id })).isError).toBe(true);
    // Deleted by mistake? It's in Recently deleted, and restore_item brings it back.
    expect((await call("recently_deleted")).json().items).toEqual([expect.objectContaining({ id: drill.id, name: "Cordless drill" })]);
    expect((await call("restore_item", { id: drill.id })).json()).toEqual({ restored: { id: drill.id, name: "Cordless drill" } });
    expect((await call("get_item", { id: drill.id })).json()).toMatchObject({ name: "Cordless drill" });

    const log = await db.select().from(activity).where(and(eq(activity.householdId, ann.householdId), eq(activity.via, "mcp")));
    expect(log.map((a) => a.summary)).toContain("Moved Cordless drill to Maple House › Kitchen");
  });

  it("only sees the key's household", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const secret = await bob.addItem({ name: "Bob's safe" });
    const { call } = await connect(app, (await makeKey(ann)).key);
    expect((await call("get_item", { id: secret.id })).text).toBe("Item not found");
    expect((await call("search_inventory", { query: "safe" })).json().items).toEqual([]);
    expect((await call("delete_item", { id: secret.id })).isError).toBe(true);
    expect((await bob.as(`/api/v1/items/${secret.id}`)).status).toBe(200);
  });

  it("offers a read-only key only the read tools", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const { client } = await connect(app, (await makeKey(ann, { name: "Reader", readOnly: true })).key);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ask_inventory",
      "coverage_check",
      "get_item",
      "inventory_report",
      "list_categories",
      "list_collections",
      "room_scan_results",
      "list_items",
      "item_history",
      "list_loans",
      "list_locations",
      "list_maintenance",
      "list_providers",
      "list_warranties",
      "lookup_barcode",
      "recently_deleted",
      "search_inventory",
      "shopping_list",
      "what_needs_attention",
    ].sort());
  });

  it("tracks maintenance: add, list what's due, mark done", async () => {
    const { app, db, user } = await setup();
    const ann = await user("ann");
    const furnace = await ann.addItem({ name: "Furnace" });
    const { call } = await connect(app, (await makeKey(ann)).key);

    const added = (await call("add_maintenance", { title: "Replace filter", itemId: furnace.id, intervalCount: 3, intervalUnit: "month", dueOn: "2020-01-01" })).json();
    expect(added).toMatchObject({ title: "Replace filter", itemName: "Furnace", repeats: "every 3 months", status: "overdue" });
    expect(added).not.toHaveProperty("intervalCount");

    const overdue = (await call("list_maintenance", { status: "overdue" })).json();
    expect(overdue.tasks.map((t: { title: string }) => t.title)).toEqual(["Replace filter"]);

    const done = (await call("complete_maintenance", { id: added.id, note: "MERV 11" })).json();
    expect(done.status).toBe("upcoming");
    expect((await call("list_maintenance", { status: "overdue" })).json().tasks).toEqual([]);
    const [entry] = await db.select().from(activity).where(eq(activity.entityId, added.id)).orderBy(activity.createdAt);
    expect(entry).toMatchObject({ via: "mcp" });

    expect((await call("add_maintenance", { title: "x", intervalCount: 2 })).isError).toBe(true);

    const plumber = (await call("add_provider", { name: "Pipe Pros", trade: "Plumber", phone: "303-555-0199" })).json();
    const flush = (await call("add_maintenance", { title: "Flush water heater", intervalCount: 1, intervalUnit: "year", providerId: plumber.id })).json();
    expect(flush).toMatchObject({ providerName: "Pipe Pros" });
    await call("complete_maintenance", { id: flush.id, costCents: 12000 });
    const { providers } = (await call("list_providers")).json();
    expect(providers[0]).toMatchObject({ name: "Pipe Pros", tasks: 1, visits: 1, spentCents: 12000 });
  });

  it("adds items from photos, then shows what the model read for the person to confirm", async () => {
    const ai = new FakeAi([{ description: "A yellow DeWalt drill.", text: "DCD771C2", name: "Cordless drill", brand: "DEWALT", model: "DCD771C2" }]);
    const { app, jobs, user } = await setup({ ai });
    const ann = await user("ann");
    const { call } = await connect(app, (await makeKey(ann)).key);
    const data = Buffer.from(await photo()).toString("base64");

    const made = (await call("add_item_from_photo", { data, filename: "drill.png" })).json();
    expect(made).toMatchObject({ name: "New item" });
    await jobs.drain();
    const item = (await call("get_item", { id: made.id })).json();
    // Suggested, not applied: the name stays until someone confirms.
    expect(item.name).toBe("New item");
    expect(item.attachments[0]).toMatchObject({ kind: "photo", analysis: "done", suggestions: { name: "Cordless drill", brand: "DEWALT" } });

    expect((await call("add_photo", { itemId: made.id, data: "bm90IGFuIGltYWdlIGF0IGFsbA==" })).text).toContain("Unsupported file type");
    expect((await call("add_photo", { itemId: made.id, data, kind: "photo" })).json()).toMatchObject({ kind: "photo", analysis: "pending" });
  });

  it("files and follows warranty claims", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const tv = await ann.addItem({ name: "TV" });
    const w = (await (await ann.as(`/api/v1/items/${tv.id}/warranties`, { method: "POST", body: JSON.stringify({ endsOn: "2030-01-01" }) })).json()) as { id: string };
    const { call } = await connect(app, (await makeKey(ann)).key);
    const claim = (await call("file_warranty_claim", { warrantyId: w.id, problem: "Dead pixels", reference: "LG-1" })).json();
    expect(claim).toMatchObject({ status: "filed", reference: "LG-1" });
    expect((await call("update_warranty_claim", { id: claim.id, status: "denied", resolution: "Not covered" })).json()).toMatchObject({ status: "denied" });
    const got = (await call("get_item", { id: tv.id })).json();
    expect(got.warranties[0].claims[0]).toMatchObject({ problem: "Dead pixels", status: "denied", resolution: "Not covered" });
  });

  it("files items under categories and tags", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    await ann.as("/api/v1/categories/starter", { method: "POST" });
    const { call } = await connect(app, (await makeKey(ann)).key);

    const { categories } = (await call("list_categories")).json();
    const tools = categories.find((c: { name: string }) => c.name === "Tools");
    const drill = (await call("create_item", { name: "Drill", categoryId: tools.id, tags: ["Garage sale"] })).json();
    expect(drill).toMatchObject({ categoryId: tools.id, tags: ["Garage sale"] });

    const sale = (await call("list_items", { tag: "garage sale" })).json();
    expect(sale.items.map((i: { name: string }) => i.name)).toEqual(["Drill"]);
    const inTools = (await call("list_items", { categoryId: tools.id })).json();
    expect(inTools.total).toBe(1);
    const report = (await call("inventory_report")).json();
    expect(report.byCategory[0]).toMatchObject({ name: "Tools", items: 1 });
  });

  it("returns validation problems as tool errors Claude can read", async () => {
    const { app, user } = await setup();
    const { call } = await connect(app, (await makeKey(await user("ann"))).key);
    const res = await call("create_item", { name: "Ghost", locationId: "nowhere" });
    expect(res).toMatchObject({ isError: true, text: "Location not found" });
  });
});

describe("adjust_stock", () => {
  it("uses up and restocks, never below 0, in the item's stock history", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const aa = await ann.addItem({ name: "AA batteries (4-pack)", quantity: 2 });
    const { call } = await connect(app, (await makeKey(ann)).key);
    expect((await call("adjust_stock", { id: aa.id, delta: -1, note: "TV remote" })).json()).toEqual({ quantity: 1, changedBy: -1 });
    expect((await call("adjust_stock", { id: aa.id, delta: -5 })).json()).toEqual({ quantity: 0, changedBy: -1, note: "Can't go below 0" });
    expect((await call("adjust_stock", { id: aa.id, delta: 0 })).isError).toBe(true);
    const history = (await (await ann.as(`/api/v1/items/${aa.id}/stock`)).json()) as { movements: { delta: number; via: string; note: string | null }[] };
    expect(history.movements.map((m) => [m.delta, m.via, m.note])).toEqual([[-1, "mcp", null], [-1, "mcp", "TV remote"]]);
  });
});

describe("where things came from", () => {
  it("records how each thing was added: the app's way, Claude, a script — and the app can't claim to be Claude", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const get = async (id: string) => (await (await ann.as(`/api/v1/items/${id}`)).json()) as { origin: string; originDetail: string | null; addedBy: string };

    const typed = await ann.addItem({ name: "Lamp" });
    const scanned = await ann.addItem({ name: "Batteries", origin: "scan" });
    expect(await get(typed.id)).toMatchObject({ origin: "app", originDetail: null, addedBy: "ann" });
    expect(await get(scanned.id)).toMatchObject({ origin: "scan" });
    expect((await ann.as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Sneaky", origin: "claude" }) })).status).toBe(422);

    const key = await makeKey(ann, { name: "Inventory script" });
    const viaKey = await app.request("/api/v1/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ name: "Router", origin: "photos" }), // the key decides, not what it says
    });
    expect(await get(((await viaKey.json()) as { id: string }).id)).toMatchObject({ origin: "api", originDetail: "Inventory script" });

    const claude = await makeKey(ann, { name: "Claude Code" });
    const { call } = await connect(app, claude.key);
    const made = (await call("create_item", { name: "Kettle" })).json() as { id: string };
    expect(await get(made.id)).toMatchObject({ origin: "claude", originDetail: "Claude Code" });

    const imported = (await (
      await ann.as("/api/v1/import", { method: "POST", body: JSON.stringify({ source: "csv", name: "orders.csv", rows: [{ name: "Toaster" }] }) })
    ).json()) as { batchId: string };
    expect(imported.batchId).toBeTruthy();
    const toaster = ((await (await ann.as("/api/v1/items?q=toaster")).json()) as { data: { id: string }[] }).data[0]!;
    expect(await get(toaster.id)).toMatchObject({ origin: "spreadsheet", originDetail: "orders.csv" });

    // "Show me what Claude added": in the app's list, and Claude asking about its own work.
    const names = async (url: string) => ((await (await ann.as(url)).json()) as { data: { name: string }[] }).data.map((i) => i.name);
    expect(await names("/api/v1/items?origin=claude")).toEqual(["Kettle"]);
    expect(await names("/api/v1/items?origin=app")).toEqual(["Lamp"]);
    expect(await names("/api/v1/items?origin=claude&q=lamp")).toEqual([]);
    expect((await call("list_items", { origin: "claude" })).json().items.map((i: { name: string }) => i.name)).toEqual(["Kettle"]);
  });
});
