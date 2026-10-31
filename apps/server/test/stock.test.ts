/** Scan to count: what a code does (look up, use, restock, ask), the scanner's override, several items, labels, undo. */
import { addDays, type ScanResult, type StockSummary, today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { member } from "../src/db/schema";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const scan = (u: User, code: string, more: object = {}) => json<ScanResult>(send(u, "POST", "/api/v1/scan", { code, ...more }));
const summary = (u: User, id: string) => json<StockSummary>(u.as(`/api/v1/items/${id}/stock`));
const rule = (u: User, id: string, data: object) => send(u, "PUT", `/api/v1/items/${id}/stock-rules`, data);

const UPC = "036000291452"; // 12-digit UPC-A, stored as the 13-digit EAN 0036000291452

describe("stock by hand", () => {
  it("changes the count, never below 0, and keeps a history (edits too)", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const filters = await ann.addItem({ name: "Furnace filter 20x25x1", quantity: 3 });
    expect(await json(send(ann, "POST", `/api/v1/items/${filters.id}/stock`, { delta: 6, note: "Costco" }))).toMatchObject({ quantity: 9, applied: 6 });
    expect(await json(send(ann, "POST", `/api/v1/items/${filters.id}/stock`, { delta: -20 }))).toMatchObject({ quantity: 0, applied: -9 });
    expect(await json(send(ann, "POST", `/api/v1/items/${filters.id}/stock`, { delta: -1 }))).toEqual({ quantity: 0, applied: 0, movementId: null });
    expect((await send(ann, "POST", `/api/v1/items/${filters.id}/stock`, { delta: 0 })).status).toBe(422);
    await send(ann, "PATCH", `/api/v1/items/${filters.id}`, { quantity: 4 });

    const s = await summary(ann, filters.id);
    expect(s.quantity).toBe(4);
    expect(s.movements.map((m) => [m.delta, m.quantityAfter, m.reason, m.note, m.by])).toEqual([
      [4, 4, "edit", null, "ann"],
      [-9, 0, "manual", null, "ann"],
      [6, 9, "manual", "Costco", "ann"],
    ]);
  });

  it("stays in its household; viewers only look", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const filters = await ann.addItem({ name: "Furnace filter", quantity: 3, barcode: UPC });
    await rule(ann, filters.id, { code: UPC, behaviour: "use" });
    expect((await send(bob, "POST", `/api/v1/items/${filters.id}/stock`, { delta: -1 })).status).toBe(404);
    expect(await scan(bob, UPC)).toEqual({ action: "unknown", code: UPC });

    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "viewer", createdAt: new Date() });
    const asViewer = (url: string, init: RequestInit = {}) => bob.as(url, { ...init, headers: { "X-Household-Id": ann.householdId } });
    const viewed = await json<ScanResult>(asViewer("/api/v1/scan", { method: "POST", body: JSON.stringify({ code: UPC }) }));
    expect(viewed).toMatchObject({ action: "open", item: { id: filters.id, quantity: 3 } });
    expect((await asViewer(`/api/v1/items/${filters.id}/stock`, { method: "POST", body: JSON.stringify({ delta: -1 }) })).status).toBe(403);
  });
});

