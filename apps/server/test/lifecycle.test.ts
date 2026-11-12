/** Item lifecycle: sold, given away, thrown out, lost, stolen — out of lists and totals, kept with its history. */
import { today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { member } from "../src/db/schema";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const names = async (u: User, url: string) => (await json<{ data: { name: string }[] }>(u.as(url))).data.map((i) => i.name).sort();

describe("item lifecycle", () => {
  it("takes what's gone out of lists, search, totals and the report — but keeps it, and can bring it back", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const kayak = await ann.addItem({ name: "Kayak", brand: "Old Town", valueCents: 60000 });
    await ann.addItem({ name: "Paddle", valueCents: 5000 });
    const kayakTask = await json<{ id: string }>(send(ann, "POST", "/api/v1/maintenance", { title: "Wax the hull", itemId: kayak.id, dueOn: today() }));
    await send(ann, "POST", `/api/v1/items/${kayak.id}/warranties`, { endsOn: "2030-01-01" });

    const sold = await json<{ disposition: string; disposedOn: string; disposalCents: number }>(
      send(ann, "PATCH", `/api/v1/items/${kayak.id}`, { disposition: "sold", disposalCents: 45000, disposalNote: "Marketplace" }),
    );
    expect(sold).toMatchObject({ disposition: "sold", disposedOn: today(), disposalCents: 45000 });

    expect(await names(ann, "/api/v1/items")).toEqual(["Paddle"]);
    expect(await names(ann, "/api/v1/items?q=kayak")).toEqual([]);
    expect(await names(ann, "/api/v1/items?gone=only")).toEqual(["Kayak"]);
    expect(await json(ann.as("/api/v1/overview"))).toMatchObject({ total: { items: 1, valueCents: 5000 } });
    expect((await json<{ data: { name: string }[] }>(ann.as("/api/v1/export/items.json"))).data.map((r) => r.name)).toEqual(["Paddle"]);
    expect((await json<{ data: { id: string }[] }>(ann.as("/api/v1/maintenance"))).data.map((t) => t.id)).not.toContain(kayakTask.id);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/warranties?status=active"))).data).toEqual([]);
    const bell = await json<{ data: { id: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.map((a) => a.id)).not.toContain(kayakTask.id);

    // Still there: its page, its history.
    expect(await json(ann.as(`/api/v1/items/${kayak.id}`))).toMatchObject({ name: "Kayak", disposition: "sold" });
    // And back again.
    expect(await json(send(ann, "PATCH", `/api/v1/items/${kayak.id}`, { disposition: null }))).toMatchObject({ disposition: null, disposedOn: null, disposalCents: null, disposalNote: null });
    expect(await names(ann, "/api/v1/items")).toEqual(["Kayak", "Paddle"]);
  });

  it("lists what was lost or stolen for a claim, and won't let a full box go", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bike = await ann.addItem({ name: "Road bike", valueCents: 120000, serialNumber: "WTU123" });
    const ring = await ann.addItem({ name: "Ring", valueCents: 300000 });
    const lamp = await ann.addItem({ name: "Lamp", valueCents: 4000 });
    await send(ann, "PATCH", `/api/v1/items/${bike.id}`, { disposition: "stolen", disposedOn: "2026-10-01", disposalNote: "From the garage, police report 26-1234" });
    await send(ann, "PATCH", `/api/v1/items/${ring.id}`, { disposition: "lost" });
    await send(ann, "PATCH", `/api/v1/items/${lamp.id}`, { disposition: "discarded" });

    const claim = await json<{ data: { name: string; disposition: string; disposedOn: string }[] }>(ann.as("/api/v1/export/items.json?gone=lost"));
    expect(claim.data.map((r) => [r.name, r.disposition])).toEqual([["Ring", "lost"], ["Road bike", "stolen"]]);
    const csv = await (await ann.as("/api/v1/export/items.csv?gone=lost")).text();
    expect(csv.split("\r\n")[0]).toMatch(/^Item,What happened,When,Where,/);
    expect(csv).toContain("Road bike,stolen,2026-10-01");

    const box = await ann.addItem({ name: "Toolbox", isContainer: true });
    await ann.addItem({ name: "Hammer", containerItemId: box.id });
    expect((await send(ann, "PATCH", `/api/v1/items/${box.id}`, { disposition: "given" })).status).toBe(409);
  });

  it("lists donations by year, with who they went to and what they were worth, as JSON and CSV", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const coat = await ann.addItem({ name: "Winter coat", brand: "North", purchasePriceCents: 20000 });
    const sofa = await ann.addItem({ name: "Sofa" });
    const desk = await ann.addItem({ name: "=Desk" });
    await send(ann, "PATCH", `/api/v1/items/${coat.id}`, { disposition: "donated", disposedOn: "2026-03-02", disposedTo: "Goodwill", disposalCents: 4500 });
    await send(ann, "PATCH", `/api/v1/items/${sofa.id}`, { disposition: "donated", disposedOn: "2026-01-15", disposedTo: "Habitat ReStore", disposalCents: 15000 });
    await send(ann, "PATCH", `/api/v1/items/${desk.id}`, { disposition: "donated", disposedOn: "2025-12-20", disposedTo: "Church", disposalCents: 5000 });
    // Given away (to a person) isn't a donation.
    const toy = await ann.addItem({ name: "Toy" });
    await send(ann, "PATCH", `/api/v1/items/${toy.id}`, { disposition: "given", disposedOn: "2026-02-01" });

    const all = await json<{ years: { year: number; count: number; valueCents: number }[]; data: unknown[] }>(ann.as("/api/v1/export/donations.json"));
    expect(all).toEqual({ years: [{ year: 2026, count: 2, valueCents: 19500 }, { year: 2025, count: 1, valueCents: 5000 }], data: [] });
    const y = await json<{ data: { name: string; charity: string; valueCents: number; donatedOn: string }[] }>(ann.as("/api/v1/export/donations.json?year=2026"));
    expect(y.data.map((r) => [r.donatedOn, r.name, r.charity, r.valueCents])).toEqual([
      ["2026-01-15", "Sofa", "Habitat ReStore", 15000],
      ["2026-03-02", "Winter coat", "Goodwill", 4500],
    ]);
    const csv = await (await ann.as("/api/v1/export/donations.csv?year=2025")).text();
    expect(csv.split("\r\n")[0]).toMatch(/^\uFEFF?Date given,Given to,Item,/);
    expect(csv).toContain("2025-12-20,Church,'=Desk");
    expect((await ann.as("/api/v1/export/donations.json?year=26")).status).toBe(400);
    // Bringing it back clears who it went to.
    expect(await json(send(ann, "PATCH", `/api/v1/items/${coat.id}`, { disposition: null }))).toMatchObject({ disposition: null, disposedTo: null });
  });
});

