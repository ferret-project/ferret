import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { item } from "../src/db/schema";
import { BACKFILL_JOB, chunk } from "../src/jobs/index-item";
import { fuse, semanticSearch } from "../src/lib/search";
import type { TextModel, Vectors } from "../src/ports";
import { FakeAi, FakeDocuments, FakeReranker, MemoryVectors, pdf, setup } from "./helpers";

const blankReply = {
  description: "Warranty card.",
  text: "",
  name: null,
  brand: null,
  model: null,
  serialNumber: null,
  barcode: null,
  purchaseDate: null,
  purchasePrice: null,
};

async function searchSetup() {
  const ai = new FakeAi([blankReply]);
  const vectors = new MemoryVectors();
  const documents = new FakeDocuments(["Limited warranty: coverage for 3 years. Repair or replacement."]);
  const env = await setup({ ai, vectors, documents });
  return { ...env, ai, vectors };
}

describe("semantic search", () => {
  it("indexes items in the background, scoped to their household", async () => {
    const { jobs, vectors, user } = await searchSetup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "DeWalt drill", notes: "Lives on the garage shelf" });
    expect(vectors.points.size).toBe(0); // not inline: the API returns first

    await jobs.drain();
    expect(vectors.points.get(drill.id)?.payload).toMatchObject({
      householdId: pat.householdId,
      itemId: drill.id,
      source: "item",
      text: expect.stringContaining("garage shelf"),
    });
  });

  it("finds by words first, then by meaning", async () => {
    const { jobs, user } = await searchSetup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "DeWalt 20V", notes: "drill and driver" });
    const mixer = await pat.addItem({ name: "KitchenAid", notes: "stand mixer for baking" });
    const holeSaw = await pat.addItem({ name: "Hole saw kit" });
    await jobs.drain();

    const results = await pat.search("hole");
    // "Hole saw kit" matches the word; the drill matches the meaning ("holes" ≈ drill); the mixer doesn't.
    expect(results.data.map((r) => r.id)).toEqual([holeSaw.id, drill.id]);
    expect(results.hits[holeSaw.id]?.via).toBe("words");
    expect(results.hits[drill.id]?.via).toBe("meaning");
    expect(results.data.map((r) => r.id)).not.toContain(mixer.id);
  });

  it("finds items by what's inside their documents", async () => {
    const { jobs, user } = await searchSetup();
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "KitchenAid" });
    await pat.upload(mixer.id, pdf("warranty"), "warranty.pdf", "document");
    await jobs.drain(); // docling → analysis → re-index

    const results = await pat.search("what's still under guarantee?");
    expect(results.data.map((r) => r.id)).toEqual([mixer.id]);
    expect(results.hits[mixer.id]).toMatchObject({
      via: "meaning",
      filename: "warranty.pdf",
      snippet: expect.stringContaining("coverage for 3 years"),
    });
  });

  it("never returns another household's items", async () => {
    const { jobs, user } = await searchSetup();
    const pat = await user("pat");
    await pat.addItem({ name: "Cordless drill" });
    const sam = await user("sam");
    await sam.addItem({ name: "Stand mixer" });
    await jobs.drain();

    const results = await sam.search("drill for making holes");
    expect(results.data.map((r) => r.name)).toEqual([]);
  });

  it("drops deleted items from the index", async () => {
    const { jobs, vectors, user } = await searchSetup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await jobs.drain();
    expect(vectors.points.has(drill.id)).toBe(true);

    await pat.as(`/api/v1/items/${drill.id}`, { method: "DELETE" });
    await jobs.drain();
    expect([...vectors.points.values()].filter((p) => p.payload.itemId === drill.id)).toEqual([]);
  });

  it("falls back to word search when the embedding model is down", async () => {
    const { jobs, ai, user } = await searchSetup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await jobs.drain();

    ai.embedError = new Error("connect ECONNREFUSED");
    const results = await pat.search("drill");
    expect(results.data.map((r) => r.id)).toEqual([drill.id]);
    expect(results.hits[drill.id]?.via).toBe("words");
  });

  it("backfills unindexed items without reordering the list", async () => {
    const { db, jobs, vectors, user } = await searchSetup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await jobs.drain();
    // Pretend search was turned on after this item existed.
    await db.update(item).set({ indexedAt: null, updatedAt: new Date(drill.updatedAt) }).where(eq(item.id, drill.id));
    vectors.points.clear();

    await jobs.enqueue(BACKFILL_JOB, {});
    await jobs.drain();
    expect(vectors.points.has(drill.id)).toBe(true);
    const [row] = await db.select().from(item).where(eq(item.id, drill.id));
    expect(row!.indexedAt).not.toBeNull();
    expect(row!.updatedAt.toISOString()).toBe(drill.updatedAt); // indexing doesn't bump it to the top
  });
});

