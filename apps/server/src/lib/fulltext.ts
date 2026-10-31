/**
 * Full-text keyword search (SQLite FTS5). Two indexes:
 * words with stemming ("drills" finds "drill"), and trigrams for substrings of
 * serial and model numbers ("1234567" finds "W1234567"). Kept in sync from the
 * app whenever an item, its attachments or its location change.
 */
import { count, isNull, sql } from "drizzle-orm";
import { item } from "../db/schema";
import type { Db } from "../ports";
import { itemFields, loadSearchDoc } from "./search-text";

export interface TextHit {
  itemId: string;
  /** Best first. */
  rank: number;
  attachmentId?: string;
  filename?: string;
  snippet?: string;
}

/** Rewrites an item's rows in both indexes (or removes them, if the item is gone). */
export async function refreshFullText(db: Db, itemId: string) {
  const doc = await loadSearchDoc(db, itemId);
  await db.run(sql`DELETE FROM item_search WHERE item_id = ${itemId}`);
  await db.run(sql`DELETE FROM item_search_trigram WHERE item_id = ${itemId}`);
  if (!doc) return;

  const rows = [
    { attachmentId: null, filename: null, title: doc.item.name, body: itemFields(doc).join("\n") },
    ...doc.files.map((f) => ({
      attachmentId: f.id,
      filename: f.filename,
      title: [f.filename, f.analysis?.description].filter(Boolean).join(" — "),
      body: f.analysis?.text ?? "",
    })),
  ];
  for (const r of rows) {
    const keys = sql`${itemId}, ${doc.item.householdId}, ${r.attachmentId}, ${r.filename}`;
    await db.run(sql`INSERT INTO item_search (item_id, household_id, attachment_id, filename, title, body)
      VALUES (${keys}, ${r.title}, ${r.body})`);
    await db.run(sql`INSERT INTO item_search_trigram (item_id, household_id, attachment_id, filename, body)
      VALUES (${keys}, ${`${r.title}\n${r.body}`})`);
  }
}

/** Fills the indexes after they're first created (or if they were lost). */
export async function ensureFullText(db: Db) {
  const [indexed] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM item_search`);
  const [items] = await db.select({ n: count() }).from(item).where(isNull(item.deletedAt));
  if ((indexed?.n ?? 0) > 0 || !items?.n) return;
  const all = await db.select({ id: item.id }).from(item).where(isNull(item.deletedAt));
  for (const { id } of all) await refreshFullText(db, id);
}

/** Small words that would make every word required ("where is the drill") fail to match. */
const STOPWORDS = new Set(
  "a an and are at be by can do find for from have how i in is it its my of on or our the to was what where which who with you".split(
    " ",
  ),
);

/**
 * Items whose text contains every word of the query (as a word prefix), best
 * first by BM25 — names count most. Falls back to substring matching for
 * number-like terms (serials, models) when no whole words match.
 */
export async function fullTextSearch(db: Db, householdId: string, query: string, limit: number): Promise<TextHit[]> {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t)).slice(0, 8);
  if (terms.length === 0) return [];

  type Row = { item_id: string; attachment_id: string | null; filename: string | null; rank: number; snippet: string };
  let rows = await db.all<Row>(sql`
    SELECT item_id, attachment_id, filename, bm25(item_search, 0, 0, 0, 0, 8.0, 1.0) AS rank,
           snippet(item_search, 5, '', '', '…', 24) AS snippet
    FROM item_search
    WHERE item_search MATCH ${terms.map((t) => `"${t}"*`).join(" ")} AND household_id = ${householdId}
    ORDER BY rank LIMIT ${limit * 4}`);

  const substrings = terms.filter((t) => t.length >= 3);
  if (rows.length === 0 && substrings.length) {
    rows = await db.all<Row>(sql`
      SELECT item_id, attachment_id, filename, bm25(item_search_trigram) AS rank,
             snippet(item_search_trigram, 4, '', '', '…', 24) AS snippet
      FROM item_search_trigram
      WHERE item_search_trigram MATCH ${substrings.map((t) => `"${t}"`).join(" ")} AND household_id = ${householdId}
      ORDER BY rank LIMIT ${limit * 4}`);
  }

  // Best row per item; a match inside a document carries its passage.
  const hits = new Map<string, TextHit>();
  for (const r of rows) {
    if (hits.has(r.item_id)) continue;
    hits.set(r.item_id, {
      itemId: r.item_id,
      rank: hits.size,
      ...(r.attachment_id
        ? { attachmentId: r.attachment_id, filename: r.filename ?? undefined, snippet: r.snippet || undefined }
        : {}),
    });
    if (hits.size >= limit) break;
  }
  return [...hits.values()];
}
