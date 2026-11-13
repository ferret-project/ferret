/** Last seen, "Can't find it" and room reviews (lib/sightings.ts, lib/room-reviews.ts). */
import type { ItemListing, Overview, RoomReview, RoomToReview } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { item, member } from "../src/db/schema";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const get = (u: User, id: string) => json<ItemListing>(u.as(`/api/v1/items/${id}`));
const history = async (u: User, id: string) => (await json<{ data: { summary: string | null }[] }>(u.as(`/api/v1/items/${id}/history`))).data.map((h) => h.summary);

async function house(u: User) {
  const home = await json<{ id: string }>(send(u, "POST", "/api/v1/properties", { name: "Home" }));
  const garage = await json<{ id: string }>(send(u, "POST", "/api/v1/locations", { name: "Garage", propertyId: home.id }));
  const shed = await json<{ id: string }>(send(u, "POST", "/api/v1/locations", { name: "Shed", propertyId: home.id }));
  return { garage: garage.id, shed: shed.id };
}

describe("last seen and can't find", () => {
  it("\"Still here\" is a sighting: a box takes its contents along, and a missing thing is found again", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const box = await ann.addItem({ name: "Xmas box", isContainer: true });
    const lights = await ann.addItem({ name: "Lights", containerItemId: box.id });
    expect((await get(ann, lights.id)).lastSeen).toBeNull();

    expect((await send(ann, "POST", `/api/v1/items/${lights.id}/missing`)).status).toBe(204);
    expect((await get(ann, lights.id)).missingSince).toBeTruthy();
    const misplaced = await json<{ data: { name: string }[] }>(ann.as("/api/v1/items?misplaced=only"));
    expect(misplaced.data.map((i) => i.name)).toEqual(["Lights"]);
    expect(await history(ann, lights.id)).toContain("Couldn't find Lights");

    expect(await json(send(ann, "POST", `/api/v1/items/${box.id}/seen`))).toEqual({ confirmed: 2 });
    const found = await get(ann, lights.id);
    expect(found.missingSince).toBeNull();
    expect(found.lastSeen).toMatchObject({ kind: "confirmed", how: "box", by: "ann" });
    expect((await get(ann, box.id)).lastSeen).toMatchObject({ kind: "confirmed", how: "app" });
    expect(await history(ann, lights.id)).toContain("Found Lights");
  });

  it("lost for good clears missing; viewers can't mark things", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const ring = await ann.addItem({ name: "Ring" });
    await send(ann, "POST", `/api/v1/items/${ring.id}/missing`);
    await send(ann, "PATCH", `/api/v1/items/${ring.id}`, { disposition: "lost" });
    expect((await get(ann, ring.id)).missingSince).toBeNull();

    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "viewer", createdAt: new Date() });
    const vase = await ann.addItem({ name: "Vase" });
    const headers = { "x-household-id": ann.householdId };
    expect((await bob.as(`/api/v1/items/${vase.id}/seen`, { method: "POST", headers })).status).toBe(403);
  });

  it("not seen since: added before the day and no sighting since; the bell and the dashboard count it", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const old = await ann.addItem({ name: "Old lamp" });
    const seen = await ann.addItem({ name: "Old drill" });
    await ann.addItem({ name: "New thing" });
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    await db.update(item).set({ createdAt: longAgo }).where(eq(item.id, old.id));
    await db.update(item).set({ createdAt: longAgo }).where(eq(item.id, seen.id));
    await send(ann, "POST", `/api/v1/items/${seen.id}/seen`);
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const names = async (q: string) => (await json<{ data: { name: string }[] }>(ann.as(`/api/v1/items?${q}`))).data.map((i) => i.name);
    expect(await names(`notSeenSince=${monthAgo}`)).toEqual(["Old lamp"]);
    expect((await names("sort=seen&dir=desc"))[0]).toBe("Old drill");

    const o = await json<Overview>(ann.as("/api/v1/overview"));
    expect(o.tracking).toMatchObject({ notSeenYear: 1, misplaced: 0 });
    const bell = await json<{ data: { id: string; severity: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.find((b) => b.id === "not-seen")).toMatchObject({ severity: "soon" });
  });
});