describe("scanning", () => {
  it("does what the code is set to, unless the scanner says otherwise", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const filters = await ann.addItem({ name: "Furnace filter", quantity: 3, barcode: UPC });

    // No setting yet: the barcode opens its item, as it always did.
    expect(await scan(ann, UPC)).toMatchObject({ action: "open", item: { id: filters.id, name: "Furnace filter", quantity: 3 } });

    expect(await json(rule(ann, filters.id, { code: UPC, behaviour: "use" }))).toMatchObject({ code: `0${UPC}`, label: `Barcode 0${UPC}`, behaviour: "use", step: 1 });
    expect(await scan(ann, UPC)).toMatchObject({ action: "adjusted", item: { id: filters.id, quantity: 2 }, delta: -1, applied: -1, movementId: expect.any(String) });
    expect(await scan(ann, `0${UPC}`)).toMatchObject({ action: "adjusted", item: { quantity: 1 } }); // EAN-13 spelling
    expect(await scan(ann, UPC, { mode: "lookup" })).toMatchObject({ action: "open", item: { quantity: 1 } });
    expect(await scan(ann, UPC, { mode: "restock" })).toMatchObject({ action: "adjusted", item: { quantity: 2 }, delta: 1 });

    // The case's barcode adds a whole pack.
    await rule(ann, filters.id, { code: "4006381333931", behaviour: "restock", step: 12 });
    expect(await scan(ann, "4006381333931")).toMatchObject({ action: "adjusted", item: { quantity: 14 }, delta: 12 });

    // Ask: then the person picks.
    await rule(ann, filters.id, { code: UPC, behaviour: "ask", step: 2 });
    expect(await scan(ann, UPC)).toMatchObject({ action: "ask", item: { id: filters.id }, step: 2 });
    expect(await scan(ann, UPC, { mode: "use", itemId: filters.id })).toMatchObject({ action: "adjusted", delta: -2, item: { quantity: 12 } });

    expect(await scan(ann, "9999999999994")).toEqual({ action: "unknown", code: "9999999999994" });
    const s = await summary(ann, filters.id);
    expect(s.rules.map((r) => [r.label, r.behaviour, r.step])).toEqual([[`Barcode 0${UPC}`, "ask", 2], ["Barcode 4006381333931", "restock", 12]]);
    expect(s.movements.every((m) => m.reason === "scan")).toBe(true);

    expect((await send(ann, "DELETE", `/api/v1/items/${filters.id}/stock-rules/${s.rules[1]!.id}`)).status).toBe(204);
    expect(await scan(ann, "4006381333931")).toMatchObject({ action: "unknown" });
  });

  it("asks which, when the code is on several items — the last one scanned first", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const garage = await ann.addItem({ name: "AA batteries (garage)", quantity: 4, barcode: UPC });
    const kitchen = await ann.addItem({ name: "AA batteries (kitchen)", quantity: 2, barcode: UPC });
    await rule(ann, garage.id, { code: UPC, behaviour: "use" });

    const first = await scan(ann, UPC);
    expect(first).toMatchObject({ action: "choose", behaviour: "use", items: [{ name: "AA batteries (garage)" }, { name: "AA batteries (kitchen)" }] });
    // Picking the kitchen ones (no setting of their own) still does what the code does: use one.
    expect(await scan(ann, UPC, { itemId: kitchen.id })).toMatchObject({ action: "adjusted", item: { id: kitchen.id, quantity: 1 } });
    const again = await scan(ann, UPC);
    expect(again.action === "choose" && again.items.map((i) => i.id)).toEqual([kitchen.id, garage.id]);
    expect((await send(ann, "POST", "/api/v1/scan", { code: UPC, itemId: "not-one-of-them" })).status).toBe(404);
  });

  it("works with Ferret's own QR labels", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bin = await ann.addItem({ name: "Spare batteries bin", quantity: 10 });
    const other = await ann.addItem({ name: "Something else" });
    const { code } = await json<{ code: string }>(send(ann, "POST", "/api/v1/labels/for", { itemId: bin.id }));
    const url = `https://ferret.test/l/${code}`;

    expect(await scan(ann, url)).toMatchObject({ action: "open", item: { id: bin.id } });
    expect(await json(rule(ann, bin.id, { code: code.toLowerCase(), behaviour: "use" }))).toMatchObject({ code: `label:${code}`, label: `QR label ${code}` });
    expect(await scan(ann, url)).toMatchObject({ action: "adjusted", item: { id: bin.id, quantity: 9 } });
    expect((await rule(ann, other.id, { code: url, behaviour: "use" })).status).toBe(409); // it's the bin's label

    // A room's label, or a blank one: its label page decides.
    const [blank] = (await json<{ codes: string[] }>(send(ann, "POST", "/api/v1/labels/blank", { count: 1 }))).codes;
    expect(await scan(ann, `https://ferret.test/l/${blank}`)).toEqual({ action: "open", label: blank });
  });

  it("can be undone, once", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const filters = await ann.addItem({ name: "Furnace filter", quantity: 1, barcode: UPC });
    await rule(ann, filters.id, { code: UPC, behaviour: "use" });
    const used = await scan(ann, UPC);
    expect(used).toMatchObject({ action: "adjusted", item: { quantity: 0 } });
    const movementId = used.action === "adjusted" ? used.movementId : null;
    expect(await json(send(ann, "POST", `/api/v1/stock/movements/${movementId}/undo`))).toMatchObject({ itemId: filters.id, quantity: 1, applied: 1 });
    expect((await send(ann, "POST", `/api/v1/stock/movements/${movementId}/undo`)).status).toBe(409);
    const s = await summary(ann, filters.id);
    expect(s.movements.map((m) => [m.reason, m.delta, m.undone])).toEqual([["undo", 1, false], ["scan", -1, true]]);
    // Nothing left: a "use" scan changes nothing, and says so.
    await send(ann, "POST", `/api/v1/items/${filters.id}/stock`, { delta: -1 });
    expect(await scan(ann, UPC)).toMatchObject({ action: "adjusted", applied: 0, movementId: null, item: { quantity: 0 } });
  });
});

