/** Recently deleted: 30 days to restore (with photos, warranties, maintenance), delete for good, and the purge. */
import { addDays, type DeletedItem, today } from "@ferret/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attachment, item, warranty } from "../src/db/schema";
import { purgeDeleted } from "../src/lib/trash";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("pixels!")]);
const daysAgo = (n: number) => sql`(unixepoch() * 1000) - ${n * 24 * 60 * 60 * 1000}`;

describe("recently deleted", () => {
  it("keeps a deleted item, with its photo, warranty and maintenance, until it's restored", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const drill = await ann.addItem({ name: "Cordless drill", brand: "DeWalt" });
    const photo = await ann.upload(drill.id, png, "drill.png");
    await send(ann, "POST", `/api/v1/items/${drill.id}/warranties`, { endsOn: addDays(today(), 300) });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Oil the chuck", itemId: drill.id, dueOn: addDays(today(), 10) });

    expect((await send(ann, "DELETE", `/api/v1/items/${drill.id}`)).status).toBe(204);
    expect((await ann.as(`/api/v1/items/${drill.id}`)).status).toBe(404);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/maintenance"))).data).toEqual([]);

    const deleted = await json<{ data: DeletedItem[] }>(ann.as("/api/v1/trash/items"));
    expect(deleted.data).toEqual([
      expect.objectContaining({ id: drill.id, name: "Cordless drill", brand: "DeWalt", deletedBy: "ann", photoId: photo.id, purgesOn: addDays(today(), 30) }),
    ]);
    expect((await json<{ data: DeletedItem[] }>(bob.as("/api/v1/trash/items"))).data).toEqual([]);
    expect((await send(bob, "POST", `/api/v1/trash/items/${drill.id}/restore`)).status).toBe(404);

    expect(await json(send(ann, "POST", `/api/v1/trash/items/${drill.id}/restore`))).toEqual({ id: drill.id, name: "Cordless drill" });
    expect((await ann.as(`/api/v1/items/${drill.id}`)).status).toBe(200);
    expect(await ann.attachments(drill.id)).toHaveLength(1);
    expect((await json<{ data: unknown[] }>(ann.as(`/api/v1/items/${drill.id}/warranties`))).data).toHaveLength(1);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/maintenance"))).data).toHaveLength(1);
    expect((await ann.search("drill")).data.map((h) => h.id)).toContain(drill.id);
    expect((await json<{ data: DeletedItem[] }>(ann.as("/api/v1/trash/items"))).data).toEqual([]);
  });

  it("restores an item without its place if the place went meanwhile", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const shed = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Shed" }));
    const mower = await ann.addItem({ name: "Mower", locationId: shed.id });
    await send(ann, "DELETE", `/api/v1/items/${mower.id}`);
    expect((await send(ann, "DELETE", `/api/v1/locations/${shed.id}`)).status).toBe(204);

    await send(ann, "POST", `/api/v1/trash/items/${mower.id}/restore`);
    expect(await json(ann.as(`/api/v1/items/${mower.id}`))).toMatchObject({ name: "Mower", locationId: null });
  });

  it("deletes for good on request, files and all; live items aren't in the trash", async () => {
    const { user, db, files } = await setup();
    const ann = await user("ann");
    const lamp = await ann.addItem({ name: "Lamp" });
    await ann.upload(lamp.id, png, "lamp.png");
    const [file] = await db.select().from(attachment).where(eq(attachment.itemId, lamp.id));

    expect((await send(ann, "DELETE", `/api/v1/trash/items/${lamp.id}`)).status).toBe(404); // not deleted yet
    await send(ann, "DELETE", `/api/v1/items/${lamp.id}`);
    expect((await send(ann, "DELETE", `/api/v1/trash/items/${lamp.id}`)).status).toBe(204);
    expect(await db.select().from(item).where(eq(item.id, lamp.id))).toEqual([]);
    expect(await db.select().from(attachment).where(eq(attachment.itemId, lamp.id))).toEqual([]);
    expect(await files.get(file!.householdId, file!.blobKey)).toBeNull();
    expect((await send(ann, "POST", `/api/v1/trash/items/${lamp.id}/restore`)).status).toBe(404);
  });

  it("purges what was deleted more than 30 days ago — items with their files, removed photos, and the rest", async () => {
    const { user, db, files, deps } = await setup();
    const ann = await user("ann");
    const old = await ann.addItem({ name: "Old toaster" });
    const recent = await ann.addItem({ name: "Recent kettle" });
    const kept = await ann.addItem({ name: "Kept blender" });
    await ann.upload(old.id, png, "toaster.png");
    const removedPhoto = await ann.upload(kept.id, png, "blurry.png");
    const keptPhoto = await ann.upload(kept.id, png, "good.png");
    await send(ann, "POST", `/api/v1/items/${kept.id}/warranties`, { endsOn: addDays(today(), 100) });
    const [oldFile] = await db.select().from(attachment).where(eq(attachment.itemId, old.id));
    const [blurry] = await db.select().from(attachment).where(eq(attachment.id, removedPhoto.id));

    await send(ann, "DELETE", `/api/v1/items/${old.id}`);
    await send(ann, "DELETE", `/api/v1/items/${recent.id}`);
    await send(ann, "DELETE", `/api/v1/attachments/${removedPhoto.id}`);
    await db.update(item).set({ deletedAt: sql`${daysAgo(31)}` }).where(eq(item.id, old.id));
    await db.update(item).set({ deletedAt: sql`${daysAgo(29)}` }).where(eq(item.id, recent.id));
    await db.update(attachment).set({ deletedAt: sql`${daysAgo(31)}` }).where(eq(attachment.id, removedPhoto.id));
    await db.update(warranty).set({ deletedAt: sql`${daysAgo(40)}` }).where(eq(warranty.itemId, kept.id));

    expect(await purgeDeleted({ db, deps, files })).toMatchObject({ items: 1, files: 1, warranties: 1 });
    expect((await db.select({ name: item.name }).from(item)).map((r) => r.name).sort()).toEqual(["Kept blender", "Recent kettle"]);
    expect(await files.get(oldFile!.householdId, oldFile!.blobKey)).toBeNull();
    expect(await files.get(blurry!.householdId, blurry!.blobKey)).toBeNull();
    expect((await db.select({ id: attachment.id }).from(attachment).where(eq(attachment.itemId, kept.id))).map((a) => a.id)).toEqual([keptPhoto.id]);
    expect(await db.select().from(warranty)).toEqual([]);
    expect((await json<{ data: DeletedItem[] }>(ann.as("/api/v1/trash/items"))).data.map((d) => d.name)).toEqual(["Recent kettle"]);
  });

  it("purges a removed provider who did past maintenance — and the rest of the purge still runs", async () => {
    const { db, deps, files, user } = await setup();
    const ann = await user("ann");
    const plumber = await json<{ id: string }>(send(ann, "POST", "/api/v1/providers", { name: "Ace Plumbing" }));
    const task = await json<{ id: string }>(send(ann, "POST", "/api/v1/maintenance", { title: "Flush water heater", intervalCount: 1, intervalUnit: "year" }));
    await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, { providerId: plumber.id });
    expect((await send(ann, "DELETE", `/api/v1/providers/${plumber.id}`)).status).toBe(204);
    const house = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Old cabin" }));
    await send(ann, "DELETE", `/api/v1/properties/${house.id}`);

    const counts = await purgeDeleted({ db, deps, files }, Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(counts).toMatchObject({ providers: 1, properties: 1 });
    const history = await json<{ data: { providerName: string | null }[] }>(ann.as(`/api/v1/maintenance/${task.id}/history`));
    expect(history.data).toEqual([expect.objectContaining({ providerName: null })]);
  });
});

