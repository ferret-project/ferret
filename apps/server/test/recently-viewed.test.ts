/** Recently viewed (lib/recently-viewed.ts) and the dashboard's people / Ferret split and thumbnails (overview). */
import { DASHBOARD_SECTIONS, type DashboardLayout, type Overview, type ThingCard } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { activity, member } from "../src/db/schema";
import { photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const viewed = (u: User, id: string, household?: string) =>
  u.as(`/api/v1/items/${id}/viewed`, { method: "POST", ...(household ? { headers: { "X-Household-Id": household } } : {}) });
const recent = async (u: User, household?: string) =>
  (await json<{ data: ThingCard[] }>(u.as("/api/v1/recently-viewed", household ? { headers: { "X-Household-Id": household } } : {}))).data;

describe("recently viewed", () => {
  it("is each person's own, newest first, a thing once, and leaves deleted things out", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "viewer", createdAt: new Date() });

    const drill = await ann.addItem({ name: "Drill" });
    const saw = await ann.addItem({ name: "Saw" });
    const lamp = await ann.addItem({ name: "Lamp" });
    expect(await recent(ann)).toEqual([]);

    for (const id of [drill.id, saw.id, lamp.id, drill.id]) {
      expect((await viewed(ann, id)).status).toBe(204);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await recent(ann)).map((r) => r.name)).toEqual(["Drill", "Lamp", "Saw"]);

    // A viewer may say so too, and sees only their own.
    expect((await viewed(bob, saw.id, ann.householdId)).status).toBe(204);
    expect((await recent(bob, ann.householdId)).map((r) => r.name)).toEqual(["Saw"]);
    expect(await recent(bob)).toEqual([]);

    await ann.as(`/api/v1/items/${lamp.id}`, { method: "DELETE" });
    expect((await recent(ann)).map((r) => r.name)).toEqual(["Drill", "Saw"]);
  });

  it("keeps only the newest dozen, and another household's thing answers 404", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const cat = await user("cat");
    const ids: string[] = [];
    for (let i = 0; i < 14; i++) {
      const it = await ann.addItem({ name: `Thing ${i}` });
      ids.push(it.id);
      await viewed(ann, it.id);
      await new Promise((r) => setTimeout(r, 3));
    }
    const all = await json<{ data: ThingCard[] }>(ann.as("/api/v1/recently-viewed?limit=12"));
    expect(all.data).toHaveLength(12);
    expect(all.data[0]!.name).toBe("Thing 13");
    expect(all.data.at(-1)!.name).toBe("Thing 2");
    expect((await recent(ann)).length).toBe(6);

    expect((await viewed(cat, ids[0]!)).status).toBe(404);
    expect(await recent(cat)).toEqual([]);
  });
});

describe("the dashboard", () => {
  it("keeps people's changes and Ferret's own apart, so a busy job can't push people's off", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const drill = await ann.addItem({ name: "Drill" });
    for (let i = 0; i < 14; i++)
      await db.insert(activity).values({ householdId: ann.householdId, actorId: null, via: "ferret", action: "recall.found", entityType: "recall", entityId: `r${i}`, summary: `Recall ${i}` });
    const o = await json<Overview>(ann.as("/api/v1/overview"));
    const people = o.activity.filter((a) => a.via !== "ferret");
    const ferret = o.activity.filter((a) => a.via === "ferret");
    expect(people.map((a) => a.itemId)).toContain(drill.id);
    expect(ferret).toHaveLength(12);
  });

  it("a change to a thing deleted since points to Recently deleted", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const fridge = await ann.addItem({ name: "Fridge" });
    await ann.as(`/api/v1/items/${fridge.id}`, { method: "DELETE" });
    const o = await json<Overview>(ann.as("/api/v1/overview"));
    const added = o.activity.find((a) => a.action === "item.create")!;
    expect(added).toMatchObject({ itemId: null, deletedItem: true });
  });

  it("gives the pictures of the things it names", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const drill = await ann.addItem({ name: "Drill", valueCents: 9900 });
    const saw = await ann.addItem({ name: "Saw", valueCents: 5000 });
    const pic = await ann.upload(drill.id, await photo(), "drill.jpg");
    const o = await json<Overview>(ann.as("/api/v1/overview"));
    expect(o.photos[drill.id]).toBe(pic.id);
    expect(o.photos[saw.id]).toBeUndefined();
  });
});

describe("the dashboard's layout", () => {
  it("is each person's own, made whole, and null puts Ferret's back", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const layout = async () => json<DashboardLayout>(ann.as("/api/v1/dashboard-layout"));
    expect(await layout()).toEqual({ order: [...DASHBOARD_SECTIONS], hidden: [], arrange: "auto", sides: {} });

    const saved = await json<DashboardLayout>(
      ann.as("/api/v1/dashboard-layout", { method: "PUT", body: JSON.stringify({ layout: { order: ["activity", "worth", "activity"], hidden: ["claim"] } }) }),
    );
    expect(saved.order.slice(0, 2)).toEqual(["activity", "worth"]);
    expect(saved.order).toHaveLength(DASHBOARD_SECTIONS.length);
    expect(saved.hidden).toEqual(["claim"]);
    expect(saved.arrange).toBe("auto");

    // Chosen columns (Advanced) are kept, sides and all.
    const chosen = await json<DashboardLayout>(
      ann.as("/api/v1/dashboard-layout", { method: "PUT", body: JSON.stringify({ layout: { ...saved, arrange: "chosen", sides: { worth: "wide", activity: "left" } } }) }),
    );
    expect(chosen).toMatchObject({ arrange: "chosen", sides: { worth: "wide", activity: "left" } });
    expect((await ann.as("/api/v1/dashboard-layout", { method: "PUT", body: JSON.stringify({ layout: { ...saved, sides: { worth: "middle" } } }) })).status).toBe(422);
    await ann.as("/api/v1/dashboard-layout", { method: "PUT", body: JSON.stringify({ layout: saved }) });
    expect(await layout()).toMatchObject({ order: saved.order, hidden: saved.hidden });

    const bob = await user("bob");
    expect((await json<DashboardLayout>(bob.as("/api/v1/dashboard-layout"))).hidden).toEqual([]);

    expect((await ann.as("/api/v1/dashboard-layout", { method: "PUT", body: JSON.stringify({ layout: { order: ["nope"], hidden: [] } }) })).status).toBe(422);
    await ann.as("/api/v1/dashboard-layout", { method: "PUT", body: JSON.stringify({ layout: null }) });
    expect((await layout()).hidden).toEqual([]);
  });

  it("lists what was added last, and the next warranty to end however far off", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const drill = await ann.addItem({ name: "Drill" });
    await new Promise((r) => setTimeout(r, 5));
    await ann.addItem({ name: "Saw" });
    await ann.as(`/api/v1/items/${drill.id}/warranties`, { method: "POST", body: JSON.stringify({ provider: "Maker", endsOn: "2031-05-01" }) });
    const o = await json<Overview>(ann.as("/api/v1/overview"));
    expect(o.recentlyAdded.map((c) => c.name)).toEqual(["Saw", "Drill"]);
    expect(o.nextWarranty).toEqual({ itemId: drill.id, itemName: "Drill", endsOn: "2031-05-01" });
  });
});