describe("shopping list", () => {
  it("lists what's run out or is at or below what's kept, and restocking takes it off", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const filters = await ann.addItem({ name: "Furnace filter", quantity: 1, barcode: UPC });
    await rule(ann, filters.id, { code: UPC, behaviour: "use" });
    await rule(ann, filters.id, { code: "4006381333931", behaviour: "restock", step: 6 });
    const salt = await ann.addItem({ name: "Softener salt", quantity: 3, minQuantity: 2 });
    await ann.addItem({ name: "Bulbs", quantity: 3, minQuantity: 2 }); // above: not on it
    await ann.addItem({ name: "Old TV", quantity: 0 }); // never tracked: not on it
    await bob.addItem({ name: "Bob's batteries", quantity: 0, minQuantity: 1 });

    const list = () => json<{ items: { name: string; quantity: number; minQuantity: number | null; buy: number }[]; text: string }>(ann.as("/api/v1/shopping"));
    expect((await list()).items).toEqual([]);

    await scan(ann, UPC); // the last filter
    await send(ann, "PATCH", `/api/v1/items/${salt.id}`, { quantity: 2 });
    const now = await list();
    expect(now.items.map((i) => [i.name, i.quantity, i.minQuantity, i.buy])).toEqual([
      ["Furnace filter", 0, null, 6], // run out first; its case's barcode adds 6
      ["Softener salt", 2, 2, 1],
    ]);
    expect(now.text).toBe("Shopping list\n- Furnace filter ×6 (none left)\n- Softener salt (2 left)");

    const bell = await json<{ data: { kind: string; severity: string; title: string; detail: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.find((a) => a.kind === "shopping")).toEqual(
      expect.objectContaining({ severity: "urgent", title: "2 things to buy", detail: "1 run out: Furnace filter, Softener salt" }),
    );
    expect(await json(ann.as("/api/v1/overview"))).toMatchObject({ shopping: { count: 2, out: 1, next: [{ name: "Furnace filter" }, { name: "Softener salt" }] } });

    // Restocking takes things off — the list is what's low now.
    await scan(ann, "4006381333931");
    await send(ann, "POST", `/api/v1/items/${salt.id}/stock`, { delta: 5 });
    expect((await list()).items).toEqual([]);
    expect((await json<{ data: { kind: string }[] }>(ann.as("/api/v1/attention"))).data.some((a) => a.kind === "shopping")).toBe(false);
  });
});

describe("maintenance uses parts", () => {
  it("takes the part out of stock when it's done, and warns early when there aren't enough", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const furnace = await ann.addItem({ name: "Furnace" });
    const filters = await ann.addItem({ name: "Furnace filter 20x25x1", quantity: 1 });
    const theirs = await bob.addItem({ name: "Bob's filter" });
    const dueOn = addDays(today(), 12);
    const make = (partItemId: string) => send(ann, "POST", "/api/v1/maintenance", { title: "Replace furnace filter", itemId: furnace.id, intervalCount: 3, intervalUnit: "month", dueOn, partItemId, partQuantity: 1 });
    expect((await make(theirs.id)).status).toBe(404);
    const task = await json<{ id: string; part: unknown }>(make(filters.id));
    expect(task.part).toEqual({ itemId: filters.id, name: "Furnace filter 20x25x1", uses: 1, left: 1 });

    // Enough for now: nothing in the bell 12 days out, nothing to buy.
    const bell = async () => (await json<{ data: { kind: string; detail: string }[] }>(ann.as("/api/v1/attention"))).data.filter((a) => a.kind === "maintenance");
    expect(await bell()).toEqual([]);

    // Done (with the old filter cleaned, say): stock stays.
    await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, { usePart: false });
    expect((await summary(ann, filters.id)).quantity).toBe(1);
    // Done for real: one comes out, logged as maintenance.
    await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, {});
    const s = await summary(ann, filters.id);
    expect(s.quantity).toBe(0);
    expect(s.movements[0]).toMatchObject({ delta: -1, reason: "maintenance", note: "For Replace furnace filter" });

    // Due again in 12 days with none left: in the bell already, and on the shopping list for it.
    await send(ann, "PATCH", `/api/v1/maintenance/${task.id}`, { dueOn });
    expect(await bell()).toEqual([expect.objectContaining({ detail: "Due in 12 days — no Furnace filter 20x25x1 left" })]);
    const list = await json<{ items: { name: string; buy: number; forTask: string | null }[]; text: string }>(ann.as("/api/v1/shopping"));
    expect(list.items).toEqual([expect.objectContaining({ name: "Furnace filter 20x25x1", buy: 1, forTask: `Replace furnace filter, due ${dueOn}` })]);

    // The part goes: the task carries on without one.
    await send(ann, "DELETE", `/api/v1/items/${filters.id}`);
    expect((await json<{ part: unknown }>(ann.as(`/api/v1/maintenance/${task.id}`))).part).toBeNull();
    expect((await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, {})).status).toBe(200);
  });
});

