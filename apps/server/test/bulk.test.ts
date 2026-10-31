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
