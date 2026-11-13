/**
 * Households can't reach each other — across every route at once, so a new route is covered without anyone
 * remembering to test it. Ann's household gets one of everything, each with "ANNSECRET" in what people type; then
 * Bob (his own household) calls every /api/v1 route in OPERATIONS with Ann's ids in the path and in what he sends:
 * with his session, with his API key, and asking for Ann's household outright. Then:
 *   - nothing Bob gets back contains ANNSECRET (or Ann's photo's bytes);
 *   - a route aimed at one of Ann's things (an id in its path) answers 4xx;
 *   - every row of Ann's household is exactly as it was (Bob changed and deleted nothing of hers).
 * Routes that need no sign-in (share and borrower links, invitations) are left out: their token is the credential.
 */
import { eq, getTableColumns, is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";
import { OPERATIONS } from "../src/lib/openapi";
import { FakeAi, FakeDownloader, FakeNotifier, FakeProducts, MemoryVectors, pdf, photo, setup } from "./helpers";

const SECRET = "ANNSECRET";
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

/** Every table that holds a household's rows (it has a household_id column). */
const householdTables = (Object.values(schema) as unknown[]).filter(
  (t): t is SQLiteTable => is(t, SQLiteTable) && getTableConfig(t).columns.some((c) => c.name === "household_id"),
);

async function annHousehold() {
  // The optional services on, so their routes (and search by meaning, through the vector store) really run.
  const t = await setup({ ai: new FakeAi(), vectors: new MemoryVectors(), notifier: new FakeNotifier(), downloader: new FakeDownloader(), products: new FakeProducts() });
  const ann = await t.user("ann");
  const bob = await t.user("bob");
  const make = async <T = { id: string }>(method: string, url: string, body?: object): Promise<T> => {
    const res = await ann.as(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status >= 300) throw new Error(`Setting up ${method} ${url} → ${res.status}: ${await res.text()}`);
    return res.status === 204 ? (undefined as T) : json<T>(res);
  };

  const property = await make("POST", "/api/v1/properties", { name: `${SECRET} House` });
  const garage = await make("POST", "/api/v1/locations", { propertyId: property.id, name: `${SECRET} Garage` });
  const shelf = await make("POST", "/api/v1/locations", { propertyId: property.id, parentId: garage.id, name: `${SECRET} Shelf` });
  const category = await make("POST", "/api/v1/categories", { name: `${SECRET} Tools` });
  const template = await make("POST", "/api/v1/templates", { name: `${SECRET} Coin`, fields: [] });
  const collection = await make("POST", "/api/v1/collections", { name: `${SECRET} Quarters`, templateId: template.id });
  const box = await ann.addItem({ name: `${SECRET} toolbox`, isContainer: true, locationId: shelf.id });
  const drill = await ann.addItem({
    name: `${SECRET} drill`,
    description: `${SECRET} description`,
    serialNumber: `${SECRET}-SN-1`,
    containerItemId: box.id,
    categoryId: category.id,
    tags: [`${SECRET}tag`],
    valueCents: 12900,
    usageUnit: "hours",
  });
  const filters = await ann.addItem({ name: `${SECRET} filter`, quantity: 3 });
  const photoUp = await ann.upload(drill.id, await photo(), `${SECRET}.jpg`);
  const doc = await ann.upload(drill.id, pdf(`${SECRET} receipt`), `${SECRET}-receipt.pdf`, "document");
  const warranty = await make("POST", `/api/v1/items/${drill.id}/warranties`, { endsOn: "2030-01-01", provider: `${SECRET} Warranty Co` });
  const claim = await make("POST", `/api/v1/warranties/${warranty.id}/claims`, { problem: `${SECRET} chuck slips` });
  const provider = await make("POST", "/api/v1/providers", { name: `${SECRET} Repairs` });
  const task = await make("POST", "/api/v1/maintenance", {
    title: `${SECRET} oil it`,
    itemId: drill.id,
    intervalCount: 3,
    intervalUnit: "month",
    providerId: provider.id,
    partItemId: filters.id,
  });
  await make("POST", `/api/v1/maintenance/${task.id}/done`, { note: `${SECRET} done note` });
  const loan = await make("POST", `/api/v1/items/${drill.id}/loans`, { direction: "lent", person: `${SECRET} Sam` });
  const reading = await make("POST", `/api/v1/items/${drill.id}/usage`, { value: 12, note: `${SECRET} reading` });
  const fix = await make("POST", `/api/v1/items/${drill.id}/repairs`, { repairedOn: "2026-01-02", work: `${SECRET} new chuck`, problem: `${SECRET} wobble`, costCents: 4500, warrantyEndsOn: "2027-01-02" });
  const rule = await make("PUT", `/api/v1/items/${filters.id}/stock-rules`, { code: `${SECRET}CODE`, behaviour: "use" });
  const moved = await make<{ movementId: string }>("POST", `/api/v1/items/${filters.id}/stock`, { delta: 1, note: `${SECRET} restock` });
  const pairing = await make("POST", `/api/v1/items/${drill.id}/pairing`, { code: "482-39-517", label: `${SECRET} hub` });
  const batch = await make<{ batchId: string }>("POST", "/api/v1/import", { source: "csv", name: `${SECRET}.csv`, rows: [{ name: `${SECRET} imported` }] });
  const share = await make("POST", "/api/v1/shares", { kind: "report", label: `${SECRET} claim`, days: 30 });
  const coverage = await make("POST", "/api/v1/coverage", { label: `${SECRET} policy`, limitCents: 100000, scope: "all" });
  const { codes } = await make<{ codes: string[] }>("POST", "/api/v1/labels/blank", { count: 1 });
  await make("PUT", `/api/v1/labels/${codes[0]}`, { itemId: box.id });
  const own = await make<{ ownLabel: { id: string } }>("POST", "/api/v1/labels/attach", { code: `${SECRET}-TAG-1`, itemId: drill.id });
  const channel = await make("POST", "/api/v1/notifications", { name: `${SECRET} phone`, url: "ntfys://ntfy.sh/annsecret-topic" });
  const key = await make("POST", "/api/v1/api-keys", { name: `${SECRET} key` });
  const sessions = await make<{ data: { id: string }[] }>("GET", "/api/v1/security/sessions");
  const kettle = await ann.addItem({ name: `${SECRET} kettle` });
  await make("DELETE", `/api/v1/items/${kettle.id}`);
  const tags = await make<{ data: { id: string; name: string }[] }>("GET", "/api/v1/tags");
  await t.jobs.drain(); // photos analysed, items indexed into the vector store
  // A review of the shelf under way, its toolbox checked (lib/room-reviews.ts).
  await make("POST", `/api/v1/room-reviews/${shelf.id}`);
  await make("POST", `/api/v1/room-reviews/${shelf.id}/items/${box.id}`, { outcome: "here" });

  // Ann's id for each kind of thing, by the path segment before it.
  const missing = crypto.randomUUID(); // kinds with nothing of Ann's to point at (room scans, recalls…): any id
  const ids: Record<string, string> = {
    items: drill.id,
    attachments: photoUp.id,
    properties: property.id,
    locations: garage.id,
    categories: category.id,
    tags: tags.data.find((g) => g.name.startsWith(SECRET))!.id,
    warranties: warranty.id,
    claims: claim.id,
    maintenance: task.id,
    providers: provider.id,
    "trash/items": kettle.id,
    "stock/movements": moved.movementId,
    import: batch.batchId,
    collections: collection.id,
    templates: template.id,
    shares: share.id,
    loans: loan.id,
    coverage: coverage.id,
    "labels/own": own.ownLabel.id,
    notifications: channel.id,
    "api-keys": key.id,
    "security/sessions": sessions.data[0]!.id,
    usage: reading.id,
    repairs: fix.id,
  };
  const params: Record<string, string> = { ruleId: rule.id, pairingId: pairing.id, code: codes[0]!, n: "0", name: "x", locationId: shelf.id, itemId: box.id };
  // What Bob sends with every write: plausible fields of his own, then the same with one of Ann's things in each
  // reference — one at a time, so a reference that's refused can't hide one that isn't checked.
  const base = {
    name: "Bob's",
    title: "Bob's",
    label: "Bob's",
    person: "Bob",
    problem: "Bob's",
    code: "BOBCODE",
    endsOn: "2031-01-01",
    delta: 1,
    value: 20,
    count: 1,
    behaviour: "use",
    direction: "lent",
    kind: "report",
    scope: "all",
    source: "csv",
    limitCents: 1,
    rows: [{ name: "Bob's" }],
    url: "ntfys://ntfy.sh/bob",
    action: "move",
  };
  const refs: Record<string, unknown> = {
    itemId: drill.id,
    containerItemId: box.id,
    partItemId: filters.id,
    providerId: provider.id,
    categoryId: category.id,
    propertyId: property.id,
    locationId: garage.id,
    parentId: garage.id,
    attachmentId: doc.id,
    templateId: template.id,
    batchId: batch.batchId,
    warrantyId: warranty.id,
    ids: [drill.id, box.id],
    code: codes[0],
    // (Tags are by name in each household: a name Bob types is his own tag, not a way to Ann's.)
  };
  const bodies = [base, ...Object.entries(refs).map(([k, v]) => ({ ...base, [k]: v }))];
  // Everything of Ann's Bob could point at, to look for in his own rows afterwards.
  const annIds = [drill.id, box.id, filters.id, provider.id, category.id, property.id, garage.id, shelf.id, doc.id, photoUp.id, template.id, batch.batchId, warranty.id, claim.id, task.id, loan.id, collection.id, codes[0]!];
  return { ...t, ann, bob, ids, params, missing, bodies, annIds, householdId: ann.householdId, photoBytes: await photo() };
}

/** Every row of a household, table by table, as text — compared before and after. */
async function snapshot(db: Awaited<ReturnType<typeof setup>>["db"], householdId: string) {
  const out: Record<string, string> = {};
  for (const table of householdTables) {
    const column = (getTableColumns(table) as Record<string, Parameters<typeof eq>[0]>).householdId!;
    const rows = await db.select().from(table).where(eq(column, householdId));
    out[getTableConfig(table).name] = JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
  }
  return out;
}

describe("households can't reach each other", () => {
  it("through any route: nothing of Ann's comes back, nothing of hers changes", async () => {
    const { ann, bob, ids, params, missing, bodies, annIds, householdId, db, photoBytes } = await annHousehold();
    const before = await snapshot(db, householdId);
    expect(Object.values(before).some((rows) => rows.includes(SECRET))).toBe(true); // the canary is really there
    // A key allows 600 checks a minute (a runaway loop's brake; some requests check it twice), so a fresh one every 200.
    let bobKey = "";
    let keyUses = 0;
    const keyHeader = async () => {
      if (keyUses++ % 200 === 0) {
        bobKey = (await json<{ key: string }>(bob.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: `Bob's script ${keyUses}` }) }))).key;
      }
      return { Authorization: `Bearer ${bobKey}`, Cookie: "" };
    };

    const known = [...Object.values(ids), ...Object.values(params), missing].filter((v) => v.length > 2);
    const anonymise = (text: string) => known.reduce((t, id) => t.replaceAll(id, "ID"), text);
    const leaks: string[] = [];
    const reached: string[] = [];
    const photoMark = new TextDecoder("latin1").decode(photoBytes.slice(200, 260));
    const ways = [
      { name: "session", headers: {} as Record<string, string>, keyOk: true },
      { name: "API key", headers: {} as Record<string, string>, keyOk: false },
      { name: "asking for Ann's household", headers: { "x-household-id": householdId }, keyOk: true },
    ];
    for (const way of ways) {
      for (const op of OPERATIONS.filter((o) => o.auth !== "none")) {
        if (way.name === "API key" && op.auth === "session") continue; // those refuse keys outright
        // The path with Ann's ids in it, and the same with made-up ones.
        const fill = (anns: boolean) =>
          op.path.replace(/\{(\w+)\}/g, (_, name: string, offset: number) => {
            if (!anns) return missing;
            if (name !== "id") return encodeURIComponent(params[name] ?? missing);
            const before = op.path.slice(1, offset - 1); // "items", "trash/items", "labels/own"…
            const kind = Object.keys(ids)
              .filter((k) => before === k || before.endsWith(`/${k}`))
              .sort((a, b) => b.length - a.length)[0];
            return encodeURIComponent(kind ? ids[kind]! : missing);
          });
        const send = async (path: string, body: object | undefined) => {
          if (way.name === "API key") way.headers = await keyHeader();
          let res: Response;
          if (op.upload) {
            const form = new FormData();
            form.set("file", new File([await photo()], "bob.jpg"));
            form.set("kind", "photo");
            for (const [k, v] of Object.entries(body ?? {})) if (typeof v === "string") form.set(k, v);
            res = await bob.as(`/api/v1${path}`, { method: op.method.toUpperCase(), body: form, headers: way.headers });
          } else {
            res = await bob.as(`/api/v1${path}`, { method: op.method.toUpperCase(), headers: way.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
          }
          if (res.status === 429) throw new Error(`Rate limited (${way.name}, key use ${keyUses}): ${op.method} ${op.path} — the test would check nothing: ${await res.clone().text()}`);
          return { status: res.status, text: new TextDecoder("latin1").decode(await res.arrayBuffer()) };
        };
        const aimed = op.path.includes("{");
        for (const body of op.method === "get" || op.method === "delete" ? [undefined] : bodies) {
          const res = await send(fill(true), body);
          const what = `${way.name}: ${op.method.toUpperCase()} ${op.path} → ${res.status}`;
          const at = res.text.indexOf(SECRET);
          if (at >= 0 || res.text.includes(photoMark)) leaks.push(`${what}: ${res.text.slice(Math.max(0, at - 80), at + 80)}`);
          // Aimed at one of Ann's things and not refused: it must answer just as it does for a thing that doesn't
          // exist, or Bob could at least tell her ids are real.
          if (aimed && res.status < 400) {
            const blank = await send(fill(false), body);
            if (blank.status !== res.status || anonymise(blank.text) !== anonymise(res.text)) reached.push(`${what}, ${blank.status} for a made-up id`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(reached).toEqual([]);
    expect(await snapshot(db, householdId)).toEqual(before);
    // Nothing of Bob's points at anything of Ann's (an item in her room, her filter as his part…).
    const bobs = await snapshot(db, bob.householdId);
    expect(Object.entries(bobs).flatMap(([table, rows]) => annIds.filter((id) => rows.includes(id)).map((id) => `${table} → ${id}`))).toEqual([]);
    // And Ann still sees all of it (the test didn't just lose her data some other way).
    expect((await json<{ data: { name: string }[] }>(ann.as("/api/v1/items"))).data.map((i) => i.name)).toEqual(expect.arrayContaining([`${SECRET} drill`]));
  }, 120_000);
});
