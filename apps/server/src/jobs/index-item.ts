/**
 * Semantic search indexing. Each item gets one vector for its summary (fields,
 * location path, photo descriptions — see lib/search-text.ts) plus one per chunk of document text, so a line
 * deep in a manual still finds its item. Vectors are derived data: rebuilt from
 * the database whenever an item or its attachments change.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { item } from "../db/schema";
import { itemSummary, loadSearchDoc } from "../lib/search-text";
import type { Ai, Db, JobHandler, Jobs, VectorPoint, Vectors } from "../ports";

export const INDEX_JOB = "item.index";
export const BACKFILL_JOB = "search.backfill";

const CHUNK_CHARS = 1500;
const MAX_CHUNKS_PER_DOCUMENT = 40;
const EMBED_BATCH = 16;

export function indexItem(deps: { db: Db; ai: Ai; vectors: Vectors }): JobHandler {
  return async (payload) => {
    const { itemId } = z.object({ itemId: z.string() }).parse(payload);
    const doc = await loadSearchDoc(deps.db, itemId);
    if (!doc) return deps.vectors.deleteWhere({ itemId });
    const it = doc.item;
    const summary = itemSummary(doc);
    const documents = doc.files.filter((f) => f.kind === "document" && f.analysisStatus === "done" && f.analysis?.text);

    const chunks = documents.flatMap((d) =>
      chunk(d.analysis!.text)
        .slice(0, MAX_CHUNKS_PER_DOCUMENT)
        .map((text, i) => ({ text, i, attachmentId: d.id, filename: d.filename })),
    );
    // The item's name goes in front of each chunk so a chunk alone still says what it's about.
    const texts = [summary, ...chunks.map((c) => `${it.name} — ${c.filename}\n${c.text}`)];
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      vectors.push(...(await deps.ai.embed(texts.slice(i, i + EMBED_BATCH), "document")));
    }

    const base = { householdId: it.householdId, itemId };
    const points: VectorPoint[] = [
      { id: itemId, vector: vectors[0]!, payload: { ...base, source: "item", text: summary.slice(0, 500) } },
      ...(await Promise.all(
        chunks.map(async (c, n) => ({
          id: await uuidFor(`${c.attachmentId}:${c.i}`),
          vector: vectors[n + 1]!,
          payload: { ...base, source: "document", attachmentId: c.attachmentId, filename: c.filename, text: c.text.slice(0, 1000) },
        })),
      )),
    ];
    await deps.vectors.deleteWhere({ itemId });
    await deps.vectors.upsert(points);
    // Mark indexed without bumping updatedAt (which orders the item list) — and only if the
    // item wasn't edited meanwhile; an edit queues its own re-index.
    await deps.db
      .update(item)
      .set({ indexedAt: new Date(), updatedAt: it.updatedAt })
      .where(and(eq(item.id, itemId), eq(item.updatedAt, it.updatedAt)));
  };
}

/** On startup: queue every item that was never indexed or changed since. */
export function backfillIndex(deps: { db: Db; jobs: Jobs }): JobHandler {
  return async () => {
    const stale = await deps.db
      .select({ id: item.id })
      .from(item)
      .where(and(isNull(item.deletedAt), or(isNull(item.indexedAt), lt(item.indexedAt, item.updatedAt))));
    for (const { id } of stale) await deps.jobs.enqueue(INDEX_JOB, { itemId: id });
  };
}

/** Splits text into ~CHUNK_CHARS pieces on paragraph boundaries (hard-splitting very long paragraphs). */
export function chunk(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    for (let i = 0; i < para.length; i += CHUNK_CHARS) {
      const piece = para.slice(i, i + CHUNK_CHARS);
      if (current && current.length + piece.length + 2 > CHUNK_CHARS) {
        out.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/** A stable UUID for a chunk (vector stores want UUID ids), so re-indexing replaces rather than duplicates. */
async function uuidFor(key: string) {
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
