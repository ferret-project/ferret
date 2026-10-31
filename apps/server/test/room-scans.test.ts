/** Room scans (lib/room-scans.ts): photograph a room, review what the vision model found, add what's ticked. */
import type { AttentionItem, ItemListing, RoomScan } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { toBox, toCandidates, withBoxes } from "../src/lib/room-scans";
import type { Entitlements, HouseholdPlan } from "../src/ports";
import { FakeAi, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const livingRoom = {
  items: [
    { name: "Sofa", category: "Furniture", count: 1 },
    { name: "55-inch TV", category: "electronics › tv", count: 1 },
    { name: "Dining chair", category: "Nonsense", count: 4 },
    { name: "", category: null, count: 1 }, // dropped
    { name: "Lamp", category: null, count: 1 },
  ],
};
// Where each one is (asked second): the chairs can't be seen; the lamp's box is too small to be one.
const livingRoomBoxes = { boxes: [[100, 400, 700, 900], [600, 100, 950, 450], null, [5, 5, 6, 6]] };

async function room(u: User) {
  const home = await json<{ id: string }>(send(u, "POST", "/api/v1/properties", { name: "Home" }));
  const lounge = await json<{ id: string }>(send(u, "POST", "/api/v1/locations", { propertyId: home.id, name: "Living room" }));
  const furniture = await json<{ id: string }>(send(u, "POST", "/api/v1/categories", { name: "Furniture" }));
  const electronics = await json<{ id: string }>(send(u, "POST", "/api/v1/categories", { name: "Electronics" }));
  const tv = await json<{ id: string }>(send(u, "POST", "/api/v1/categories", { name: "TV", parentId: electronics.id }));
  return { lounge: lounge.id, furniture: furniture.id, tv: tv.id };
}

async function scan(u: User, fields: Record<string, string>, photos = 1) {
  const form = new FormData();
  for (let i = 0; i < photos; i++) form.append("photo", new File([await photo()], `room-${i}.jpg`));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return u.as("/api/v1/room-scans", { method: "POST", body: form });
}

describe("room scans", () => {
  it("lists what's in the photos to review, then adds what's ticked in the room", async () => {
    const ai = new FakeAi([livingRoom, livingRoomBoxes, livingRoom, new Error("boxes timed out")]);
    const { jobs, user } = await setup({ ai });
    const ann = await user("ann");
    const { lounge, furniture, tv } = await room(ann);

    const started = await scan(ann, { locationId: lounge }, 2);
    expect(started.status).toBe(202);
    const pending = await json<RoomScan>(started);
    expect(pending).toMatchObject({ status: "pending", photos: 2, placeName: "Home › Living room", candidates: [] });

    await jobs.drain();
    expect(ai.calls).toHaveLength(4); // per photo: the list, then where each one is
    expect(ai.calls[0]!.prompt).toContain("Electronics › TV"); // the household's categories, to choose from
    expect(ai.calls[1]!.prompt).toContain("1. Sofa\n2. 55-inch TV");
    const ready = await json<RoomScan>(ann.as(`/api/v1/room-scans/${pending.id}`));
    expect(ready.status).toBe("ready");
    expect(ready.candidates.filter((c) => c.photo === 0)).toEqual([
      { name: "Sofa", categoryId: furniture, quantity: 1, photo: 0, box: [0.1, 0.4, 0.6, 0.5] },
      { name: "55-inch TV", categoryId: tv, quantity: 1, photo: 0, box: [0.6, 0.1, 0.35, 0.35] },
      { name: "Dining chair", categoryId: null, quantity: 4, photo: 0, box: null },
      { name: "Lamp", categoryId: null, quantity: 1, photo: 0, box: null },
    ]);
    // The second photo's boxes didn't come: its list without them.
    expect(ready.candidates.filter((c) => c.photo === 1).map((c) => c.box)).toEqual([null, null, null, null]);
    // Its photos, to review; the bell says it's ready.
    const pic = await ann.as(`/api/v1/room-scans/${pending.id}/photos/1`);
    expect([pic.status, pic.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    expect((await ann.as(`/api/v1/room-scans/${pending.id}/photos/2`)).status).toBe(404);
    const bell = await json<{ data: AttentionItem[] }>(ann.as("/api/v1/attention"));
    expect(bell.data).toContainEqual(expect.objectContaining({ kind: "roomscan", id: pending.id, title: "Room scan ready to review" }));

    // Add the sofa and the chairs (one renamed); the TV left out.
    const added = await json<{ items: { id: string; name: string }[] }>(
      send(ann, "POST", `/api/v1/room-scans/${pending.id}/add`, {
        items: [
          { name: "Sofa", categoryId: furniture },
          { name: "Oak dining chair", quantity: 4, categoryId: "not-ours" },
        ],
      }),
    );
    expect(added.items.map((i) => i.name)).toEqual(["Sofa", "Oak dining chair"]);
    const chair = await json<ItemListing>(ann.as(`/api/v1/items/${added.items[1]!.id}`));
    expect(chair).toMatchObject({ locationId: lounge, quantity: 4, categoryId: null, origin: "roomscan", roomScanId: pending.id });
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${chair.id}/history`));
    expect(history.data.map((h) => h.summary)).toContain("Added Oak dining chair from a room scan");

    // Done: out of the bell, lists what it made, can't be added twice.
    const done = await json<RoomScan>(ann.as(`/api/v1/room-scans/${pending.id}`));
    expect(done.status).toBe("done");
    expect(done.items.map((i) => i.name).sort()).toEqual(["Oak dining chair", "Sofa"]);
    expect((await send(ann, "POST", `/api/v1/room-scans/${pending.id}/add`, { items: [{ name: "Again" }] })).status).toBe(409);
    expect((await json<{ data: AttentionItem[] }>(ann.as("/api/v1/attention"))).data.some((a) => a.kind === "roomscan")).toBe(false);
  });

  it("stays in its household; viewers can't scan; a box's scan fills the box", async () => {
    const ai = new FakeAi([{ items: [{ name: "Tent pegs", category: null, count: 20, box: null }] }]);
    const { jobs, user } = await setup({ ai });
    const ann = await user("ann");
    const bob = await user("bob");
    const box = await ann.addItem({ name: "Camping box", isContainer: true });
    const plain = await ann.addItem({ name: "Kettle" });
    expect((await scan(ann, { containerItemId: plain.id })).status).toBe(422); // not a box
    expect((await scan(bob, { containerItemId: box.id })).status).toBe(404);
    expect((await scan(ann, {})).status).toBe(422);

    const s = await json<RoomScan>(scan(ann, { containerItemId: box.id }));
    await jobs.drain();
    expect((await bob.as(`/api/v1/room-scans/${s.id}`)).status).toBe(404);
    expect((await bob.as(`/api/v1/room-scans/${s.id}/photos/0`)).status).toBe(404);
    const { items } = await json<{ items: { id: string }[] }>(send(ann, "POST", `/api/v1/room-scans/${s.id}/add`, { items: [{ name: "Tent pegs", quantity: 20 }] }));
    expect(await json<ItemListing>(ann.as(`/api/v1/items/${items[0]!.id}`))).toMatchObject({ containerItemId: box.id });

    // Dismissed: gone from the list.
    const other = await json<RoomScan>(scan(ann, { containerItemId: box.id }));
    expect((await send(ann, "DELETE", `/api/v1/room-scans/${other.id}`)).status).toBe(204);
    expect((await json<{ data: RoomScan[] }>(ann.as("/api/v1/room-scans"))).data).toEqual([]);
  });

  it("is one AI action per photo, and refused when the plan has no AI", async () => {
    const ai = new FakeAi([livingRoom]);
    const plan: HouseholdPlan = { name: "Basic", limits: { items: null, fileBytes: null, members: null, ai: false, aiActions: null, barcodeLookups: null, apiKeys: true, shareLinks: true, calendarFeeds: true } };
    const entitlements: Entitlements = { plan: async () => plan };
    const { jobs, user } = await setup({ ai, entitlements });
    const ann = await user("ann");
    const { lounge } = await room(ann);
    expect((await scan(ann, { locationId: lounge })).status).toBe(402);

    plan.limits.ai = true;
    plan.name = "Plus";
    await scan(ann, { locationId: lounge }, 3);
    await jobs.drain();
    const usage = await json<{ aiActions: { used: number }; people: { photos: number }[] }>(ann.as("/api/v1/plan"));
    expect(usage.people[0]!.photos).toBe(3);
    expect(usage.aiActions.used).toBe(6); // a photo is 2
  });

  it("without the vision model, says so", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const { lounge } = await room(ann);
    expect((await scan(ann, { locationId: lounge })).status).toBe(501);
    expect((await json<{ features: { roomScan: boolean } }>(ann.as("/api/v1/me"))).features.roomScan).toBe(false);
  });
});

describe("reading the model's reply", () => {
  it("turns 0–1000 corners into fractions, and drops what's broken", () => {
    expect(toBox([0, 0, 1000, 500])).toEqual([0, 0, 1, 0.5]);
    expect(toBox([500, 500, 400, 600])).toBeNull();
    expect(toBox(null)).toBeNull();
    expect(toCandidates({ items: "nope" }, 0, new Map())).toEqual([]);
    const chair = toCandidates({ items: [{ name: "Chair", count: 0, category: 3 }] }, 1, new Map());
    expect(chair).toEqual([{ name: "Chair", categoryId: null, quantity: 1, photo: 1, box: null }]);
    expect(withBoxes(chair, { boxes: [[1, 2]] })[0]!.box).toBeNull();
    expect(withBoxes(chair, "nonsense")[0]!.box).toBeNull();
  });
});
