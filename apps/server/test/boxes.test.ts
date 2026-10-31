/** Boxes (items that hold items) and QR labels. */
import type { ItemListing, ItemSearch, Label } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

async function garage(u: User) {
  const home = await json<{ id: string }>(send(u, "POST", "/api/v1/properties", { name: "Home" }));
  const shelf = await json<{ id: string }>(send(u, "POST", "/api/v1/locations", { propertyId: home.id, name: "Garage shelf" }));
  const attic = await json<{ id: string }>(send(u, "POST", "/api/v1/locations", { propertyId: home.id, name: "Attic" }));
  return { shelf: shelf.id, attic: attic.id };
}

describe("boxes", () => {
  it("hold items, which go wherever the box goes", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const { shelf, attic } = await garage(ann);
    const box = await ann.addItem({ name: "Box 12", isContainer: true, locationId: shelf });
    const lights = await ann.addItem({ name: "Christmas lights", containerItemId: box.id });
    const inner = await ann.addItem({ name: "Ornament tin", isContainer: true, containerItemId: box.id });
    const bauble = await ann.addItem({ name: "Glass bauble", containerItemId: inner.id });

    // Inside a box = in the box's place (so "what's on the garage shelf" finds it).
    const got = await json<ItemListing>(ann.as(`/api/v1/items/${lights.id}`));
    expect(got).toMatchObject({ locationId: shelf, container: { id: box.id, name: "Box 12" }, place: "Home › Garage shelf" });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${box.id}`))).contents).toBe(2);

    // A room shows its boxes, not every box's contents; a box lists what's directly in it.
    const top = await json<ItemSearch>(ann.as(`/api/v1/items?locationId=${shelf}&topLevel=true`));
    expect(top.data.map((i) => i.name)).toEqual(["Box 12"]);
    const inBox = await json<ItemSearch>(ann.as(`/api/v1/items?containerItemId=${box.id}`));
    expect(inBox.data.map((i) => i.name).sort()).toEqual(["Christmas lights", "Ornament tin"]);

    // Moving the box moves everything in it, boxes in boxes too.
    await send(ann, "PATCH", `/api/v1/items/${box.id}`, { locationId: attic });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${bauble.id}`))).locationId).toBe(attic);

    // Search: the item says which box; the box knows what's in it.
    expect((await ann.search("christmas lights")).data.map((i) => i.name)).toContain("Christmas lights");
    expect((await ann.search("box 12")).data.map((i) => i.name)).toEqual(expect.arrayContaining(["Box 12", "Christmas lights"]));

    // An ordinary edit keeps it in the box; a different place takes it out.
    await send(ann, "PATCH", `/api/v1/items/${lights.id}`, { name: "Christmas lights (warm)", locationId: attic });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${lights.id}`))).containerItemId).toBe(box.id);
    await send(ann, "PATCH", `/api/v1/items/${lights.id}`, { locationId: shelf });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${lights.id}`))).containerItemId).toBeNull();
  });

  it("refuse loops and non-boxes, and leave their contents behind when removed", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const { shelf } = await garage(ann);
    const outer = await ann.addItem({ name: "Outer", isContainer: true, locationId: shelf });
    const inner = await ann.addItem({ name: "Inner", isContainer: true, containerItemId: outer.id });
    const drill = await ann.addItem({ name: "Drill" });

    expect((await send(ann, "PATCH", `/api/v1/items/${outer.id}`, { containerItemId: inner.id })).status).toBe(422);
    expect((await send(ann, "PATCH", `/api/v1/items/${outer.id}`, { containerItemId: outer.id })).status).toBe(422);
    expect((await send(ann, "POST", "/api/v1/items", { name: "x", containerItemId: drill.id })).status).toBe(422);
    expect((await send(ann, "PATCH", `/api/v1/items/${outer.id}`, { isContainer: false })).status).toBe(409);

    expect((await send(ann, "DELETE", `/api/v1/items/${outer.id}`)).status).toBe(204);
    const left = await json<ItemListing>(ann.as(`/api/v1/items/${inner.id}`));
    expect(left).toMatchObject({ containerItemId: null, locationId: shelf });

    const bob = await user("bob");
    expect((await send(bob, "POST", "/api/v1/items", { name: "x", containerItemId: inner.id })).status).toBe(404);
  });
});

