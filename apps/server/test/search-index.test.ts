import type { SearchIndexStatus } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { item, serverSetting } from "../src/db/schema";
import { BACKFILL_JOB } from "../src/jobs/index-item";
import { checkIndexSignature } from "../src/lib/search-index";
import { FakeAi, MemoryVectors, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

async function indexSetup(store = "Qdrant gpu.lan:6333/ferret") {
  const ai = new FakeAi([]);
  ai.embedModel = "embedder-a";
  const vectors = new MemoryVectors(store);
  const env = await setup({ ai, vectors });
  const ann = await env.user("ann"); // the server admin
  return { ...env, ai, vectors, ann };
}

const backfill = async (env: Awaited<ReturnType<typeof indexSetup>>) => {
  await env.jobs.enqueue(BACKFILL_JOB, {});
  await env.jobs.drain();
};
const stored = async (env: Awaited<ReturnType<typeof indexSetup>>) => {
  const [row] = await env.db.select().from(serverSetting).where(eq(serverSetting.key, "search.index"));
  return row ? JSON.parse(row.value) : null;
};
const status = (u: User) => json<SearchIndexStatus>(u.as("/api/v1/server/search-index"));

describe("search index signature", () => {
  it("records the models the first time without embedding anything again", async () => {
    const env = await indexSetup();
    const drill = await env.ann.addItem({ name: "Drill" });
    await env.jobs.drain();
    const embedded = env.ai.embedCalls.length;

    await backfill(env);
    expect(await stored(env)).toEqual({ model: "embedder-a", store: "Qdrant gpu.lan:6333/ferret" });
    expect(env.ai.embedCalls.length).toBe(embedded); // already indexed: nothing to do
    expect(env.vectors.points.has(drill.id)).toBe(true);
    expect(await status(env.ann)).toMatchObject({ available: true, model: "embedder-a", things: 1, indexed: 1, reindexingSince: null });
  });

  it("embeds every item again when the embedding model changes, clearing the old vectors in the same store", async () => {
    const env = await indexSetup();
    const drill = await env.ann.addItem({ name: "Drill" });
    const saw = await env.ann.addItem({ name: "Saw" });
    await env.jobs.drain();
    await backfill(env);
    // A point only the old model made (say, a thing since purged): it must not survive in the same store.
    env.vectors.points.set("stale", { id: "stale", vector: [1], payload: { householdId: "x", itemId: "gone" } });
    const [before] = await env.db.select().from(item).where(eq(item.id, drill.id));

    env.ai.embedModel = "embedder-b";
    env.ai.embedCalls = [];
    // The check alone (no job runner yet) marks everything to embed again.
    expect(await checkIndexSignature({ db: env.db, ai: env.ai, vectors: env.vectors })).toBe("reindex");
    expect(env.vectors.points.size).toBe(0);
    expect(await status(env.ann)).toMatchObject({ indexed: 0, things: 2, previous: { model: "embedder-a" } });
    expect((await status(env.ann)).reindexingSince).not.toBeNull();

    await backfill(env);
    expect(env.vectors.points.has(drill.id) && env.vectors.points.has(saw.id)).toBe(true);
    expect(env.ai.embedCalls.flatMap((c) => c.texts).length).toBe(2);
    const [after] = await env.db.select().from(item).where(eq(item.id, drill.id));
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime()); // the list's order is untouched
    expect(await stored(env)).toMatchObject({ model: "embedder-b", previous: { model: "embedder-a" } });
    expect(await status(env.ann)).toMatchObject({ indexed: 2, reindexingSince: null, previous: null });

    // Started again with the same models: nothing more.
    env.ai.embedCalls = [];
    await backfill(env);
    expect(env.ai.embedCalls.length).toBe(0);
  });

  it("leaves another store alone when only the collection changes, and still embeds everything into the new one", async () => {
    const env = await indexSetup();
    await env.ann.addItem({ name: "Drill" });
    await env.jobs.drain();
    await backfill(env);

    // Same database, a new (empty) collection: e.g. QDRANT_COLLECTION=ferret-qwen.
    const other = new MemoryVectors("Qdrant gpu.lan:6333/ferret-qwen");
    let cleared = false;
    other.clear = async () => void (cleared = true);
    expect(await checkIndexSignature({ db: env.db, ai: env.ai, vectors: other })).toBe("reindex");
    expect(cleared).toBe(false);
    const [row] = await env.db.select().from(item);
    expect(row!.indexedAt).toBeNull();
  });

  it("does nothing without names (adapters that can't say which model they are)", async () => {
    const ai = new FakeAi([]);
    const env = await setup({ ai, vectors: new MemoryVectors() });
    await env.jobs.enqueue(BACKFILL_JOB, {});
    await env.jobs.drain();
    const [row] = await env.db.select().from(serverSetting).where(eq(serverSetting.key, "search.index"));
    expect(row).toBeUndefined();
  });

  it("re-indexes everything on the server admin's word, and only theirs", async () => {
    const env = await indexSetup();
    const drill = await env.ann.addItem({ name: "Drill" });
    await env.jobs.drain();
    env.ai.embedCalls = [];

    const res = await env.ann.as("/api/v1/server/search-index/rebuild", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await json<SearchIndexStatus>(res)).toMatchObject({ indexed: 0, things: 1 });
    expect(env.vectors.points.size).toBe(0);
    await env.jobs.drain();
    expect(env.vectors.points.has(drill.id)).toBe(true);
    expect(env.ai.embedCalls.length).toBeGreaterThan(0);
    expect(await status(env.ann)).toMatchObject({ indexed: 1, reindexingSince: null });

    const bob = await env.user("bob");
    expect((await bob.as("/api/v1/server/search-index/rebuild", { method: "POST" })).status).toBe(403);
    expect((await bob.as("/api/v1/server/search-index")).status).toBe(403);
  });

  it("answers that search by meaning is off on a server without it", async () => {
    const env = await setup();
    const ann = await env.user("ann");
    expect(await json(ann.as("/api/v1/server/search-index"))).toMatchObject({ available: false });
    expect((await ann.as("/api/v1/server/search-index/rebuild", { method: "POST" })).status).toBe(409);
  });
});
