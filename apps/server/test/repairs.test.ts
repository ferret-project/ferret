/** Repairs, cost of ownership and "replaced by" (lib/repairs.ts). */
import type { ItemListing, OwnershipCost, Repair, Warranty } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const year = new Date().getFullYear();

describe("repairs", () => {
  it("logs a repair with its provider, warranty and photos — in the history, and editable", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const washer = await ann.addItem({ name: "Washer" });
    const pro = await json<{ id: string }>(send(ann, "POST", "/api/v1/providers", { name: "Acme Appliance" }));

    const res = await send(ann, "POST", `/api/v1/items/${washer.id}/repairs`, {
      repairedOn: `${year}-01-10`,
      problem: "Wouldn't drain",
      work: "Replaced the drain pump",
      providerId: pro.id,
      parts: "Pump 00436440",
      costCents: 18000,
      warrantyEndsOn: `${year + 1}-01-10`,
    });
    expect(res.status).toBe(201);
    const fix = (await res.json()) as Repair;
    expect(fix).toMatchObject({ work: "Replaced the drain pump", providerName: "Acme Appliance", costCents: 18000, warrantyEndsOn: `${year + 1}-01-10`, by: "ann" });
    const ws = await json<{ data: Warranty[] }>(ann.as(`/api/v1/items/${washer.id}/warranties`));
    expect(ws.data).toEqual([expect.objectContaining({ provider: "Acme Appliance", startsOn: `${year}-01-10`, coverage: "Repair: Replaced the drain pump" })]);

    // A before photo: the item's, with the repair — and not read for suggestions.
    const form = new FormData();
    form.set("file", new File([await photo()], "before.jpg"));
    form.set("repairId", fix.id);
    const up = await ann.as(`/api/v1/items/${washer.id}/attachments`, { method: "POST", body: form });
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({ repairId: fix.id, analysisStatus: null });
    const list = await json<{ data: Repair[] }>(ann.as(`/api/v1/items/${washer.id}/repairs`));
    expect(list.data[0]!.attachmentIds).toHaveLength(1);

    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${washer.id}/history`));
    expect(history.data.map((h) => h.summary)).toContain("Repaired Washer: Replaced the drain pump ($180.00)");

    expect(await json(send(ann, "PATCH", `/api/v1/repairs/${fix.id}`, { costCents: 20000 }))).toMatchObject({ costCents: 20000 });
    expect((await send(ann, "POST", `/api/v1/items/${washer.id}/repairs`, { repairedOn: `${year + 1}-01-01`, work: "Later" })).status).toBe(422);
    expect((await send(ann, "DELETE", `/api/v1/repairs/${fix.id}`)).status).toBe(204);
    expect((await json<{ data: Repair[] }>(ann.as(`/api/v1/items/${washer.id}/repairs`))).data).toEqual([]);
  });

  it("a repair photo must be for a repair of that item; a task must be that item's", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const a = await ann.addItem({ name: "A" });
    const b = await ann.addItem({ name: "B" });
    const fix = await json<Repair>(send(ann, "POST", `/api/v1/items/${a.id}/repairs`, { repairedOn: `${year}-01-01`, work: "Fixed" }));
    const form = new FormData();
    form.set("file", new File([await photo()], "x.jpg"));
    form.set("repairId", fix.id);
    expect((await ann.as(`/api/v1/items/${b.id}/attachments`, { method: "POST", body: form })).status).toBe(404);
    const task = await json<{ id: string }>(send(ann, "POST", "/api/v1/maintenance", { title: "Clean", itemId: b.id, intervalCount: 1, intervalUnit: "month" }));
    expect((await send(ann, "POST", `/api/v1/items/${a.id}/repairs`, { repairedOn: `${year}-01-01`, work: "x", taskId: task.id })).status).toBe(422);
  });
});

describe("cost of ownership", () => {
  it("adds what was paid, maintenance and repairs, takes off what it sold for, and divides by years owned", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const mower = await ann.addItem({ name: "Mower", purchaseDate: `${year - 4}-01-01`, purchasePriceCents: 40000 });
    const task = await json<{ id: string }>(send(ann, "POST", "/api/v1/maintenance", { title: "Tune-up", itemId: mower.id, intervalCount: 1, intervalUnit: "year" }));
    await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, { costCents: 6000 });
    await send(ann, "POST", `/api/v1/items/${mower.id}/repairs`, { repairedOn: `${year - 1}-05-01`, work: "New blade", costCents: 3000 });

    const c = await json<OwnershipCost>(ann.as(`/api/v1/items/${mower.id}/cost`));
    expect(c).toMatchObject({ paidCents: 40000, maintenanceCents: 6000, maintenanceTimes: 1, repairCents: 3000, repairs: 1, backCents: null, totalCents: 49000 });
    expect(c.years).toBeGreaterThanOrEqual(4);
    expect(c.perYearCents).toBe(Math.round(49000 / c.years));

    await send(ann, "PATCH", `/api/v1/items/${mower.id}`, { disposition: "sold", disposalCents: 10000, disposedOn: `${year}-01-01` });
    const sold = await json<OwnershipCost>(ann.as(`/api/v1/items/${mower.id}/cost`));
    expect(sold).toMatchObject({ backCents: 10000, totalCents: 39000, years: 4 });
  });
});

describe("replaced by", () => {
  it("links the old thing and its replacement both ways, in the same household only", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const old = await ann.addItem({ name: "Old fridge" });
    const fresh = await ann.addItem({ name: "New fridge" });
    const bobs = await bob.addItem({ name: "Bob's fridge" });
    expect((await send(ann, "PATCH", `/api/v1/items/${old.id}`, { disposition: "discarded", replacedById: bobs.id })).status).toBe(404);
    expect((await send(ann, "PATCH", `/api/v1/items/${old.id}`, { replacedById: old.id })).status).toBe(422);
    await send(ann, "PATCH", `/api/v1/items/${old.id}`, { disposition: "discarded", replacedById: fresh.id });

    expect(await json<ItemListing>(ann.as(`/api/v1/items/${old.id}`))).toMatchObject({ replacedBy: { id: fresh.id, name: "New fridge" }, replaces: [] });
    expect(await json<ItemListing>(ann.as(`/api/v1/items/${fresh.id}`))).toMatchObject({ replacedBy: null, replaces: [{ id: old.id, name: "Old fridge" }] });
  });
});