describe("personal property list", () => {
  it("groups things by heir for owners and admins only, leaving out gone things", async () => {
    const { user, db } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    await ann.addItem({ name: "Watch", heir: "Sam", serialNumber: "W1", valueCents: 50000 });
    await ann.addItem({ name: "Atlas", heir: " sam ", valueCents: 2000 });
    await ann.addItem({ name: "Piano", heir: "Alex" });
    await ann.addItem({ name: "Lamp" });
    const sold = await ann.addItem({ name: "Ring", heir: "Alex" });
    await send(ann, "PATCH", `/api/v1/items/${sold.id}`, { disposition: "sold" });

    const list = await json<{ data: { heir: string; valueCents: number; items: { name: string; serialNumber: string | null }[] }[] }>(ann.as("/api/v1/export/heirs.json"));
    expect(list.data.map((g) => [g.heir, g.items.map((i) => i.name), g.valueCents])).toEqual([
      ["Alex", ["Piano"], 0],
      ["Sam", ["Atlas", "Watch"], 52000],
    ]);
    expect(list.data[1]!.items[1]!.serialNumber).toBe("W1");

    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "member", createdAt: new Date() });
    expect((await bob.as("/api/v1/export/heirs.json", { headers: { "X-Household-Id": ann.householdId } })).status).toBe(403);
  });
});
