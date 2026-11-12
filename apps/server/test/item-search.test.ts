/** Searching inside one item (its documents, photos' text, warranties, notes), and asking about it. */
import type { AskAnswer, ItemFindResult } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { searchTerms, stem } from "../src/lib/item-search";
import { FakeAi, FakeDocuments, pdf, setup } from "./helpers";

const manual = `# JCDC-3 Cyclone Dust Collector

## 3.0 Features

Pleated filter captures particles down to 1 micron. Remote control works from 50 ft.

## 8.0 User-maintenance

Turn OFF dust collector and remove plug from power source before performing any adjustments or maintenance.

## 8.1 Thermal overload reset

If the overload is tripped, allow the machine to cool down for several minutes. Then press reset button and restart the dust collector.

## 8.2 Cleaning and bag inspection

Clean canister filter frequently to keep the collector's performance at its optimum. Empty or replace canister and drum collection bags when full.`;

const docReply = { description: "Owner's manual for a cyclone dust collector.", text: "", name: null, brand: "JET", model: "JCDC-3", serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null, sure: [] };

async function withManual(chatReplies: unknown[] = [docReply]) {
  const chat = new FakeAi(chatReplies);
  const ctx = await setup({ chat, documents: new FakeDocuments([manual]) });
  const pat = await ctx.user("pat");
  const { id } = await pat.addItem({ name: "Dust collector", notes: "Spare filter bags are in the loft." });
  await pat.as(`/api/v1/items/${id}/warranties`, { method: "POST", body: JSON.stringify({ provider: "Home Depot Protection Plan", endsOn: "2035-11-11", coverage: "Mechanical or electrical failure; consumables like filters are not covered" }) });
  const { id: attachmentId } = await pat.upload(id, pdf(), "JCDC-3 manual.pdf", "document");
  await ctx.jobs.drain();
  const find = async (q: string) => (await (await pat.as(`/api/v1/items/${id}/find?q=${encodeURIComponent(q)}`)).json()) as ItemFindResult;
  return { ...ctx, chat, pat, id, attachmentId, find };
}

describe("words", () => {
  it("matches forms of a word, and leaves out little words when there are others", () => {
    expect(["filters", "cleaning", "batteries", "boxes", "tripped", "glass"].map(stem)).toEqual(["filter", "clean", "battery", "box", "tripp", "glass"]);
    expect(searchTerms("How do I clean the filter?")).toEqual(["clean", "filter"]);
    expect(searchTerms("how")).toEqual(["how"]);
  });
});

describe("finding inside one item", () => {
  it("finds a manual's section by its words, with the heading and the words marked", async () => {
    const { find, attachmentId } = await withManual();
    const r = await find("cleaning filters");
    // Only passages with both words: §8.2 (its heading says Cleaning), not §3.0's filter alone.
    expect(r.passages.map((p) => [p.source, p.label, p.heading])).toEqual([["document", "JCDC-3 manual.pdf", "8.2 Cleaning and bag inspection"]]);
    const [p] = r.passages;
    expect(p).toMatchObject({ attachmentId, text: expect.stringContaining("Empty or replace canister") });
    expect(p!.marks.map(([a, b]) => p!.snippet.slice(a, b))).toEqual(["Clean", "filter"]);
  });

  it("searches warranties and notes too, best matches first", async () => {
    const { find } = await withManual();
    const r = await find("filter");
    expect(r.passages.map((p) => p.heading ?? p.label).sort()).toEqual(["3.0 Features", "8.2 Cleaning and bag inspection", "Home Depot Protection Plan", "Notes"]);
    expect(r.total).toBe(4);
    expect(await find("overlod")).toMatchObject({ passages: [], total: 0 }); // no fuzzy guessing
    expect((await find("overl")).passages[0]).toMatchObject({ heading: "8.1 Thermal overload reset" }); // the start of a word, while typing
  });

  it("is only for the household's own items", async () => {
    const { pat, id, user } = await withManual();
    const sam = await user("sam");
    expect((await sam.as(`/api/v1/items/${id}/find?q=filter`)).status).toBe(404);
    expect((await sam.as(`/api/v1/items/${id}/ask`, { method: "POST", body: JSON.stringify({ question: "How do I reset it?" }) })).status).toBe(404);
    expect((await pat.as(`/api/v1/items/${id}/find?q=`)).status).toBe(422);
  });
});

describe("searching everything without manuals", () => {
  it("leaves out what documents say, but not the thing's own words", async () => {
    const { pat } = await withManual();
    const names = async (q: string, extra = "") => ((await (await pat.as(`/api/v1/items?q=${q}${extra}`)).json()) as { data: { name: string }[] }).data.map((i) => i.name);
    expect(await names("overload")).toEqual(["Dust collector"]); // only its manual says it
    expect(await names("overload", "&documents=exclude")).toEqual([]);
    expect(await names("loft", "&documents=exclude")).toEqual(["Dust collector"]); // its notes
    expect((await pat.as("/api/v1/items?q=x&documents=maybe")).status).toBe(422);
  });
});

describe("asking about one item", () => {
  it("answers from that item's passages and cites the manual", async () => {
    const { pat, id, attachmentId, chat } = await withManual([docReply, { answer: "Let it cool for a few minutes, then press the reset button.", found: true, sources: [1, 3] }]);
    const res = await pat.as(`/api/v1/items/${id}/ask`, { method: "POST", body: JSON.stringify({ question: "How do I reset the overload?" }) });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as AskAnswer;
    const prompt = chat.calls.at(-1)!.prompt;
    expect(prompt).toContain("8.1 Thermal overload reset");
    expect(prompt).toContain("Home Depot Protection Plan");
    expect(answer).toMatchObject({ found: true, answer: expect.stringContaining("reset button") });
    expect(answer.citations).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: id, attachmentId, filename: "JCDC-3 manual.pdf" })]));
  });
});
