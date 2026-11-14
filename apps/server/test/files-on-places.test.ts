/** Files that belong to a property, a place, a maintenance task or a done record (lib/attachments.ts FileOwner). */
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { attachment } from "../src/db/schema";
import { purgeDeleted } from "../src/lib/trash";
import { FakeAi, pdf, photo, setup } from "./helpers";

type File = { id: string; itemId: string | null; propertyId: string | null; locationId: string | null; taskId: string | null; doneId: string | null; analysisStatus: string | null; filename: string };

async function household() {
  const ai = new FakeAi([{ description: "x", text: "", name: null, brand: null, model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null }]);
  const t = await setup({ ai });
  const ann = await t.user("ann");
  const bob = await t.user("bob");
  const send = async <T = { id: string }>(as: typeof ann, method: string, url: string, body?: object) => {
    const res = await as.as(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(res.status, `${method} ${url}`).toBeLessThan(300);
    return (await res.json()) as T;
  };
  const house = await send(ann, "POST", "/api/v1/properties", { name: "Our house" });
  const kitchen = await send(ann, "POST", "/api/v1/locations", { propertyId: house.id, name: "Kitchen" });
  const furnace = await ann.addItem({ name: "Furnace" });
  const gutters = await send(ann, "POST", "/api/v1/maintenance", { title: "Clean the gutters", dueOn: "2026-10-01" });
  const filter = await send(ann, "POST", "/api/v1/maintenance", { title: "Change the filter", itemId: furnace.id, dueOn: "2026-10-01" });
  await send(ann, "POST", `/api/v1/maintenance/${gutters.id}/done`, { doneOn: "2026-10-02" });
  await send(ann, "POST", `/api/v1/maintenance/${filter.id}/done`, { doneOn: "2026-10-02" });
  const gutterDone = (await send<{ data: { id: string }[] }>(ann, "GET", `/api/v1/maintenance/${gutters.id}/history`)).data[0]!;
  const filterDone = (await send<{ data: { id: string }[] }>(ann, "GET", `/api/v1/maintenance/${filter.id}/history`)).data[0]!;
  const add = async (as: typeof ann, owner: Record<string, string>, name: string, kind = "document") => {
    const form = new FormData();
    form.set("file", new File([kind === "photo" ? await photo() : pdf(name)], name));
    form.set("kind", kind);
    for (const [k, v] of Object.entries(owner)) form.set(k, v);
    return as.as("/api/v1/attachments", { method: "POST", body: form });
  };
  const list = async (as: typeof ann, query: string) => (await (await as.as(`/api/v1/attachments?${query}`)).json()) as { data: File[] };
  return { ...t, ann, bob, send, add, list, house, kitchen, furnace, gutters, filter, gutterDone, filterDone, ai };
}

describe("files on properties, places and maintenance", () => {
  it("adds and lists them by what they belong to; a thing's task keeps its files with the thing", async () => {
    const { ann, add, list, house, kitchen, furnace, gutters, filter, gutterDone, filterDone, jobs, ai } = await household();
    const deed = (await (await add(ann, { propertyId: house.id }, "deed.pdf")).json()) as File;
    expect(deed).toMatchObject({ propertyId: house.id, itemId: null, analysisStatus: null });
    const tiles = (await (await add(ann, { locationId: kitchen.id }, "tiles.jpg", "photo")).json()) as File;
    expect(tiles.locationId).toBe(kitchen.id);
    const quote = (await (await add(ann, { taskId: gutters.id }, "quote.pdf")).json()) as File;
    expect(quote).toMatchObject({ taskId: gutters.id, doneId: null });
    const invoice = (await (await add(ann, { doneId: gutterDone.id }, "invoice.pdf")).json()) as File;
    expect(invoice).toMatchObject({ taskId: gutters.id, doneId: gutterDone.id });
    // The furnace's task and done record: the files go on the furnace (its page shows them), the record remembered.
    const manual = (await (await add(ann, { taskId: filter.id }, "filter-manual.pdf")).json()) as File;
    expect(manual).toMatchObject({ itemId: furnace.id, taskId: null, doneId: null });
    const receipt = (await (await add(ann, { doneId: filterDone.id }, "filter-receipt.pdf")).json()) as File;
    expect(receipt).toMatchObject({ itemId: furnace.id, doneId: filterDone.id });

    expect((await list(ann, `propertyId=${house.id}`)).data.map((f) => f.filename)).toEqual(["deed.pdf"]);
    expect((await list(ann, `locationId=${kitchen.id}`)).data.map((f) => f.filename)).toEqual(["tiles.jpg"]);
    expect((await list(ann, `taskId=${gutters.id}`)).data.map((f) => f.filename).sort()).toEqual(["invoice.pdf", "quote.pdf"]);
    expect((await list(ann, `taskId=${filter.id}`)).data.map((f) => f.filename)).toEqual(["filter-receipt.pdf"]);
    expect((await list(ann, `doneId=${gutterDone.id}`)).data.map((f) => f.filename)).toEqual(["invoice.pdf"]);
    expect(((await (await ann.as(`/api/v1/items/${furnace.id}/attachments`)).json()) as { data: File[] }).data.map((f) => f.filename).sort()).toEqual([
      "filter-manual.pdf",
      "filter-receipt.pdf",
    ]);
    // Opened like any file.
    expect((await ann.as(`/api/v1/attachments/${deed.id}/content`)).status).toBe(200);

    // Only a thing's files are read by the AI.
    await jobs.drain();
    expect(ai.calls).toHaveLength(0);
    expect((await ann.as(`/api/v1/attachments/${deed.id}/analyze`, { method: "POST" })).status).toBe(409);
  });

  it("needs exactly one owner", async () => {
    const { ann, add, list, house, kitchen } = await household();
    expect((await add(ann, {}, "x.pdf")).status).toBe(422);
    expect((await add(ann, { propertyId: house.id, locationId: kitchen.id }, "x.pdf")).status).toBe(422);
    expect((await ann.as("/api/v1/attachments")).status).toBe(422);
    expect((await list(ann, `propertyId=${house.id}`)).data).toEqual([]);
  });

  it("another household can't add to them or see them", async () => {
    const { ann, bob, add, list, house, kitchen, gutters, gutterDone } = await household();
    await add(ann, { propertyId: house.id }, "ann-deed.pdf");
    await add(ann, { locationId: kitchen.id }, "ann-kitchen.pdf");
    await add(ann, { taskId: gutters.id }, "ann-quote.pdf");
    await add(ann, { doneId: gutterDone.id }, "ann-invoice.pdf");
    const owners: [string, string][] = [["propertyId", house.id], ["locationId", kitchen.id], ["taskId", gutters.id], ["doneId", gutterDone.id]];
    for (const [k, v] of owners) {
      expect((await add(bob, { [k]: v }, "bob.pdf")).status).toBe(404);
      expect((await add(bob, { [k]: "made-up" }, "bob.pdf")).status).toBe(404);
      expect((await list(bob, `${k}=${v}`)).data).toEqual([]);
    }
  });

  it("removing a place, a property or a task takes its files, and the purge deletes them for good", async () => {
    const t = await household();
    const { ann, add, house, kitchen, gutters, db, deps, files } = t;
    const ids: string[] = [];
    const owners: Record<string, string>[] = [{ locationId: kitchen.id }, { propertyId: house.id }, { taskId: gutters.id }];
    for (const owner of owners) ids.push(((await (await add(ann, owner, "f.pdf")).json()) as File).id);
    expect((await ann.as(`/api/v1/maintenance/${gutters.id}`, { method: "DELETE" })).status).toBeLessThan(300);
    expect((await ann.as(`/api/v1/properties/${house.id}`, { method: "DELETE" })).status).toBeLessThan(300); // takes the kitchen with it
    const rows = await db.select({ id: attachment.id, deletedAt: attachment.deletedAt, blobKey: attachment.blobKey }).from(attachment);
    expect(rows.filter((r) => ids.includes(r.id)).every((r) => r.deletedAt)).toBe(true);
    const blobs = rows.filter((r) => ids.includes(r.id)).map((r) => r.blobKey);
    expect(await files.get(ann.householdId, blobs[0]!)).toBeTruthy();

    await purgeDeleted({ db, deps, files }, Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect((await db.select().from(attachment)).filter((r) => ids.includes(r.id))).toEqual([]);
    for (const key of blobs) expect(await files.get(ann.householdId, key)).toBeNull();
  });

  it("the purge clears a removed owner's files even if they were left behind", async () => {
    const { ann, add, kitchen, db, deps, files } = await household();
    const left = ((await (await add(ann, { locationId: kitchen.id }, "left.pdf")).json()) as File).id;
    const [row] = await db.select({ blobKey: attachment.blobKey }).from(attachment).where(eq(attachment.id, left));
    // Removed some other way than deleteLocation (an older server): the file still live.
    const { location } = await import("../src/db/schema");
    await db.update(location).set({ deletedAt: new Date(0) }).where(eq(location.id, kitchen.id));
    await purgeDeleted({ db, deps, files });
    expect(await db.select().from(attachment).where(eq(attachment.id, left))).toEqual([]);
    expect(await files.get(ann.householdId, row!.blobKey)).toBeNull();
  });

  it("Download everything puts them in a folder for what they belong to", async () => {
    const { ann, add, house, kitchen, gutters } = await household();
    await add(ann, { propertyId: house.id }, "deed.pdf");
    await add(ann, { locationId: kitchen.id }, "inspection.pdf");
    await add(ann, { taskId: gutters.id }, "quote.pdf");
    const res = await ann.as("/api/v1/export/everything.zip");
    expect(res.status).toBe(200);
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(zip).map((n) => n.replace(/^[^/]+\//, ""));
    expect(names).toEqual(expect.arrayContaining(["files/Our house/deed.pdf", "files/Our house - Kitchen/inspection.pdf", "files/Maintenance - Clean the gutters/quote.pdf"]));
    const data = JSON.parse(new TextDecoder().decode(Object.entries(zip).find(([n]) => n.endsWith("ferret.json"))![1])) as {
      properties: { files: { file: string }[] }[];
      places: { files: { file: string }[] }[];
      maintenance: { title: string; files: { file: string }[] }[];
    };
    expect(data.properties[0]!.files.map((f) => f.file)).toEqual([expect.stringMatching(/files\/Our house\/deed\.pdf$/)]);
    expect(data.places[0]!.files).toHaveLength(1);
    expect(data.maintenance.find((m) => m.title === "Clean the gutters")!.files).toHaveLength(1);
  });
});