describe("room reviews", () => {
  it("walks a place: still here, moved, gone, can't find — then finished, with a line in recent changes", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const { garage, shed } = await house(ann);
    const box = await ann.addItem({ name: "Bin", isContainer: true, locationId: garage });
    const nails = await ann.addItem({ name: "Nails", containerItemId: box.id });
    const drill = await ann.addItem({ name: "Drill", locationId: garage });
    const saw = await ann.addItem({ name: "Saw", locationId: garage });
    const ladder = await ann.addItem({ name: "Ladder", locationId: garage });
    const bike = await ann.addItem({ name: "Bike", locationId: garage });

    let rooms = await json<{ data: RoomToReview[] }>(ann.as("/api/v1/room-reviews"));
    expect(rooms.data[0]).toMatchObject({ locationId: garage, reviewedAt: null, open: null });

    const r0 = await json<RoomReview>(ann.as(`/api/v1/room-reviews/${garage}`));
    expect(r0.review).toBeNull();
    // Only what's kept right there, boxes first; the nails come with their bin.
    expect(r0.toCheck.map((i) => i.name)).toEqual(["Bin", "Bike", "Drill", "Ladder", "Saw"]);
    expect((await send(ann, "POST", `/api/v1/room-reviews/${garage}/items/${drill.id}`, { outcome: "here" })).status).toBe(409);

    await send(ann, "POST", `/api/v1/room-reviews/${garage}`);
    const check = (id: string, b: object) => send(ann, "POST", `/api/v1/room-reviews/${garage}/items/${id}`, b);
    expect((await check(box.id, { outcome: "here" })).status).toBe(200);
    expect((await get(ann, nails.id)).lastSeen).toMatchObject({ kind: "reviewed", how: "box" });
    await check(drill.id, { outcome: "here" });
    expect((await check(saw.id, { outcome: "moved" })).status).toBe(422);
    await check(saw.id, { outcome: "moved", locationId: shed });
    expect((await get(ann, saw.id)).locationId).toBe(shed);
    expect((await check(ladder.id, { outcome: "gone" })).status).toBe(422); // say what happened first
    await send(ann, "PATCH", `/api/v1/items/${ladder.id}`, { disposition: "discarded" });
    await check(ladder.id, { outcome: "gone" });
    const r1 = await json<RoomReview>(await check(bike.id, { outcome: "missing" }));
    expect(r1.toCheck).toEqual([]);
    expect(r1.checked.map((c) => [c.name, c.outcome]).sort()).toEqual([["Bike", "missing"], ["Bin", "here"], ["Drill", "here"], ["Ladder", "gone"], ["Saw", "moved"]]);
    expect((await get(ann, bike.id)).missingSince).toBeTruthy();

    // Changed its mind: the bike was behind the door.
    await check(bike.id, { outcome: "here" });
    expect((await get(ann, bike.id)).missingSince).toBeNull();

    rooms = await json<{ data: RoomToReview[] }>(ann.as("/api/v1/room-reviews"));
    expect(rooms.data.find((r) => r.locationId === garage)?.open).toMatchObject({ done: 5 });

    const done = await json<RoomReview>(send(ann, "POST", `/api/v1/room-reviews/${garage}/finish`));
    expect(done.review).toBeNull();
    expect(done.reviewedAt).toBeTruthy();
    const o = await json<Overview>(ann.as("/api/v1/overview"));
    expect(o.activity[0]?.summary).toBe("Reviewed Garage: 3 still here, 1 moved, 1 gone");
    rooms = await json<{ data: RoomToReview[] }>(ann.as("/api/v1/room-reviews"));
    // The shed (the saw's there now) has never been reviewed, so it's next.
    expect(rooms.data.map((r) => r.locationId)).toEqual([shed, garage]);
  });

  it("only checks what's kept in that place", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const { garage, shed } = await house(ann);
    const rake = await ann.addItem({ name: "Rake", locationId: shed });
    await send(ann, "POST", `/api/v1/room-reviews/${garage}`);
    expect((await send(ann, "POST", `/api/v1/room-reviews/${garage}/items/${rake.id}`, { outcome: "here" })).status).toBe(422);
    expect((await ann.as("/api/v1/room-reviews/nope")).status).toBe(404);
  });
});
