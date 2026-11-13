/** The table view: sorting the list, and one change to many things at once. */
import { describe, expect, it } from "vitest";
import { member } from "../src/db/schema";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const names = async (u: User, q: string) => (await json<{ data: { name: string }[] }>(u.as(`/api/v1/items?${q}`))).data.map((i) => i.name);
type Bulk = { done: number; failed: { id: string; reason: string }[] };

describe("sorting the list", () => {
  it("sorts by name, value and when bought, with blanks last either way", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    await ann.addItem({ name: "banjo", valueCents: 30000, purchaseDate: "2020-05-01" });
    await ann.addItem({ name: "Accordion", purchasePriceCents: 90000 });
    await ann.addItem({ name: "Cello", valueCents: 5000, purchaseDate: "2024-01-01" });
    await ann.addItem({ name: "Drum" });

    expect(await names(ann, "sort=name&dir=asc")).toEqual(["Accordion", "banjo", "Cello", "Drum"]);
    expect(await names(ann, "sort=name&dir=desc")).toEqual(["Drum", "Cello", "banjo", "Accordion"]);
    // Value falls back to the price paid.
    expect(await names(ann, "sort=value")).toEqual(["Accordion", "banjo", "Cello", "Drum"]);
    expect(await names(ann, "sort=value&dir=asc")).toEqual(["Cello", "banjo", "Accordion", "Drum"]);
    expect(await names(ann, "sort=bought&dir=asc")).toEqual(["banjo", "Cello", "Accordion", "Drum"]);
    expect((await ann.as("/api/v1/items?sort=colour")).status).toBe(422);
  });
});

describe("folding big categories", () => {
  type Folded = { data: { name: string }[]; total: number; rows: number; valueCents: number; folded: { name: string; path: string; count: number; valueCents: number; photoIds: string[] }[] };
  it("shows a category with ten or more things as one row, first, paged as one row — never the one filtered by", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const printing = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "3D printing" }));
    const filament = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Filament", parentId: printing.id }));
    const tools = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Tools" }));
    for (let i = 0; i < 12; i++) await ann.addItem({ name: `PLA ${String(i).padStart(2, "0")}`, categoryId: filament.id, valueCents: 1000 });
    for (let i = 0; i < 9; i++) await ann.addItem({ name: `Tool ${i}`, categoryId: tools.id });
    await ann.addItem({ name: "Printer", categoryId: printing.id, valueCents: 100000 });
    await ann.addItem({ name: "Lamp" });

    const all = await json<Folded>(ann.as("/api/v1/items?fold=category&sort=name&dir=asc&limit=50"));
    expect(all.folded).toEqual([{ categoryId: filament.id, name: "Filament", path: "3D printing › Filament", count: 12, valueCents: 12000, photoIds: [] }]);
    // Nine tools stay as they are; the header still counts (and values) everything.
    expect(all.data.map((i) => i.name)).toEqual(["Lamp", "Printer", ...Array.from({ length: 9 }, (_, i) => `Tool ${i}`)]);
    expect(all).toMatchObject({ total: 23, rows: 12, valueCents: 112000 });

    // The folded row is the first row of the first page; the next page carries on with the things.
    const first = await json<Folded>(ann.as("/api/v1/items?fold=category&sort=name&dir=asc&limit=5"));
    expect(first.folded.map((g) => g.name)).toEqual(["Filament"]);
    expect(first.data.map((i) => i.name)).toEqual(["Lamp", "Printer", "Tool 0", "Tool 1"]);
    const second = await json<Folded>(ann.as("/api/v1/items?fold=category&sort=name&dir=asc&limit=5&offset=5"));
    expect(second.folded).toEqual([]);
    expect(second.data.map((i) => i.name)).toEqual(["Tool 2", "Tool 3", "Tool 4", "Tool 5", "Tool 6"]);

    // Filtered to 3D printing: Filament (inside it) still folds; filtered to Filament itself, it opens.
    const printingOnly = await json<Folded>(ann.as(`/api/v1/items?fold=category&categoryId=${printing.id}`));
    expect(printingOnly.folded.map((g) => g.name)).toEqual(["Filament"]);
    expect(printingOnly.data.map((i) => i.name)).toEqual(["Printer"]);
    const filamentOnly = await json<Folded>(ann.as(`/api/v1/items?fold=category&categoryId=${filament.id}&limit=50`));
    expect(filamentOnly.folded).toEqual([]);
    expect(filamentOnly.data).toHaveLength(12);

    // Other filters count: worth $50 or more is only the printer, so nothing folds.
    const dear = await json<Folded>(ann.as("/api/v1/items?fold=category&minWorth=5000"));
    expect(dear.folded).toEqual([]);
    expect(dear.data.map((i) => i.name)).toEqual(["Printer"]);

    // Without fold, the list is as it was.
    const plain = await json<Folded & { folded?: unknown }>(ann.as("/api/v1/items?limit=50"));
    expect(plain.folded).toBeUndefined();
    expect(plain.data).toHaveLength(23);
  });
});

describe("bulk changes", () => {
  it("moves, files, tags and deletes many things, skipping what isn't yours", async () => {
    const { user, db } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const garage = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Garage" }));
    const tools = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Tools" }));
    const box = await ann.addItem({ name: "Toolbox", isContainer: true });
    const drill = await ann.addItem({ name: "Drill", tags: ["power"] });
    const saw = await ann.addItem({ name: "Saw", containerItemId: box.id });
    const theirs = await bob.addItem({ name: "Bob's lamp" });
    const ids = [drill.id, saw.id];

    const moved = await json<Bulk>(send(ann, "POST", "/api/v1/items/bulk", { action: "move", ids: [...ids, theirs.id], locationId: garage.id }));
    expect(moved.done).toBe(2);
    expect(moved.failed).toEqual([{ id: theirs.id, reason: expect.any(String) }]);
    const saw2 = await json<{ locationId: string; containerItemId: string | null }>(ann.as(`/api/v1/items/${saw.id}`));
    expect(saw2).toMatchObject({ locationId: garage.id, containerItemId: null });

    expect((await json<Bulk>(send(ann, "POST", "/api/v1/items/bulk", { action: "category", ids, categoryId: tools.id }))).done).toBe(2);
    expect(await names(ann, `categoryId=${tools.id}&sort=name&dir=asc`)).toEqual(["Drill", "Saw"]);

    // Tagging something already tagged leaves it alone.
    expect((await json<Bulk>(send(ann, "POST", "/api/v1/items/bulk", { action: "tag", ids, tag: "Power" }))).done).toBe(1);
    expect(await names(ann, "tag=power&sort=name&dir=asc")).toEqual(["Drill", "Saw"]);
    expect((await json<Bulk>(send(ann, "POST", "/api/v1/items/bulk", { action: "untag", ids, tag: "power" }))).done).toBe(2);
    expect(await names(ann, "tag=power")).toEqual([]);

    // Viewers can't.
    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "viewer", createdAt: new Date() });
    const asViewer = bob.as("/api/v1/items/bulk", { method: "POST", headers: { "X-Household-Id": ann.householdId }, body: JSON.stringify({ action: "delete", ids }) });
    expect((await asViewer).status).toBe(403);

    expect((await json<Bulk>(send(ann, "POST", "/api/v1/items/bulk", { action: "delete", ids }))).done).toBe(2);
    expect(await names(ann, "sort=name&dir=asc")).toEqual(["Toolbox"]);
    expect((await send(ann, "POST", "/api/v1/items/bulk", { action: "delete", ids: [] })).status).toBe(422);
  });
});
