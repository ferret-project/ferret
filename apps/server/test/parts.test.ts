/** Parts & supplies: parts of a thing, its maintenance's parts, the parts its manuals list, and reading them. */
import type { ItemParts } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { partsExcerpt, toAnalysis } from "../src/jobs/analyze";
import { FakeAi, FakeDocuments, pdf, setup } from "./helpers";

const manualReply = {
  description: "Owner's manual for a cyclone dust collector.",
  text: "",
  name: null, brand: "JET", model: "JCDC-3", serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null,
  returnDays: null, returnBy: null, warrantyMonths: null, warrantyProvider: null, maintenance: [],
  parts: [
    { name: "Drum collection bag", partNumber: "717531", packSize: 5 },
    { name: "Canister collection bag", partNumber: "717511", packSize: 5 },
    { name: "Canister filter", partNumber: "JCDC3-63", packSize: null },
  ],
  sure: [],
};

async function withCollector() {
  const ctx = await setup({ chat: new FakeAi([manualReply]), documents: new FakeDocuments(["# JCDC-3 manual\n\n## 9.0 Optional accessories\n\n717531 Drum collection bag (package of 5)"]) });
  const pat = await ctx.user("pat");
  const { id } = await pat.addItem({ name: "Dust collector", brand: "JET" });
  const { id: attachmentId } = await pat.upload(id, pdf(), "JCDC-3 manual.pdf", "document");
  await ctx.jobs.drain();
  const parts = async (as = pat) => (await (await as.as(`/api/v1/items/${id}/parts`)).json()) as ItemParts;
  return { ...ctx, pat, id, attachmentId, parts };
}

describe("parts of a thing", () => {
  it("lists its parts with stock and where to buy, and the manual's parts it doesn't have yet", async () => {
    const { pat, id, attachmentId, parts } = await withCollector();
    expect((await parts()).suggested.map((s) => [s.partNumber, s.packSize, s.attachmentId])).toEqual([["717531", 5, attachmentId], ["717511", 5, attachmentId], ["JCDC3-63", undefined, attachmentId]]);

    // Added from the suggestion (the store's prefix "JT9-" still matches it): it leaves the suggestions.
    await pat.addItem({ name: "JET drum collection bags (5-pack)", brand: "JET", model: "JT9-717531", quantity: 0, minQuantity: 0, partOfItemId: id });
    const r = await parts();
    expect(r.parts).toEqual([
      expect.objectContaining({ name: "JET drum collection bags (5-pack)", model: "JT9-717531", quantity: 0, low: true, link: null, amazonCart: null, amazonSearch: "https://www.amazon.com/s?k=JET%20JT9-717531" }),
    ]);
    expect(r.suggested.map((s) => s.partNumber)).toEqual(["717511", "JCDC3-63"]);

    // A part its maintenance uses counts too, and says which task.
    const filter = await pat.addItem({ name: "Canister filter", model: "JCDC3-63", quantity: 1, links: [{ url: "https://www.amazon.com/dp/B00ABCDEFG", label: "Amazon" }, { url: "https://www.rockler.com/filter", label: "Rockler" }] });
    expect((await pat.as("/api/v1/maintenance", { method: "POST", body: JSON.stringify({ itemId: id, title: "Replace the filter", intervalCount: 1, intervalUnit: "year", partItemId: filter.id }) })).status).toBe(201);
    const withTask = await parts();
    expect(withTask.parts.find((p) => p.id === filter.id)).toMatchObject({ task: "Replace the filter", low: false, link: { url: "https://www.rockler.com/filter" }, amazonCart: expect.stringContaining("ASIN.1=B00ABCDEFG"), amazonSearch: null });
    expect(withTask.suggested.map((s) => s.partNumber)).toEqual(["717511"]);

    // Not needed: gone from the suggestions for good.
    expect((await pat.as(`/api/v1/items/${id}/parts/dismiss`, { method: "POST", body: JSON.stringify({ attachmentId, partNumber: "717511" }) })).status).toBe(204);
    expect((await parts()).suggested).toEqual([]);
  });

  it("is a part only of the household's own things, and not of itself", async () => {
    const { pat, id, user, parts } = await withCollector();
    const sam = await user("sam");
    const theirs = await sam.addItem({ name: "Sam's vacuum" });
    expect((await pat.as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Bags", partOfItemId: theirs.id }) })).status).toBe(404);
    expect((await pat.as(`/api/v1/items/${id}`, { method: "PATCH", body: JSON.stringify({ partOfItemId: id }) })).status).toBe(422);
    expect((await sam.as(`/api/v1/items/${id}/parts`)).status).toBe(404);
    // Unlinked: it stays, just not as a part.
    const bag = await pat.addItem({ name: "Bags", partOfItemId: id });
    await pat.as(`/api/v1/items/${bag.id}`, { method: "PATCH", body: JSON.stringify({ partOfItemId: null }) });
    expect((await parts()).parts).toEqual([]);
  });
});

describe("merging", () => {
  it("moves the merged one's parts to the one kept, and never makes a thing a part of itself", async () => {
    const { user } = await setup();
    const pat = await user("pat");
    const keep = await pat.addItem({ name: "Dust collector" });
    const gone = await pat.addItem({ name: "JET JCDC-3" });
    const bag = await pat.addItem({ name: "Bags", partOfItemId: gone.id });
    // The kept one was (wrongly) listed as a part of the other.
    await pat.as(`/api/v1/items/${keep.id}`, { method: "PATCH", body: JSON.stringify({ partOfItemId: gone.id }) });
    expect((await pat.as(`/api/v1/items/${keep.id}/merge`, { method: "POST", body: JSON.stringify({ from: gone.id }) })).status).toBe(200);
    const get = async (id: string) => (await (await pat.as(`/api/v1/items/${id}`)).json()) as { partOfItemId: string | null };
    expect(await get(bag.id)).toMatchObject({ partOfItemId: keep.id });
    expect(await get(keep.id)).toMatchObject({ partOfItemId: null });
  });
});

describe("reading parts from a manual", () => {
  it("keeps part numbers, not a drawing's index numbers, and pack sizes only when there's a package", () => {
    const a = toAnalysis({
      ...manualReply,
      parts: [
        { name: "Drum collection bag", partNumber: "717531", packSize: 5 },
        { name: "Gasket", partNumber: "56", packSize: 1 },
        { name: "Hose clamp", partNumber: "JCDC2-40", packSize: 1 },
        { name: "Drum collection bag", partNumber: "717531", packSize: 5 },
        "nonsense",
      ],
    });
    expect(a.suggestions.parts).toEqual([{ name: "Drum collection bag", partNumber: "717531", packSize: 5 }, { name: "Hose clamp", partNumber: "JCDC2-40" }]);
  });

  it("shows the model the supplies in a long manual's parts list, without the index column", () => {
    const filler = "Read the manual before use. ".repeat(500);
    const manual = `# Manual\n\n${filler}\n\n## 11.1.2 Parts List\n\n1 … JCDC3-01 … Motor … 3HP … 1\n35 … 717531 … Drum Collection Bag for JCDC-3 (pkg. of 5) … 1\n63 … JCDC3-63 … Canister Filter … 1\n\n## Warranty\n\nFive years.`;
    expect(partsExcerpt(manual)).toBe("\n\n[…]\n\n## 11.1.2 Parts List\n717531 … Drum Collection Bag for JCDC-3 (pkg. of 5) … 1\nJCDC3-63 … Canister Filter … 1");
    expect(partsExcerpt("# Short manual\n\n## Parts list\n\n717531 bag")).toBe(""); // all of it is read anyway
  });
});