describe("offline scans", () => {
  it("change the count once, however many times they're sent", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const filters = await ann.addItem({ name: "Furnace filter", quantity: 5, barcode: UPC });
    const clientId = crypto.randomUUID();
    const first = await scan(ann, UPC, { mode: "use", clientId });
    expect(first).toMatchObject({ action: "adjusted", applied: -1, item: { quantity: 4 } });
    // The answer got lost, so the phone sends it again: same change, nothing more.
    const again = await scan(ann, UPC, { mode: "use", clientId });
    expect(again).toMatchObject({ action: "adjusted", applied: -1, repeat: true });
    expect((await summary(ann, filters.id)).quantity).toBe(4);
    // A different scan is a different change.
    await scan(ann, UPC, { mode: "use", clientId: crypto.randomUUID() });
    expect((await summary(ann, filters.id)).quantity).toBe(3);
    // Ids are only matched within a household.
    const bob = await user("bob");
    await bob.addItem({ name: "Bob's filter", quantity: 2, barcode: UPC });
    expect(await scan(bob, UPC, { mode: "use", clientId })).toMatchObject({ action: "adjusted", applied: -1, item: { quantity: 1 } });
    expect((await send(ann, "POST", "/api/v1/scan", { code: UPC, clientId: "not-a-uuid" })).status).toBe(422);
  });
});

describe("scanning to add something you already have", () => {
  it("asks to add to it instead of making a duplicate; several are listed; the change is in its history", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const paper = await ann.addItem({ name: "Printer paper", quantity: 2, barcode: UPC });

    const have = await scan(ann, UPC, { mode: "add" });
    expect(have).toMatchObject({ action: "have", code: UPC, step: 1, items: [{ id: paper.id, name: "Printer paper", quantity: 2 }] });
    expect((await summary(ann, paper.id)).quantity).toBe(2); // nothing changed yet

    // "Add 1 (now 3)": the follow-up with the item.
    expect(await scan(ann, UPC, { mode: "restock", itemId: paper.id })).toMatchObject({ action: "adjusted", applied: 1, item: { quantity: 3 } });
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${paper.id}/history`));
    expect(history.data.map((h) => h.summary)).toContain("Added 1 Printer paper (3 left)");

    // Another one with the same code (any spelling): both offered.
    const more = await ann.addItem({ name: "Printer paper (office)", quantity: 1, barcode: `0${UPC}` });
    const two = await scan(ann, UPC, { mode: "add" });
    expect(two.action === "have" && two.items.map((i) => i.id).sort()).toEqual([paper.id, more.id].sort());

    // A code nobody has: unknown, as before. The barcode book says what the household has.
    expect(await scan(ann, "4006381333931", { mode: "add" })).toEqual({ action: "unknown", code: "4006381333931" });
    const looked = await json<{ have: { id: string }[] }>(ann.as(`/api/v1/barcodes/${UPC}`));
    expect(looked.have.map((h) => h.id).sort()).toEqual([paper.id, more.id].sort());
    expect((await json<{ have: unknown[] }>(ann.as("/api/v1/barcodes/4006381333931"))).have).toEqual([]);
  });

  it("an offline scan sent again changes the count once", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const paper = await ann.addItem({ name: "Printer paper", quantity: 2, barcode: UPC });
    const clientId = crypto.randomUUID();
    expect((await scan(ann, UPC, { mode: "add", clientId })).action).toBe("have");
    await scan(ann, UPC, { mode: "restock", itemId: paper.id, clientId });
    expect(await scan(ann, UPC, { mode: "restock", itemId: paper.id, clientId })).toMatchObject({ action: "adjusted", repeat: true });
    expect((await summary(ann, paper.id)).quantity).toBe(3);
  });
});
