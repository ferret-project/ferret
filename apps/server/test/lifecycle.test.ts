/** Item lifecycle: sold, given away, thrown out, lost, stolen — out of lists and totals, kept with its history. */
import { today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
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
});
