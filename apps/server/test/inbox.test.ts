import type { InboxEntry } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attachment } from "../src/db/schema";
import { FakeAi, FakeDocuments, pdf, photo, setup } from "./helpers";

type J = Record<string, unknown>;
const json = async <T = J>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

const drillPhoto = {
  description: "A yellow cordless drill.",
  text: "VOLTRA 20V MAX VD-771",
  name: "Cordless drill",
  brand: "Voltra",
  model: "VD-771",
  serialNumber: null,
  barcode: null,
  purchaseDate: null,
  purchasePrice: null,
  sure: ["name", "brand", "model"],
};

const receipt = {
  description: "Homeworks receipt.",
  text: "",
  purchaseDate: "2026-11-22",
  orderNumber: "HW-1001",
  lines: [
    { name: "Cordless drill", brand: "Voltra", model: "VD-771", quantity: 1, price: 129 },
    { name: "LED bulb 4-pack", brand: null, model: null, quantity: 1, price: 12.49 },
    { name: "PLA filament", brand: null, model: null, quantity: 2, price: 24.99 },
  ],
  sure: [],
};

async function household(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup(opts);
  const pat = await t.user("pat");
  const home = await json<{ id: string }>(pat.as("/api/v1/properties", post({ name: "Home" })));
  const garage = await json<{ id: string }>(pat.as("/api/v1/locations", post({ name: "Garage", propertyId: home.id })));
  const sendFile = async (entryId: string, bytes: Uint8Array<ArrayBuffer>, name: string, kind = "photo") => {
    const form = new FormData();
    form.set("file", new File([bytes], name));
    form.set("kind", kind);
    const up = await pat.as(`/api/v1/inbox/${entryId}/files`, { method: "POST", body: form });
    expect(up.status).toBe(201);
    return json<{ id: string }>(up);
  };
  const start = async (body: J) => {
    const r = await pat.as("/api/v1/inbox", post(body));
    expect(r.status).toBe(201);
    return json<InboxEntry>(r);
  };
  const entry = (id: string) => json<InboxEntry>(pat.as(`/api/v1/inbox/${id}`));
  const count = async () => (await json<{ count: number }>(pat.as("/api/v1/inbox/count"))).count;
  return { ...t, pat, garage, sendFile, start, entry, count };
}

