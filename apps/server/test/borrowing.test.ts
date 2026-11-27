/**
 * Borrowing: someone else's thing isn't counted as the household's while it's here; given back, it goes to Past things
 * (Borrow again brings it back on a new loan); "It's ours now" makes it the household's.
 */
import type { ExportRow, Overview } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

async function household() {
  const { user } = await setup();
  const ann = await user("ann");
  const drill = await ann.addItem({ name: "Drill", purchasePriceCents: 10000, heir: "Kim" });
  const saw = await ann.addItem({ name: "Tile saw", purchasePriceCents: 50000, heir: "Kim" });
  const borrow = async () => json<{ id: string }>(send(ann, "POST", `/api/v1/items/${saw.id}/loans`, { direction: "borrowed", person: "Lee", since: "2026-11-01" }));
  return { ann, drill, saw, borrow };
}

describe("borrowing", () => {
  it("leaves a borrowed thing out of what the household owns, while still finding it", async () => {
    const { ann, saw, borrow } = await household();
    await send(ann, "POST", "/api/v1/coverage", { label: "Policy", limitCents: 100000, scope: "all" });
    await borrow();

    expect(await json(ann.as("/api/v1/overview"))).toMatchObject({ total: { items: 1, valueCents: 10000 } });
    expect(await json(ann.as("/api/v1/summary"))).toMatchObject({ things: 1, valueCents: 10000 });
    expect((await json<{ data: ExportRow[] }>(ann.as("/api/v1/export/items.json"))).data.map((r) => r.name)).toEqual(["Drill"]);
    expect((await json<{ data: { valueCents: number }[] }>(ann.as("/api/v1/coverage"))).data[0]).toMatchObject({ valueCents: 10000 });
    const heirs = await json<{ data: { items: { name: string }[] }[] }>(ann.as("/api/v1/export/heirs.json"));
    expect(heirs.data.flatMap((h) => h.items.map((i) => i.name))).toEqual(["Drill"]);
    // Still in the list (and found), but not in what it's all worth.
    const list = await json<{ data: { name: string }[]; total: number; valueCents: number }>(ann.as("/api/v1/items"));
    expect(list).toMatchObject({ total: 2, valueCents: 10000 });
    expect((await ann.search("tile saw")).data.map((i) => i.id)).toEqual([saw.id]);
  });

  it("moves a thing given back to Past things, and borrows it again from the same person", async () => {
    const { ann, saw, borrow } = await household();
    const loan = await borrow();
    const back = await json<{ movedToPast: boolean; returnedOn: string }>(send(ann, "POST", `/api/v1/loans/${loan.id}/returned`, { on: "2026-11-20" }));
    expect(back).toMatchObject({ movedToPast: true, returnedOn: "2026-11-20" });
    expect(await json(ann.as(`/api/v1/items/${saw.id}`))).toMatchObject({ disposition: "returned", disposedOn: "2026-11-20", disposedTo: "Lee" });
    expect((await json<{ data: { id: string }[] }>(ann.as("/api/v1/items"))).data.map((i) => i.id)).not.toContain(saw.id);
    expect((await json<{ data: { id: string }[] }>(ann.as("/api/v1/items?gone=only"))).data.map((i) => i.id)).toContain(saw.id);

    const again = await send(ann, "POST", `/api/v1/items/${saw.id}/borrow-again`, { dueOn: "2026-12-31" });
    expect(again.status).toBe(201);
    expect(await json(again)).toMatchObject({ direction: "borrowed", person: "Lee", dueOn: "2026-12-31", returnedOn: null });
    expect(await json(ann.as(`/api/v1/items/${saw.id}`))).toMatchObject({ disposition: null, disposedTo: null });
    expect(await json(ann.as("/api/v1/overview"))).toMatchObject({ total: { items: 1, valueCents: 10000 } }); // borrowed again: still not ours
    // Only something given back.
    expect((await send(ann, "POST", `/api/v1/items/${saw.id}/borrow-again`, {})).status).toBe(409);
  });

  it("keeps a lent thing where it is when it's back", async () => {
    const { ann, drill } = await household();
    const loan = await json<{ id: string }>(send(ann, "POST", `/api/v1/items/${drill.id}/loans`, { direction: "lent", person: "Sam" }));
    expect(await json(send(ann, "POST", `/api/v1/loans/${loan.id}/returned`, {}))).toMatchObject({ movedToPast: false });
    expect(await json(ann.as(`/api/v1/items/${drill.id}`))).toMatchObject({ disposition: null });
  });

  it("makes a borrowed thing the household's: a gift, or bought", async () => {
    const { ann, saw, borrow } = await household();
    const loan = await borrow();
    const kept = await json(send(ann, "POST", `/api/v1/loans/${loan.id}/kept`, { on: "2026-11-25", priceCents: 20000 }));
    expect(kept).toMatchObject({ kept: true, returnedOn: "2026-11-25" });
    expect(await json(ann.as(`/api/v1/items/${saw.id}`))).toMatchObject({ disposition: null, purchasePriceCents: 20000, purchaseDate: "2026-11-25" });
    expect(await json<Overview>(ann.as("/api/v1/overview"))).toMatchObject({ total: { items: 2, valueCents: 30000 } });
    expect((await send(ann, "POST", `/api/v1/loans/${loan.id}/kept`, {})).status).toBe(409);

    // A lent thing is already ours.
    const lent = await json<{ id: string }>(send(ann, "POST", `/api/v1/items/${saw.id}/loans`, { direction: "lent", person: "Sam" }));
    expect((await send(ann, "POST", `/api/v1/loans/${lent.id}/kept`, {})).status).toBe(422);
  });
});