describe("labels", () => {
  it("are printed blank, stuck on a box, scanned, and found by search", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    const { shelf } = await garage(ann);
    const { codes } = await json<{ codes: string[] }>(send(ann, "POST", "/api/v1/labels/blank", { count: 3 }));
    expect(codes).toHaveLength(3);
    expect(codes[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect((await json<{ data: Label[] }>(ann.as("/api/v1/labels?blank=true"))).data).toHaveLength(3);

    // Scanning a blank label: nothing on it yet.
    expect(await json<Label>(ann.as(`/api/v1/labels/${codes[0]}`))).toMatchObject({ code: codes[0], item: null, location: null });

    const box = await ann.addItem({ name: "Kitchen box 3", isContainer: true });
    const stuck = await json<Label>(send(ann, "PUT", `/api/v1/labels/${codes[0]}`, { itemId: box.id }));
    expect(stuck.item).toMatchObject({ id: box.id, isContainer: true });
    expect((await send(ann, "PUT", `/api/v1/labels/${codes[0]}`, { itemId: box.id })).status).toBe(409);
    expect((await send(ann, "PUT", `/api/v1/labels/${codes[1]}`, { itemId: box.id })).status).toBe(409); // has one already

    // Lower case and look-alikes (O for 0, I/L for 1) still find it; the box's listing carries its code.
    expect((await json<Label>(ann.as(`/api/v1/labels/${codes[0]!.toLowerCase()}`))).item?.name).toBe("Kitchen box 3");
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${box.id}`))).labelCode).toBe(codes[0]);
    expect((await ann.search(codes[0]!)).data.map((i) => i.name)).toEqual(["Kitchen box 3"]);

    // A shelf gets its own label (asking again returns the same one).
    const shelfLabel = await json<Label>(send(ann, "POST", "/api/v1/labels/for", { locationId: shelf }));
    expect(shelfLabel.location).toMatchObject({ id: shelf, path: "Home › Garage shelf" });
    expect((await json<Label>(send(ann, "POST", "/api/v1/labels/for", { locationId: shelf }))).code).toBe(shelfLabel.code);

    // The QR code's address opens the app on the label.
    const link = await app.request(`/l/${codes[0]}`);
    expect(link.status).toBe(302);
    expect(link.headers.get("Location")).toBe(`/#/l/${codes[0]}`);

    // Someone else's label doesn't exist for you.
    const bob = await user("bob");
    expect((await bob.as(`/api/v1/labels/${codes[0]}`)).status).toBe(404);
    expect((await send(bob, "PUT", `/api/v1/labels/${codes[1]}`, { itemId: box.id })).status).toBe(404);

    // Taking it off makes it blank again.
    expect((await send(ann, "DELETE", `/api/v1/labels/${codes[0]}`)).status).toBe(204);
    expect((await json<Label>(ann.as(`/api/v1/labels/${codes[0]}`))).item).toBeNull();
  });
});

describe("labels you already have", () => {
  it("an asset tag or sticker from elsewhere opens its item; codes in use are refused with what has them", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const tent = await ann.addItem({ name: "Tent", isContainer: true });
    const stove = await ann.addItem({ name: "Camp stove" });

    const put = (code: string, itemId: string) => send(ann, "POST", "/api/v1/labels/attach", { code, itemId });
    const first = await json<{ ownLabel: { id: string; code: string } }>(put("ASSET-00042", tent.id));
    expect(first.ownLabel.code).toBe("ASSET-00042");
    expect((await put("ASSET-00042", tent.id)).status).toBe(200); // again on the same thing: fine

    // On something else: refused, saying what has it.
    const taken = await put("ASSET-00042", stove.id);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { message: "That label is already on Tent", details: { itemId: tent.id, name: "Tent" } } });

    // Scanning it opens the tent — also when scanning to add (it's a label, not a product).
    expect(await json(send(ann, "POST", "/api/v1/scan", { code: "ASSET-00042" }))).toMatchObject({ action: "open", item: { id: tent.id } });
    expect(await json(send(ann, "POST", "/api/v1/scan", { code: "ASSET-00042", mode: "add" }))).toMatchObject({ action: "open", item: { id: tent.id } });
    // On its page, and searchable.
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${tent.id}`))).ownLabels).toEqual([first.ownLabel]);
    expect((await ann.search("ASSET-00042")).data.map((i) => i.name)).toEqual(["Tent"]);

    // Another household can use the same roll of stickers.
    const bob = await user("bob");
    const bobs = await bob.addItem({ name: "Bob's tent" });
    expect((await send(bob, "POST", "/api/v1/labels/attach", { code: "ASSET-00042", itemId: bobs.id })).status).toBe(200);
    expect((await send(bob, "DELETE", `/api/v1/labels/own/${first.ownLabel.id}`)).status).toBe(404);

    // Another item's product barcode can't be a sticker; a blank Ferret label goes through as one.
    await ann.addItem({ name: "Lantern", barcode: "036000291452" });
    expect((await put("036000291452", stove.id)).status).toBe(409);
    const { codes } = await json<{ codes: string[] }>(send(ann, "POST", "/api/v1/labels/blank", { count: 1 }));
    expect(await json(put(`https://ferret.example/l/${codes[0]}`, stove.id))).toMatchObject({ label: { code: codes[0], item: { id: stove.id } } });
    // Rooms take Ferret's own labels only.
    const { shelf } = await garage(ann);
    expect((await send(ann, "POST", "/api/v1/labels/attach", { code: "ASSET-00043", locationId: shelf })).status).toBe(422);

    // Taken off: the code opens nothing, and is free for something else.
    expect((await send(ann, "DELETE", `/api/v1/labels/own/${first.ownLabel.id}`)).status).toBe(204);
    expect(await json(send(ann, "POST", "/api/v1/scan", { code: "ASSET-00042" }))).toEqual({ action: "unknown", code: "ASSET-00042" });
    expect((await put("ASSET-00042", stove.id)).status).toBe(200);
  });

  it("an item's label keeps its code: asking again never makes a new one", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const box = await ann.addItem({ name: "Box", isContainer: true });
    const a = await json<Label>(send(ann, "POST", "/api/v1/labels/for", { itemId: box.id }));
    await send(ann, "PATCH", `/api/v1/items/${box.id}`, { name: "Box of cables" });
    expect((await json<Label>(send(ann, "POST", "/api/v1/labels/for", { itemId: box.id }))).code).toBe(a.code);
  });
});
