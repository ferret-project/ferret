import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ensureFullText } from "../src/lib/fulltext";
import { FakeDocuments, pdf, setup } from "./helpers";

/** Full-text search on its own: no AI configured. */
describe("full-text search", () => {
  it("matches every word, with stemming, names first", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Cordless drill", brand: "DeWalt" });
    const bits = await pat.addItem({ name: "Bit set", notes: "for the cordless drills" });
    await pat.addItem({ name: "Corded sander" });

    expect((await pat.search("drills")).data.map((r) => r.id)).toEqual([drill.id, bits.id]); // name beats notes
    expect((await pat.search("cordless dewalt")).data.map((r) => r.id)).toEqual([drill.id]); // all words required
    expect((await pat.search("where is the dewalt")).data.map((r) => r.id)).toEqual([drill.id]); // stopwords ignored
    expect((await pat.search("cord")).data).toHaveLength(3); // word prefixes
  });

  it("finds serial and model numbers by substring", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer", serialNumber: "W1234567", model: "KSM150PSER" });
    expect((await pat.search("1234567")).data.map((r) => r.id)).toEqual([mixer.id]);
    expect((await pat.search("ksm150")).data.map((r) => r.id)).toEqual([mixer.id]);
  });

  it("searches inside documents and shows the matching passage", async () => {
    const documents = new FakeDocuments(["Owner's manual\n\nService: call 1-800-541-6390 for warranty repairs."]);
    const { jobs, user } = await setup({ documents });
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer" });
    await pat.upload(mixer.id, pdf("manual"), "manual.pdf", "document");
    expect((await pat.search("manual.pdf")).data.map((r) => r.id)).toEqual([mixer.id]); // file name, right away

    await jobs.drain(); // docling's text arrives in the background
    const results = await pat.search("warranty repairs");
    expect(results.hits[mixer.id]).toMatchObject({
      via: "words",
      filename: "manual.pdf",
      snippet: expect.stringContaining("warranty repairs"),
    });
  });

  it("knows where things are, and follows renames and moves", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const house = (await (await pat.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Highland House" }) })).json()) as { id: string };
    const newLoc = async (name: string, parentId?: string) =>
      (
        (await (
          await pat.as("/api/v1/locations", { method: "POST", body: JSON.stringify({ propertyId: house.id, name, parentId }) })
        ).json()) as { id: string }
      ).id;
    const garage = await newLoc("Garage");
    const shelf = await newLoc("Shelf 2", garage);
    const attic = await newLoc("Attic");
    const drill = await pat.addItem({ name: "Drill", locationId: shelf });

    expect((await pat.search("garage")).data.map((r) => r.id)).toEqual([drill.id]); // via the parent location
    expect((await pat.search("highland")).data.map((r) => r.id)).toEqual([drill.id]); // via the property

    const renamed = await pat.as(`/api/v1/locations/${garage}`, { method: "PATCH", body: JSON.stringify({ name: "Workshop" }) });
    expect(renamed.status).toBe(200);
    expect((await pat.search("garage")).data).toEqual([]);
    expect((await pat.search("workshop")).data.map((r) => r.id)).toEqual([drill.id]);

    await pat.as(`/api/v1/locations/${shelf}`, { method: "PATCH", body: JSON.stringify({ parentId: attic }) });
    expect((await pat.search("attic")).data.map((r) => r.id)).toEqual([drill.id]);
    expect((await pat.search("workshop")).data).toEqual([]);

    // A location can't be moved inside itself.
    const loop = await pat.as(`/api/v1/locations/${attic}`, { method: "PATCH", body: JSON.stringify({ parentId: shelf }) });
    expect(loop.status).toBe(422);
  });

  it("keeps households apart and forgets deleted items", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    const sam = await user("sam");
    expect((await sam.search("drill")).data).toEqual([]);

    await pat.as(`/api/v1/items/${drill.id}`, { method: "DELETE" });
    expect((await pat.search("drill")).data).toEqual([]);
  });

  it("fills the index for items that existed before it", async () => {
    const { db, user } = await setup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await db.run(sql`DELETE FROM item_search`);
    await db.run(sql`DELETE FROM item_search_trigram`);
    expect((await pat.search("drill")).data).toEqual([]);

    await ensureFullText(db);
    expect((await pat.search("drill")).data.map((r) => r.id)).toEqual([drill.id]);
  });

  it("looks items up by exact barcode", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer", barcode: "883049118949" });
    await pat.addItem({ name: "Bowl", barcode: "8830491189" });
    const found = async (code: string) =>
      ((await (await pat.as(`/api/v1/items?barcode=${code}`)).json()) as { data: { id: string }[] }).data.map((r) => r.id);
    expect(await found("883049118949")).toEqual([mixer.id]);
    expect(await found("88304911894")).toEqual([]); // exact, not a prefix
    expect((await pat.search("883049118949")).data.map((r) => r.id)).toEqual([mixer.id]); // and searchable
    const sam = await user("sam");
    expect(((await (await sam.as("/api/v1/items?barcode=883049118949")).json()) as { data: unknown[] }).data).toEqual([]);
  });
});
