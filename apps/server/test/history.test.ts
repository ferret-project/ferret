/** An item's history: added, each edit in words, moves, photos, warranties, maintenance, stock — newest first. */
import { describe, expect, it } from "vitest";
import { photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const history = async (u: User, id: string, q = "") =>
  json<{ data: { action: string; summary: string; by: string | null }[]; more: boolean }>(u.as(`/api/v1/items/${id}/history${q}`));

describe("item history", () => {
  it("says what changed, where it moved, and what happened around it", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const garage = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Garage" }));
    const basement = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Basement" }));
    const drill = await ann.addItem({ name: "Drill", locationId: garage.id, valueCents: 8000, tags: ["tools"] });
    const box = await ann.addItem({ name: "Red toolbox", isContainer: true, locationId: basement.id });

    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { locationId: basement.id });
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { valueCents: 9500, brand: "DeWalt", tags: ["tools", "power"], notes: "Battery is weak" });
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { containerItemId: box.id });
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { name: "Cordless drill" });
    await ann.upload(drill.id, await photo(), "drill.jpg");
    await send(ann, "POST", `/api/v1/items/${drill.id}/warranties`, { endsOn: "2030-01-01" });
    const task = await json<{ id: string }>(send(ann, "POST", "/api/v1/maintenance", { title: "Charge batteries", itemId: drill.id, intervalCount: 3, intervalUnit: "month" }));
    await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, {});
    // Someone else's history stays theirs.
    await ann.addItem({ name: "Lamp" });

    const h = await history(ann, drill.id);
    expect(h.data.map((e) => e.summary)).toEqual([
      "Done: Charge batteries (Cordless drill)",
      "Added maintenance: Charge batteries (every 3 months)",
      "Added a warranty to Cordless drill (until 2030-01-01)",
      "Added a photo to Cordless drill",
      "Cordless drill: renamed from “Drill”",
      "Moved Drill: Basement → in Red toolbox, Basement",
      "Drill: brand set to DeWalt; value $80.00 → $95.00; tagged power; notes edited",
      "Moved Drill: Garage → Basement",
      "Added Drill",
    ]);
    expect(h.data[0]!.by).toBe("ann");
    expect(h.more).toBe(false);
    const page = await history(ann, drill.id, "?limit=3&offset=3");
    expect(page.data.map((e) => e.action)).toEqual(["attachment.create", "item.update", "item.update"]);
    expect(page.more).toBe(true);

    // Still there for something you no longer have; not for another household.
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { disposition: "sold", disposedOn: "2026-10-01" });
    expect((await history(ann, drill.id)).data[0]!.summary).toBe("Sold Cordless drill");
    const bob = await user("bob");
    expect((await bob.as(`/api/v1/items/${drill.id}/history`)).status).toBe(404);
  });
});
