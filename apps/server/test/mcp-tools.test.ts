/** The MCP tools that add and change things by kind (save_*), remove them (remove), and recalls, labels, photos. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { checkHousehold } from "../src/lib/recalls";
import type { RawRecall, Recalls } from "../src/ports";
import { FakeAi, photo, setup } from "./helpers";

type App = Awaited<ReturnType<typeof setup>>["app"];
type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;

async function keyFor(u: User) {
  const res = await u.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "Claude" }) });
  return ((await res.json()) as { key: string }).key;
}

async function connect(app: App, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://ferret.test/mcp"), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  type Content = { type: string; text?: string; data?: string; mimeType?: string };
  const raw = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Content[] };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    const text = result.content[0]!.text!;
    return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
  };
  return { call, raw };
}

async function start(opts: Parameters<typeof setup>[0] = {}) {
  const s = await setup(opts);
  const ann = await s.user("ann");
  return { ...s, ann, ...(await connect(s.app, await keyFor(ann))) };
}

describe("MCP: warranties", () => {
  it("adds, changes and removes a warranty, from a receipt on the same item only", async () => {
    const { ann, call } = await start();
    const tv = await ann.addItem({ name: "TV" });
    const lamp = await ann.addItem({ name: "Lamp" });
    const receipt = await ann.upload(tv.id, await photo(), "receipt.jpg", "document");
    const lampPhoto = await ann.upload(lamp.id, await photo(), "lamp.jpg");

    const added = (await call("save_warranty", { itemId: tv.id, provider: "Sony", startsOn: "2026-01-10", endsOn: "2028-01-10", attachmentId: receipt.id })).json();
    expect(added).toMatchObject({ provider: "Sony", endsOn: "2028-01-10", status: "active", itemId: tv.id });
    expect(added).not.toHaveProperty("householdId");
    expect((await call("get_item", { id: tv.id })).json().warranties).toEqual([expect.objectContaining({ id: added.id, provider: "Sony" })]);

    expect((await call("save_warranty", { itemId: tv.id, endsOn: "2028-01-01", attachmentId: lampPhoto.id })).text).toContain("isn't attached to this item");
    expect((await call("save_warranty", { itemId: tv.id, startsOn: "2028-01-01", endsOn: "2027-01-01" })).isError).toBe(true);

    const extended = (await call("save_warranty", { id: added.id, endsOn: "2029-01-10", coverage: "Extended: parts and labour" })).json();
    expect(extended).toMatchObject({ endsOn: "2029-01-10", coverage: "Extended: parts and labour", provider: "Sony" });
    expect((await call("save_warranty", { id: added.id, endsOn: "2025-01-01" })).text).toBe("A warranty can't end before it starts");

    expect((await call("remove", { kind: "warranty", id: added.id })).json()).toEqual({ removed: "warranty", id: added.id });
    expect((await call("get_item", { id: tv.id })).json().warranties).toEqual([]);
    expect((await call("remove", { kind: "warranty", id: added.id })).text).toBe("Warranty not found");
  });
});

describe("MCP: asking about one item", () => {
  it("answers from that item only when given its id", async () => {
    const chat = new FakeAi([{ answer: "Clean the canister filter by turning its handle.", found: true, sources: [1] }]);
    const { ann, call } = await start({ chat });
    const collector = await ann.addItem({ name: "Dust collector", notes: "Turn the handle to clean the filter." });
    await ann.addItem({ name: "Furnace", notes: "Filter: 16x25x1" });
    const answer = (await call("ask_inventory", { question: "How do I clean the filter?", itemId: collector.id })).json();
    expect(answer).toMatchObject({ found: true, citations: [expect.objectContaining({ itemId: collector.id })] });
    expect(chat.calls.at(-1)!.prompt).toContain("Turn the handle");
    expect(chat.calls.at(-1)!.prompt).not.toContain("16x25x1"); // the furnace isn't asked about
  });
});

describe("MCP: places and many things at once", () => {
  it("renames and moves locations, moves things in bulk, and removes only empty places", async () => {
    const { ann, call } = await start();
    const home = (await call("save_property", { name: "Home" })).json();
    const garage = (await call("save_location", { name: "Garage", children: ["Shelf 1"] })).json();
    const basement = (await call("save_location", { name: "Basement" })).json();
    const a = await ann.addItem({ name: "Paint", locationId: garage.children[0].id });
    const b = await ann.addItem({ name: "Brushes", locationId: garage.children[0].id });

    expect((await call("save_property", { id: home.id, name: "Maple House", city: "Denver" })).json()).toMatchObject({ name: "Maple House", city: "Denver" });
    const shelf = (await call("save_location", { id: garage.children[0].id, name: "Top shelf", parentId: basement.id })).json();
    expect(shelf.path).toBe("Maple House › Basement › Top shelf");
    expect((await call("get_item", { id: a.id })).json().location).toBe("Maple House › Basement › Top shelf");

    expect((await call("remove", { kind: "location", id: shelf.id })).isError).toBe(true); // things are kept there
    expect((await call("bulk_update_items", { action: "move", ids: [a.id, b.id] })).text).toBe("move needs locationId");
    expect((await call("bulk_update_items", { action: "move", ids: [a.id, b.id], locationId: garage.id })).json()).toEqual({ done: 2, failed: [] });
    expect((await call("bulk_update_items", { action: "tag", ids: [a.id, b.id], tag: "decorating" })).json()).toMatchObject({ done: 2 });
    expect((await call("get_item", { id: b.id })).json()).toMatchObject({ location: "Maple House › Garage", tags: ["decorating"] });

    expect((await call("remove", { kind: "location", id: shelf.id })).json()).toEqual({ removed: "location", id: shelf.id });
    expect((await call("remove", { kind: "property", id: home.id })).isError).toBe(true); // Paint and Brushes are in its garage
    await call("bulk_update_items", { action: "move", ids: [a.id, b.id], locationId: null });
    expect((await call("remove", { kind: "property", id: home.id })).json()).toEqual({ removed: "property", id: home.id });
    expect((await call("list_locations")).json().properties).toEqual([]);
  });
});

describe("MCP: maintenance, categories, loans, labels", () => {
  it("reschedules a task, adds a category, changes a loan and puts a label on a box", async () => {
    const { ann, call } = await start();
    const furnace = await ann.addItem({ name: "Furnace" });
    const task = (await call("save_maintenance", { title: "Replace filter", itemId: furnace.id, intervalCount: 3, intervalUnit: "month" })).json();
    const moved = (await call("save_maintenance", { id: task.id, dueOn: "2030-02-01", intervalCount: 6, intervalUnit: "month" })).json();
    expect(moved).toMatchObject({ dueOn: "2030-02-01", repeats: "every 6 months" });
    expect((await call("save_maintenance", { id: task.id, intervalCount: 2 })).isError).toBe(true);

    const tools = (await call("save_category", { name: "Tools" })).json();
    const power = (await call("save_category", { name: "Power tools", parentId: tools.id })).json();
    expect(power).toMatchObject({ name: "Power tools", parentId: tools.id });

    const ladder = await ann.addItem({ name: "Ladder" });
    const loan = (await call("save_loan", { itemId: ladder.id, direction: "lent", person: "Sam" })).json();
    expect((await call("save_loan", { id: loan.id, dueOn: "2030-05-01", person: "Sam Lee" })).json()).toMatchObject({ person: "Sam Lee", dueOn: "2030-05-01" });

    const bin = await ann.addItem({ name: "Camping bin", isContainer: true });
    const { codes } = (await (await ann.as("/api/v1/labels/blank", { method: "POST", body: JSON.stringify({ count: 1 }) })).json()) as { codes: string[] };
    expect((await call("attach_label", { code: codes[0]!.toLowerCase(), itemId: bin.id })).json()).toEqual({ label: codes[0], on: "Camping bin" });
    expect((await call("search_inventory", { query: codes[0]! })).json().items[0]).toMatchObject({ id: bin.id });
    expect((await call("attach_label", { code: codes[0]!, itemId: ladder.id })).isError).toBe(true); // already on the bin
    expect((await call("attach_label", { code: "ASSET-0042", itemId: ladder.id })).json()).toEqual({ ownLabel: "ASSET-0042" });
    expect((await call("attach_label", { code: "X" })).text).toBe("Give an itemId or a locationId");
  });
});

describe("MCP: coverage and collections", () => {
  it("sets, replaces and removes an insurance limit; starts and renames a collection", async () => {
    const { ann, call } = await start();
    await ann.addItem({ name: "Ring", valueCents: 500000, tags: ["jewelry"] });
    const added = (await call("save_coverage_limit", { label: "Jewelry rider", limitCents: 150000, scope: "tag", tag: "jewelry" })).json();
    expect((await call("coverage_check")).json().limits).toEqual([
      expect.objectContaining({ id: added.id, label: "Jewelry rider", scope: "tag", tag: "jewelry", shortCents: 350000 }),
    ]);
    expect((await call("save_coverage_limit", { label: "Everything", limitCents: 1, scope: "category" })).text).toContain("Which category?");
    await call("save_coverage_limit", { id: added.id, label: "Jewelry rider", limitCents: 600000, scope: "tag", tag: "jewelry" });
    expect((await call("coverage_check")).json().limits[0]).not.toHaveProperty("shortCents");
    expect((await call("remove", { kind: "coverage_limit", id: added.id })).json()).toEqual({ removed: "coverage_limit", id: added.id });
    expect((await call("coverage_check")).json().limits).toEqual([]);

    expect((await call("list_templates")).json()).toEqual({ templates: [] });
    await ann.as("/api/v1/templates/starter", { method: "POST" });
    const coin = (await call("list_templates")).json().templates.find((t: { name: string }) => /coin/i.test(t.name));
    expect(coin.fields.length).toBeGreaterThan(0);
    const quarters = (await call("save_collection", { name: "Quarters", templateId: coin.id })).json();
    expect(quarters).toMatchObject({ name: "Quarters", templateId: coin.id });
    expect((await call("save_collection", { id: quarters.id, name: "State quarters" })).json()).toMatchObject({ name: "State quarters" });
  });
});

describe("MCP: save_* and remove", () => {
  it("changes and removes categories, providers, collections and claims; an add says what it's missing", async () => {
    const { ann, call } = await start();
    const tools = (await call("save_category", { name: "Tools" })).json();
    const power = (await call("save_category", { name: "Power tols" })).json();
    expect((await call("save_category", { id: power.id, name: "Power tools", parentId: tools.id })).json()).toMatchObject({ name: "Power tools", parentId: tools.id });
    const drill = await ann.addItem({ name: "Drill", categoryId: power.id });
    expect((await call("remove", { kind: "category", id: power.id })).json()).toEqual({ removed: "category", id: power.id });
    expect((await call("get_item", { id: drill.id })).json().categoryId).toBe(tools.id); // moved up to the parent

    const plumber = (await call("save_provider", { name: "Pipe Pros", phone: "303-555-0199" })).json();
    expect((await call("save_provider", { id: plumber.id, phone: "303-555-0100" })).json()).toMatchObject({ name: "Pipe Pros", phone: "303-555-0100" });
    expect((await call("remove", { kind: "provider", id: plumber.id })).json()).toMatchObject({ removed: "provider" });
    expect((await call("list_providers")).json().providers ?? []).toEqual([]);

    const vinyl = (await call("save_collection", { name: "Records" })).json();
    expect((await call("remove", { kind: "collection", id: vinyl.id })).json()).toMatchObject({ removed: "collection" });
    expect((await call("list_collections")).json().collections ?? []).toEqual([]);

    const tv = await ann.addItem({ name: "TV" });
    const w = (await call("save_warranty", { itemId: tv.id, endsOn: "2030-01-01" })).json();
    const claim = (await call("save_warranty_claim", { warrantyId: w.id, problem: "No sound" })).json();
    expect((await call("remove", { kind: "claim", id: claim.id })).json()).toMatchObject({ removed: "claim" });

    // Adding needs what the REST route needs; the error says which.
    expect((await call("save_warranty", { endsOn: "2030-01-01" })).text).toBe("To add a warranty, give the item's itemId");
    expect((await call("save_warranty", { itemId: tv.id })).text).toMatch(/^To add a warranty: endsOn/);
    expect((await call("save_loan", { direction: "lent", person: "Sam" })).text).toBe("To record a loan, give the item's itemId");
    expect((await call("save_loan", { itemId: tv.id, person: "Sam" })).text).toMatch(/^To record a loan: direction/);
    expect((await call("save_category", {})).text).toMatch(/^To add a category: name/);
    expect((await call("save_warranty_claim", { problem: "x" })).text).toBe("To file a claim, give the warranty's warrantyId");
    expect((await call("remove", { kind: "provider", id: "nope" })).isError).toBe(true);
  });
});

describe("MCP: recalls", () => {
  const kettleRecall: RawRecall = { RecallID: 1, RecallDate: "2024-06-01T00:00:00", Title: "Acme Recalls Kettles", Products: [{ Name: "Electric Kettle" }], ProductUPCs: [{ UPC: "012345678905" }] };
  class OneRecall implements Recalls {
    async forBrand(brand: string) {
      return brand === "acme" ? [kettleRecall] : [];
    }
  }

  it("lists the household's recalls and marks one dealt with", async () => {
    const { ann, call, db, deps } = await start({ recalls: new OneRecall() });
    const kettle = await ann.addItem({ name: "Kettle", brand: "Acme", barcode: "012345678905" });
    await ann.as("/api/v1/server/recalls", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    await checkHousehold({ deps, db, householdId: ann.householdId, userId: "", timeZone: "UTC", currency: "USD", via: "web" });

    const [found] = (await call("list_recalls")).json().recalls;
    expect(found).toMatchObject({ item: "Kettle", itemId: kettle.id, match: "barcode", status: "open", title: "Acme Recalls Kettles" });
    expect((await call("set_recall_status", { id: found.id, status: "done" })).json()).toEqual({ id: found.id, status: "done" });
    expect((await call("list_recalls")).json().recalls).toEqual([]);
    expect((await call("list_recalls", { itemId: kettle.id })).json().recalls).toEqual([expect.objectContaining({ status: "done" })]);
    expect((await call("set_recall_status", { id: found.id, status: "done" })).text).toBe("It's already that way");
  });
});

describe("MCP: photos", () => {
  it("shows a photo as an image, small or large, and never another household's", async () => {
    const { ann, raw, call, user } = await start();
    const drill = await ann.addItem({ name: "Drill" });
    const pic = await ann.upload(drill.id, await photo(), "drill.jpg");

    const small = await raw("get_photo", { id: pic.id });
    expect(small.content[0]).toMatchObject({ type: "image", mimeType: "image/webp" });
    expect(small.content[0]!.data!.length).toBeGreaterThan(100);
    const large = await raw("get_photo", { id: pic.id, size: "large" });
    expect(large.content[0]).toMatchObject({ type: "image" });
    expect(large.content[0]!.data!.length).toBeGreaterThan(small.content[0]!.data!.length);
    expect(JSON.parse(large.content[1]!.text!)).toMatchObject({ id: pic.id, kind: "photo", item: drill.id });

    const bob = await user("bob");
    const theirs = await bob.upload((await bob.addItem({ name: "Safe" })).id, await photo(), "safe.jpg");
    expect((await call("get_photo", { id: theirs.id })).text).toBe("Photo not found");
  });
});

describe("MCP: keeping track", () => {
  it("marks things seen or missing, lists what can't be found, and walks a room review", async () => {
    const { ann, call } = await start();
    const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
    const home = await json<{ id: string }>(ann.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Home" }) }));
    const garage = await json<{ id: string }>(ann.as("/api/v1/locations", { method: "POST", body: JSON.stringify({ name: "Garage", propertyId: home.id }) }));
    const shed = await json<{ id: string }>(ann.as("/api/v1/locations", { method: "POST", body: JSON.stringify({ name: "Shed", propertyId: home.id }) }));
    const drill = await ann.addItem({ name: "Drill", locationId: garage.id });
    const saw = await ann.addItem({ name: "Saw", locationId: garage.id });
    const ladder = await ann.addItem({ name: "Ladder", locationId: garage.id });

    expect((await call("mark_seen", { id: drill.id, status: "missing" })).json()).toEqual({ name: "Drill", missing: true });
    const lost = (await call("list_items", { misplaced: true })).json();
    expect(lost.items.map((i: { name: string }) => i.name)).toEqual(["Drill"]);
    expect(lost.items[0].missingSince).toBeTruthy();
    expect((await call("mark_seen", { id: drill.id, status: "here" })).json()).toEqual({ name: "Drill", seen: true, found: true });
    expect((await call("get_item", { id: drill.id })).json().lastSeen).toMatchObject({ how: "confirmed" });
    expect((await call("list_items", { misplaced: true })).json().items).toEqual([]);

    const rooms = (await call("rooms_to_review")).json();
    expect(rooms.places[0]).toMatchObject({ place: "Home › Garage", things: 3, lastReviewed: "never" });

    const started = (await call("room_review", { locationId: garage.id })).json();
    expect(started.toCheck.map((i: { name: string }) => i.name)).toEqual(["Drill", "Ladder", "Saw"]);
    const mid = (await call("room_review", { locationId: garage.id, checks: [{ id: drill.id, found: "here" }, { id: saw.id, found: "moved", locationId: shed.id }, { id: ladder.id, found: "gone" }] })).json();
    expect(mid.problems).toEqual([`${ladder.id}: Say what happened to it first`]);
    expect(mid.toCheck.map((i: { name: string }) => i.name)).toEqual(["Ladder"]);
    const done = (await call("room_review", { locationId: garage.id, checks: [{ id: ladder.id, found: "missing" }], finish: true })).json();
    expect(done).toMatchObject({ place: "Home › Garage", finished: true });
    expect(done.checked.map((c: { name: string; found: string }) => `${c.name}:${c.found}`).sort()).toEqual(["Drill:here", "Ladder:missing", "Saw:moved"]);
    expect(done).not.toHaveProperty("leftUnchecked");
  });
});