describe("reranking", () => {
  // A mixer manual: a long baking chapter, then the service details on a later page.
  const manual = `${"Mixing dough and baking a cake with the beater. ".repeat(40)}\n\nService hotline: call 1-800-541-6390 for warranty repair and coverage.`;

  async function rerankSetup() {
    const ai = new FakeAi([{ description: "Mixer manual.", text: "", name: null, brand: null, model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null }]);
    const vectors = new MemoryVectors();
    const reranker = new FakeReranker();
    const documents = new FakeDocuments([manual]);
    const env = await setup({ ai, vectors, reranker, documents });
    return { ...env, reranker };
  }

  it("finds an exact passage the embeddings missed, and shows that passage", async () => {
    const { jobs, user } = await rerankSetup();
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "KitchenAid mixer" });
    await pat.upload(mixer.id, pdf("manual"), "manual.pdf", "document");
    await jobs.drain();

    // Every word present: full-text search finds it, with the passage from the right page.
    const exact = await pat.search("service hotline");
    expect(exact.data.map((r) => r.id)).toEqual([mixer.id]);
    expect(exact.hits[mixer.id]).toMatchObject({ via: "words", filename: "manual.pdf", snippet: expect.stringContaining("hotline") });

    // "phone" isn't in the manual, so full-text misses, and the (fake) embedding is far off —
    // but the reranker sees "hotline" in the passage and rescues it.
    const results = await pat.search("hotline phone");
    expect(results.data.map((r) => r.id)).toEqual([mixer.id]);
    expect(results.hits[mixer.id]).toMatchObject({
      via: "meaning",
      filename: "manual.pdf",
      relevance: 0.5,
      snippet: expect.stringContaining("1-800-541-6390"), // the right page, not the start of the manual
    });
  });

  it("lists strong reranker matches first", async () => {
    const { jobs, user } = await rerankSetup();
    const pat = await user("pat");
    const mixer = await pat.addItem({ name: "Stand mixer", notes: "for dough" });
    const pan = await pat.addItem({ name: "Cake pan", notes: "springform, for baking cheesecake" });
    await jobs.drain();

    const results = await pat.search("springform pan");
    expect(results.data.map((r) => r.id)).toEqual([pan.id]);
    const both = await pat.search("baking dough");
    expect(both.data.map((r) => r.id)).toContain(mixer.id);
  });

  it("keeps working when the reranker is down", async () => {
    const { jobs, reranker, user } = await rerankSetup();
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Cordless drill" });
    await jobs.drain();

    reranker.error = new Error("connect ECONNREFUSED");
    const results = await pat.search("make holes");
    expect(results.data.map((r) => r.id)).toEqual([drill.id]);
    expect(results.hits[drill.id]?.relevance).toBeUndefined();
  });
});