describe("the inbox: read before adding", () => {
  it("reads photos first, then adds them as a new thing where the Add sheet was opened", async () => {
    const { pat, jobs, garage, sendFile, start, entry, count } = await household({ ai: new FakeAi([drillPhoto]) });
    const e = await start({ kind: "photos", locationId: garage.id, tags: ["Tools"] });
    expect(e).toMatchObject({ status: "empty", into: { locationId: garage.id, placeName: "Home › Garage", tags: ["Tools"] } });
    const file = await sendFile(e.id, await photo(), "drill.jpg");
    expect((await entry(e.id)).status).toBe("reading");
    // Nothing is a thing yet, and its file isn't on one or found by search.
    expect((await json<{ data: unknown[] }>(pat.as("/api/v1/items"))).data).toHaveLength(0);
    await jobs.drain();

    const read = await entry(e.id);
    expect(read).toMatchObject({ status: "ready", proposal: { name: "Cordless drill", brand: "Voltra", model: "VD-771" }, receipt: null, matches: [] });
    expect(read.files.map((f) => f.id)).toEqual([file.id]);
    expect(await json(pat.as("/api/v1/attachments/search?q=voltra"))).toEqual({ data: [] });
    expect(await count()).toBe(1);

    const added = await json<{ id: string; name: string; locationId: string; origin: string; tags: string[] }>(
      pat.as(`/api/v1/inbox/${e.id}/add`, post({ name: "Drill", brand: "Voltra", model: "VD-771", tags: [] })),
    );
    expect(added).toMatchObject({ name: "Drill", locationId: garage.id, origin: "photos", tags: ["Tools"] });
    const files = await pat.attachments(added.id);
    expect(files.map((f) => f.id)).toEqual([file.id]);
    expect(files[0]).toMatchObject({ itemId: added.id, inboxId: null, analysisStatus: "done" });
    expect(await count()).toBe(0);
    expect((await pat.as(`/api/v1/inbox/${e.id}`)).status).toBe(404);
    // Found by what was read in its photo, now it's a thing's.
    expect((await pat.search("VD-771")).data.map((i) => i.id)).toEqual([added.id]);
  });

  it("offers a thing already in Ferret with its model, and puts the photos on it", async () => {
    const { pat, jobs, sendFile, start, entry } = await household({ ai: new FakeAi([drillPhoto]) });
    const mine = await pat.addItem({ name: "Dad's drill", model: "vd-771" });
    const e = await start({ kind: "photos" });
    const file = await sendFile(e.id, await photo(), "drill.jpg");
    await jobs.drain();
    expect((await entry(e.id)).matches).toEqual([{ id: mine.id, name: "Dad's drill", place: null }]);

    expect(await json(pat.as(`/api/v1/inbox/${e.id}/onto`, post({ itemId: mine.id })))).toEqual({ id: mine.id, name: "Dad's drill" });
    expect((await pat.attachments(mine.id)).map((f) => f.id)).toEqual([file.id]);
    expect((await json<{ data: unknown[] }>(pat.as("/api/v1/items"))).data).toHaveLength(1); // nothing new
  });

  it("offers a thing with the same kind of name when nothing has its model", async () => {
    const { pat, jobs, sendFile, start, entry } = await household({ ai: new FakeAi([{ ...drillPhoto, name: "Cordless Drill/Driver", model: "XR-1" }]) });
    const mine = await pat.addItem({ name: "Cordless drill", brand: "DeWalt" });
    await jobs.drain();
    const e = await start({ kind: "photos" });
    await sendFile(e.id, await photo(), "drill.jpg");
    await jobs.drain();
    expect((await entry(e.id)).matches.map((m) => m.id)).toEqual([mine.id]);
  });

  it("adds the things on a receipt, each with a copy of it — the ones already in Ferret known", async () => {
    const chat = new FakeAi([receipt]);
    const { pat, jobs, garage, sendFile, start, entry, db } = await household({ chat, documents: new FakeDocuments(["HOMEWORKS\nVOLTRA VD-771 129.00\nLED BULB 4PK 12.49\nPLA 2 @ 24.99"]) });
    const e = await start({ kind: "receipt", locationId: garage.id });
    const file = await sendFile(e.id, pdf(), "receipt.pdf", "document");
    await jobs.drain();
    const read = await entry(e.id);
    expect(read.receipt?.attachmentId).toBe(file.id);
    expect(read.receipt?.lines.map((l) => l.name)).toEqual(["Cordless drill", "LED bulb 4-pack", "PLA filament"]);
    expect(await json(pat.as(`/api/v1/attachments/${file.id}/lines`))).toEqual({ lines: [null, null, null] });

    const made = await json<{ items: { id: string; name: string }[] }>(
      pat.as(`/api/v1/inbox/${e.id}/lines`, post({ lines: [{ name: "Cordless drill", brand: "Voltra", model: "VD-771", priceCents: 12900 }, { name: "LED bulb 4-pack", priceCents: 1249 }] })),
    );
    expect(made.items.map((i) => i.name)).toEqual(["Cordless drill", "LED bulb 4-pack"]);
    for (const it of made.items) {
      const thing = await json<{ locationId: string; purchaseDate: string; origin: string }>(pat.as(`/api/v1/items/${it.id}`));
      expect(thing).toMatchObject({ locationId: garage.id, purchaseDate: "2026-11-22", origin: "receipt" });
      expect((await pat.attachments(it.id)).map((f) => f.filename)).toEqual(["receipt.pdf"]);
    }
    expect((await json<{ data: unknown[] }>(pat.as("/api/v1/items"))).data).toHaveLength(2);
    // The receipt itself went onto the first thing (the others have copies of it).
    const [moved] = await db.select().from(attachment).where(eq(attachment.id, file.id));
    expect(moved).toMatchObject({ itemId: made.items[0]!.id, inboxId: null });

    // The same receipt again: its things are known as already in Ferret.
    const again = await start({ kind: "receipt" });
    const second = await sendFile(again.id, pdf(), "receipt again.pdf", "document");
    await jobs.drain();
    const known = await json<{ order: { number: string; things: number }; lines: ({ id: string } | null)[] }>(pat.as(`/api/v1/attachments/${second.id}/lines`));
    expect(known.order).toMatchObject({ number: "HW-1001", things: 2 });
    expect(known.lines.map((l) => l?.id ?? null)).toEqual([made.items[0]!.id, made.items[1]!.id, null]);
  });

  it("discards an entry and its files", async () => {
    const { pat, jobs, sendFile, start, count, db, files } = await household({ ai: new FakeAi([drillPhoto]) });
    const e = await start({ kind: "photos" });
    const file = await sendFile(e.id, await photo(), "drill.jpg");
    await jobs.drain();
    const [row] = await db.select().from(attachment).where(eq(attachment.id, file.id));
    expect((await pat.as(`/api/v1/inbox/${e.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(attachment).where(eq(attachment.id, file.id))).toEqual([]);
    expect(await files.get(row!.householdId, row!.blobKey).catch(() => null)).toBeNull();
    expect(await count()).toBe(0);
    expect((await pat.as(`/api/v1/inbox/${e.id}/add`, post({ name: "Drill" }))).status).toBe(404);
  });

  it("checks where a new thing would go is the household's own", async () => {
    const { pat, user } = await household();
    const bob = await user("bob");
    const theirs = await json<{ id: string }>(bob.as("/api/v1/categories", post({ name: "Bob's" })));
    expect((await pat.as("/api/v1/inbox", post({ kind: "photos", categoryId: theirs.id }))).status).toBe(404);
    expect((await pat.as("/api/v1/inbox", post({ kind: "boxes" }))).status).toBe(422);
  });
});
