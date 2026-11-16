/**
 * The search index's signature: which embedding model made the vectors, in which store. Kept in `server_setting`
 * ("search.index") and checked when the startup backfill runs (jobs/index-item.ts). When it changes — a new
 * EMBED_MODEL, a new QDRANT_COLLECTION — every item is embedded again: the old points are cleared first if the store
 * is the same one (vectors from two models never mix; a new size wouldn't even fit), and every item's `indexedAt` is
 * emptied so the backfill queues it. Only items are in the vector store (their documents' text is part of each
 * item's entry), so one pass covers everything.
 *
 * A server that had no signature yet (before this) records what it runs now and re-indexes nothing: its vectors were
 * made by what it was configured with. "Re-index everything" (Settings → Server) is for a change the names can't
 * show — new weights under the same model name.
 */
import { and, count, eq, gte, isNotNull, isNull } from "drizzle-orm";
import type { SearchIndexStatus } from "@ferret/shared";
import { item, serverSetting } from "../db/schema";
import type { Ai, Db, Vectors } from "../ports";

const KEY = "search.index";

export interface IndexSignature {
  model: string | null;
  store: string | null;
}

interface Stored extends IndexSignature {
  /** When the current model started re-indexing everything (absent: it never had to). */
  reindexFrom?: string;
  /** What it was before, for Settings → Server. */
  previous?: IndexSignature;
}

/** This server's signature, or null when search by meaning is off or the adapters can't name themselves. */
export function currentSignature(deps: { ai?: Ai; vectors?: Vectors }): IndexSignature | null {
  if (!deps.ai || !deps.vectors) return null;
  const model = deps.ai.embedModel ?? null;
  const store = deps.vectors.store ?? null;
  return model || store ? { model, store } : null;
}

async function readStored(db: Db): Promise<Stored | null> {
  const [row] = await db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, KEY));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Stored;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStored(db: Db, value: Stored) {
  const text = JSON.stringify(value);
  await db.insert(serverSetting).values({ key: KEY, value: text }).onConflictDoUpdate({ target: serverSetting.key, set: { value: text } });
}

const same = (a: IndexSignature, b: IndexSignature) => a.model === b.model && a.store === b.store;

/** Empties every item's `indexedAt` (leaving `updatedAt`, which orders the item list), so the backfill queues them all. */
async function forgetIndexed(db: Db) {
  await db.update(item).set({ indexedAt: null, updatedAt: item.updatedAt }).where(isNotNull(item.indexedAt));
}

/**
 * Compares the stored signature with this server's; on a change, clears what must go and marks every item to embed
 * again. Returns what it did, for the log.
 */
export async function checkIndexSignature(deps: { db: Db; ai?: Ai; vectors?: Vectors }, now = new Date()): Promise<"none" | "recorded" | "same" | "reindex"> {
  const current = currentSignature(deps);
  if (!current) return "none";
  const stored = await readStored(deps.db);
  if (!stored) {
    await writeStored(deps.db, current);
    return "recorded";
  }
  if (same(stored, current)) return "same";
  // The same store holds the old model's vectors: drop them. A different store is left alone (it may be another
  // model's collection kept to switch back to); every item replaces its own points there as it's embedded.
  if (stored.store === current.store) await deps.vectors!.clear?.();
  await forgetIndexed(deps.db);
  await writeStored(deps.db, { ...current, reindexFrom: now.toISOString(), previous: { model: stored.model, store: stored.store } });
  console.log(
    `Search: the index was made by ${describe(stored)}, this server uses ${describe(current)} — embedding every item again.`,
  );
  return "reindex";
}

/** "Re-index everything" (Settings → Server): clears the store and embeds every item again, models unchanged. */
export async function reindexEverything(deps: { db: Db; ai?: Ai; vectors?: Vectors }, now = new Date()) {
  const current = currentSignature(deps);
  if (!deps.ai || !deps.vectors) return;
  await deps.vectors.clear?.();
  await forgetIndexed(deps.db);
  await writeStored(deps.db, { ...(current ?? { model: null, store: null }), reindexFrom: now.toISOString() });
}

const describe = (s: IndexSignature) => [s.model, s.store].filter(Boolean).join(" → ") || "unnamed models";

/** Settings → Server: which model and store, how many things are embedded, and a re-index under way. */
export async function searchIndexStatus(deps: { db: Db; ai?: Ai; vectors?: Vectors }): Promise<SearchIndexStatus> {
  const available = Boolean(deps.ai && deps.vectors);
  const current = currentSignature(deps);
  const live = isNull(item.deletedAt);
  const [[all], [indexed], stored] = await Promise.all([
    deps.db.select({ n: count() }).from(item).where(live),
    deps.db.select({ n: count() }).from(item).where(and(live, isNotNull(item.indexedAt), gte(item.indexedAt, item.updatedAt))),
    readStored(deps.db),
  ]);
  const total = all?.n ?? 0;
  const done = indexed?.n ?? 0;
  return {
    available,
    model: current?.model ?? null,
    store: current?.store ?? null,
    things: total,
    indexed: done,
    reindexingSince: stored?.reindexFrom && done < total ? stored.reindexFrom : null,
    previous: stored?.reindexFrom && done < total ? (stored.previous ?? null) : null,
  };
}
