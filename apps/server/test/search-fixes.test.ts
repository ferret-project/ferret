/** Search: a thing's own words before its manual's, single letters, and "Did you mean" (lib/fulltext.ts, lib/spelling.ts). */
import type { ItemSearch } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { fuse } from "../src/lib/search";
import { minimumShouldMatch } from "../src/lib/fulltext";
import { editDistance } from "../src/lib/spelling";
import { eq } from "drizzle-orm";
import { attachment } from "../src/db/schema";
import { BACKFILL_JOB } from "../src/jobs/index-item";
import { FakeAi, FakeDocuments, MemoryVectors, pdf, setup } from "./helpers";

const docReply = { description: "Owner's manual.", text: "", name: null, brand: null, model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null, sure: [] };
const manual = "Dust collector manual\n\nThis device complies with part 15 of the FCC rules. It may cause interference to radio or television reception.";

async function house() {
  const ctx = await setup({ ai: new FakeAi([docReply]), documents: new FakeDocuments([manual]) });
  const ann = await ctx.user("ann");
  const collector = await ann.addItem({ name: "Dust collector" });
  await ann.upload(collector.id, pdf(), "manual.pdf", "document");
  await ctx.jobs.drain();
  const tv = await ann.addItem({ name: "Television", brand: "Samsung" });
  await ann.addItem({ name: "Vacuum cleaner", brand: "Dyson" });
  await ann.addItem({ name: "C clamp" });
  const search = async (q: string, as = ann) => (await (await as.as(`/api/v1/items?q=${encodeURIComponent(q)}`)).json()) as ItemSearch;
  const names = async (q: string) => (await search(q)).data.map((i) => i.name);
  return { ...ctx, ann, collector, tv, search, names };
}

describe("words of a question", () => {
  it("needs all of two words, three in four of more", () => {
    expect([1, 2, 3, 4, 5, 6, 8].map(minimumShouldMatch)).toEqual([1, 2, 2, 3, 3, 4, 6]);
  });

  it("finds a thing from a question's words, and nothing for a thing they don't own", async () => {
    const { names, ann } = await house();
    await ann.addItem({ name: "Espresso machine", brand: "Breville" });
    await ann.addItem({ name: "Socket set", brand: "Craftsman", notes: "Red case" });
    expect(await names("how many vacuum cleaners do I have?")).toEqual(["Vacuum cleaner"]); // the question's words left out
    expect(await names("where did I put the dyson")).toEqual(["Vacuum cleaner"]);
    expect(await names("which drawer has the socket set")).toEqual(["Socket set"]); // "drawer" is nowhere: 2 of 3 is enough
    // Words found nowhere in the house still count: "sewing machine" isn't "machine".
    expect(await names("is there a sewing machine somewhere")).toEqual([]);
    expect(await names("do I own a toaster?")).toEqual([]);
  });
});

describe("ranking words", () => {
  it("puts a thing whose own words match before one only its manual mentions", async () => {
    const { names } = await house();
    expect(await names("television")).toEqual(["Television", "Dust collector"]);
  });

  it("lets a one-letter word match only itself, not the start of every word", async () => {
    const { names } = await house();
    expect(await names("c")).toEqual(["C clamp"]);
  });

  it("gives document-only word matches half a vote when words and meaning are merged", () => {
    // The manual's mention is first by words; the TV is first by meaning: the TV wins once the mention counts half.
    expect(fuse([["manual", "tv"], ["tv"]])).toEqual(["tv", "manual"]);
    expect(fuse([["manual"], ["tv"]])).toEqual(["manual", "tv"]); // a tie: words first
    expect(fuse([["manual"], ["tv"]], 60, (id, list) => (list === 0 && id === "manual" ? 0.5 : 1))).toEqual(["tv", "manual"]);
  });
});

