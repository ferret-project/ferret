/**
 * Full-text keyword search (SQLite FTS5). Two indexes:
 * words with stemming ("drills" finds "drill"), and trigrams for substrings of
 * serial and model numbers ("1234567" finds "W1234567"). Kept in sync from the
 * app whenever an item, its attachments or its location change.
 */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { attachment, item } from "../db/schema";
import type { Db } from "../ports";
import { itemFields, loadSearchDoc } from "./search-text";

export interface TextHit {
  itemId: string;
  /** Best first. */
  rank: number;
  attachmentId?: string;
  filename?: string;
  snippet?: string;
  /** Only its documents have the words (a manual mentions it), not the thing itself or its photos: weaker evidence. */
  inDocumentsOnly?: boolean;
  /** Matched most of the query's words, not all (minimumShouldMatch): weaker than a match of every word. */
  partial?: boolean;
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
  if (!(indexed?.n ?? 0) && items?.n) {
    const all = await db.select({ id: item.id }).from(item).where(isNull(item.deletedAt));
    for (const { id } of all) await refreshFullText(db, id);
  }
  // The files of properties, places and tasks.
  const [filesIndexed] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM file_search`);
  if (filesIndexed?.n) return;
  const files = await db.select({ id: attachment.id }).from(attachment).where(and(isNull(attachment.itemId), isNull(attachment.deletedAt)));
  for (const { id } of files) await refreshFileSearch(db, id);
}

/**
 * Rewrites a property's, a place's or a task's file in `file_search`: its name, and what was read in it (a photo's
 * description, a document's text). Gone, or a thing's (indexed with the thing): no row.
 */
export async function refreshFileSearch(db: Db, attachmentId: string) {
  await db.run(sql`DELETE FROM file_search WHERE attachment_id = ${attachmentId}`);
  const [f] = await db
    .select({ householdId: attachment.householdId, filename: attachment.filename, analysis: attachment.analysis })
    .from(attachment)
    .where(and(eq(attachment.id, attachmentId), isNull(attachment.itemId), isNull(attachment.inboxId), isNull(attachment.deletedAt)));
  if (!f) return;
  const title = [f.filename, f.analysis?.description].filter(Boolean).join(" — ");
  await db.run(sql`INSERT INTO file_search (attachment_id, household_id, title, body) VALUES (${attachmentId}, ${f.householdId}, ${title}, ${f.analysis?.text ?? ""})`);
}

export interface FileTextHit {
  attachmentId: string;
  snippet?: string;
}

/** Files of properties, places and tasks whose name or text has every word of the query (best first). */
export async function fileTextSearch(db: Db, householdId: string, query: string, limit: number): Promise<FileTextHit[]> {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t)).slice(0, 8);
  if (terms.length === 0) return [];
  const rows = await db.all<{ attachment_id: string; snippet: string }>(sql`
    SELECT f.attachment_id, snippet(file_search, 3, '', '', '…', 24) AS snippet
    FROM file_search f JOIN attachment a ON a.id = f.attachment_id
    WHERE file_search MATCH ${matchQuery(terms)} AND f.household_id = ${householdId} AND a.deleted_at IS NULL
    ORDER BY bm25(file_search, 0, 0, 8.0, 1.0) LIMIT ${limit}`);
  return rows.map((r) => ({ attachmentId: r.attachment_id, snippet: r.snippet || undefined }));
}

/**
 * Every term, as the start of a word ("dril" finds "drill") — except a single letter or digit, which as a start would
 * match nearly everything ("c" of "c++"): that only matches itself, as a whole word.
 */
const matchQuery = (terms: string[]) => terms.map((t) => (t.length > 1 ? `"${t}"*` : `"${t}"`)).join(" ");

/**
 * Words that never say which thing is meant: Lucene's English stop words, and the words around a question about a
 * household's things ("how many … do I have", "where did I put …", "do I still have …"). Left out of every search.
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with " +
    "about after again all also am any anything anywhere been being can could did do does doing done each else find found from get gets " +
    "got had has have having here how i i'd i'm its just keep kept let many may me might mine more most much must my need now our ours own " +
    "please put s same should show so some somewhere still store stored tell than them those us want was we were what whats when where " +
    "wheres which while who whom whose why would you your yours"
  ).split(" "),
);

/**
 * How many of a query's words a thing must have when not all match — Elasticsearch's common `minimum_should_match:
 * "2<75%"`: up to two words, all of them; more, three in four (rounded down). Counted over every word of the query,
 * those found nowhere in the household too: "sewing machine" never becomes "machine".
 */
export const minimumShouldMatch = (words: number) => (words <= 2 ? words : Math.floor(words * 0.75));

/** Every way of choosing `k` of the terms (at most 8 terms, so at most 70 groups). */
function choose<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...choose(rest, k - 1).map((c) => [first!, ...c]), ...choose(rest, k)];
}

/**
 * Items whose text has the query's words (as word prefixes), best first by BM25 — names count most:
 * 1. every word (as typed: what most searches are);
 * 2. else most of them (`minimumShouldMatch`), as one query — an OR of every big enough group of the words that occur
 *    in the household — ranked by BM25, so the rarer words matter most; these are `partial`;
 * 3. else substrings of number-like words (serials, models) in the trigram index.
 */
export async function fullTextSearch(db: Db, householdId: string, query: string, limit: number, opts: { documents?: boolean } = {}): Promise<TextHit[]> {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t)))].slice(0, 8);
  if (terms.length === 0) return [];

  // Without documents: the item's own row and its photos' rows only.
  const noDocuments = opts.documents === false ? sql` AND (attachment_id IS NULL OR attachment_id NOT IN (SELECT id FROM attachment WHERE kind = 'document'))` : sql``;
  type Row = { item_id: string; attachment_id: string | null; filename: string | null; rank: number; snippet: string; kind?: string | null };
  const search = (match: string) =>
    db.all<Row>(sql`
      SELECT item_id, attachment_id, filename, bm25(item_search, 0, 0, 0, 0, 8.0, 1.0) AS rank,
             (SELECT kind FROM attachment WHERE attachment.id = item_search.attachment_id) AS kind,
             snippet(item_search, 5, '', '', '…', 24) AS snippet
      FROM item_search
      WHERE item_search MATCH ${match} AND household_id = ${householdId}${noDocuments}
      ORDER BY rank LIMIT ${limit * 4}`);
  let rows = await search(matchQuery(terms));
  let partial = false;

  // Not every word: most of them. Only words the household has can match, so the groups are made of those.
  const needed = minimumShouldMatch(terms.length);
  if (rows.length === 0 && needed < terms.length) {
    const present: string[] = [];
    for (const t of terms) {
      const [row] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM item_search WHERE item_search MATCH ${matchQuery([t])} AND household_id = ${householdId}${noDocuments}`);
      if (Number(row?.n ?? 0) > 0) present.push(t);
    }
    if (present.length >= needed) {
      const groups = choose(present, needed).map((g) => `(${matchQuery(g)})`);
      rows = await search(groups.join(" OR "));
      partial = rows.length > 0;
    }
  }

  const substrings = terms.filter((t) => t.length >= 3);
  if (rows.length === 0 && substrings.length) {
    rows = await db.all<Row>(sql`
      SELECT item_id, attachment_id, filename, bm25(item_search_trigram) AS rank,
             (SELECT kind FROM attachment WHERE attachment.id = item_search_trigram.attachment_id) AS kind,
             snippet(item_search_trigram, 4, '', '', '…', 24) AS snippet
      FROM item_search_trigram
      WHERE item_search_trigram MATCH ${substrings.map((t) => `"${t}"`).join(" ")} AND household_id = ${householdId}${noDocuments}
      ORDER BY rank LIMIT ${limit * 4}`);
  }

  // Best row per item; a match inside a document carries its passage. Things whose own words match (name, brand,
  // notes, photos) come before things only their documents mention — "television" is the TV, not a manual's FCC notice.
  const hits = new Map<string, TextHit>();
  for (const r of rows) {
    const inDocument = r.kind === "document";
    const hit = hits.get(r.item_id);
    if (hit) {
      if (!inDocument) delete hit.inDocumentsOnly;
      continue;
    }
    hits.set(r.item_id, {
      itemId: r.item_id,
      rank: 0,
      ...(partial ? { partial: true } : {}),
      ...(r.attachment_id
        ? { attachmentId: r.attachment_id, filename: r.filename ?? undefined, snippet: r.snippet || undefined }
        : {}),
      ...(inDocument ? { inDocumentsOnly: true } : {}),
    });
  }
  const ordered = [...hits.values()].sort((a, b) => Number(!!a.inDocumentsOnly) - Number(!!b.inDocumentsOnly)).slice(0, limit);
  ordered.forEach((h, i) => (h.rank = i));
  return ordered;
}