describe("semanticSearch ranking rules", () => {
  // Stub stores with exact scores, to pin down the rules against the calibrated thresholds.
  const run = async (points: [itemId: string, score: number, relevance?: number][], minScore?: number, more: { judge?: TextModel; hold?: boolean } = {}) => {
    const ai = new FakeAi();
    const vectors = {
      query: async () => points.map(([itemId, score]) => ({ id: itemId, score, payload: { itemId, text: itemId, source: "item" } })),
    } as unknown as Vectors;
    const reranker = points.some((p) => p[2] !== undefined)
      ? { rerank: async () => points.map((p) => p[2] ?? 0) }
      : undefined;
    const { hits, held } = await semanticSearch({ ai, vectors, reranker }, "h1", "q", { limit: 10, minScore, ...more });
    return more.hold ? { ids: [...hits.keys()], held } : [...hits.keys()];
  };

  it("holds the unsure ones back for the judge, and lets it decide them", async () => {
    // The judge: picks candidates whose text says "mixer" (by their number in its prompt).
    const asked: string[] = [];
    const judge: TextModel = {
      json: async ({ prompt }) => {
        asked.push(prompt);
        const lines = prompt.split("\n").filter((l) => /^\d+\. /.test(l));
        return { matches: lines.flatMap((l) => (l.includes("mixer") ? [Number(l.split(".")[0])] : [])) };
      },
    };
    const points: [string, number][] = [["mower", 0.62], ["mixer", 0.4], ["circular saw", 0.53], ["toaster", 0.3]];
    // First answer: only the sure one (0.62); the two between the floor and "sure" are held.
    expect(await run(points, undefined, { hold: true })).toEqual({ ids: ["mower"], held: 2 });
    // Then the judge decides them: the mixer (under the cut-off) is in, the saw (over it) is out.
    expect(await run(points, undefined, { judge })).toEqual(["mower", "mixer"]);
    expect(asked[0]).toContain("1. circular saw\n2. mixer");
    // A judge that fails: the cut-off decides. (Other candidates: a judge's answer is kept for the same ones.)
    const others: [string, number][] = [...points, ["kettle", 0.39]];
    expect(await run(others, undefined, { judge: { json: async () => Promise.reject(new Error("down")) } })).toEqual(["mower", "circular saw"]);
  });

  it("uses the embedding cut-off without a reranker", async () => {
    expect(await run([["coffee", 0.6], ["mixer", 0.44], ["toaster", 0.41]])).toEqual(["coffee", "mixer"]);
    expect(await run([["coffee", 0.6], ["mixer", 0.44]], 0.5)).toEqual(["coffee"]); // alongside word matches
  });

  it("rescues strong reranker matches below the cut-off and lists them first", async () => {
    expect(await run([["ladder", 0.52, 0], ["serial", 0.2, 0.97]])).toEqual(["serial", "ladder"]);
  });

  it("drops the weak tail when there's a clear answer, but keeps strong embedding matches", async () => {
    // "how long is the mixer warranty": the espresso machine (0.45, rr 0) shouldn't tag along.
    expect(await run([["mixer", 0.55, 0.96], ["espresso", 0.45, 0], ["drill", 0.52, 0]])).toEqual(["mixer", "drill"]);
  });

  it("keeps intent matches the reranker scores near zero", async () => {
    // "reach the gutters" → ladder: rr 0.0002, but the embedding is confident.
    expect(await run([["ladder", 0.47, 0.0002], ["snowblower", 0.4, 0]])).toEqual(["ladder"]);
  });
});

describe("fuse", () => {
  it("ranks items found by both lists first, then interleaves", () => {
    expect(fuse([["a", "b", "c"], ["c", "d"]])).toEqual(["c", "a", "b", "d"]); // b and d tie at 1/62
    expect(fuse([["a"], []])).toEqual(["a"]);
    expect(fuse([["a", "b"], ["b", "a"]])).toEqual(["a", "b"]); // a tie keeps the first list's order
  });
});

describe("chunk", () => {
  it("splits on paragraphs and hard-splits very long ones", () => {
    expect(chunk("one\n\ntwo")).toEqual(["one\n\ntwo"]);
    const long = "x".repeat(3200);
    expect(chunk(long).map((c) => c.length)).toEqual([1500, 1500, 200]);
    expect(chunk("")).toEqual([]);
  });
});