describe("did you mean", () => {
  it("counts edits, a swap of neighbours as one", () => {
    expect(editDistance("vacum", "vacuum", 2)).toBe(1);
    expect(editDistance("tleevision", "television", 2)).toBe(1);
    expect(editDistance("drill", "dryer", 1)).toBe(2); // past the limit
  });

  it("offers a close spelling from the household's own words, only when that finds something", async () => {
    const { search, user, ann } = await house();
    expect(await search("vacum")).toMatchObject({ total: 0, suggestion: "vacuum" });
    expect(await search("dysn vacum")).toMatchObject({ suggestion: "dyson vacuum" });
    expect((await search("vacuum")).suggestion).toBeUndefined(); // found: nothing to suggest
    expect((await search("something to make holes in wood")).suggestion).toBeUndefined(); // no close words for all of it
    expect((await search("tv")).suggestion).toBeUndefined(); // short words aren't corrected
    // Everyday words of a question aren't "corrected" to the household's: "many" isn't "man".
    await ann.addItem({ name: "Man cave vacuum" });
    expect((await search("how many vacum")).suggestion).toBe("how many vacuum"); // was "how man vacuum"
    // Another household's words are never offered.
    const bob = await user("bob");
    expect((await search("vacum", bob)).suggestion).toBeUndefined();
  });
});

describe("long manuals searched by meaning to the end", () => {
  it("embeds again, once, only the things whose manuals the old cap cut short", async () => {
    const long = Array.from({ length: 900 }, (_, i) => `Paragraph ${i} of the long manual, about cleaning and care.`).join("\n\n"); // doubled below: past 60,000 characters
    const ai = new FakeAi([docReply, docReply]);
    const env = await setup({ ai, vectors: new MemoryVectors(), documents: new FakeDocuments([`${long}\n\n${long}`, "A short receipt."]) });
    const ann = await env.user("ann");
    const big = await ann.addItem({ name: "Furnace" });
    await ann.upload(big.id, pdf("a"), "furnace-manual.pdf", "document");
    const small = await ann.addItem({ name: "Toaster" });
    await ann.upload(small.id, pdf("b"), "toaster-receipt.pdf", "document");
    await env.jobs.drain();
    const embedded = () => ai.embedCalls.flatMap((c) => c.texts);
    const before = embedded().length;

    await env.jobs.enqueue(BACKFILL_JOB, {});
    await env.jobs.drain();
    const again = embedded().slice(before);
    expect(again.some((t) => t.startsWith("Furnace — furnace-manual.pdf"))).toBe(true);
    expect(again.some((t) => t.includes("Toaster"))).toBe(false);
    expect(again.filter((t) => t.startsWith("Furnace — ")).length).toBeGreaterThan(40); // past the old cap: all of it

    const after = embedded().length;
    await env.jobs.enqueue(BACKFILL_JOB, {});
    await env.jobs.drain();
    expect(embedded().length).toBe(after); // once
  });
});

describe("document limits", () => {
  const long = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i} of a very long manual, about cleaning and care of the machine.`).join("\n\n");
  async function withManual(documentLimits?: { textChars?: number; chunks?: number }) {
    const ai = new FakeAi([docReply]);
    const env = await setup({ ai, vectors: new MemoryVectors(), documents: new FakeDocuments([long]), documentLimits });
    const ann = await env.user("ann");
    const it = await ann.addItem({ name: "Furnace" });
    const { id } = await ann.upload(it.id, pdf(), "furnace-manual.pdf", "document");
    await env.jobs.drain();
    const [row] = await env.db.select({ analysis: attachment.analysis }).from(attachment).where(eq(attachment.id, id));
    const chunks = ai.embedCalls.flatMap((c) => c.texts).filter((t) => t.startsWith("Furnace — ")).length;
    return { text: row!.analysis!.text, chunks };
  }

  it("keeps and embeds a whole manual on a server of its own", async () => {
    const { text, chunks } = await withManual();
    expect(text.length).toBe(long.length); // ~160k characters, all kept
    expect(text).toContain("Paragraph 1999");
    expect(chunks).toBeGreaterThan(100);
  });

  it("keeps and embeds only what a runtime's limits allow", async () => {
    const { text, chunks } = await withManual({ textChars: 50_000, chunks: 10 });
    expect(text.length).toBe(50_000);
    expect(chunks).toBe(10);
  });
});
