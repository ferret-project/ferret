/**
 * Possible duplicates, and merging them (AI-4 with candidate 11). Pairs come from:
 * - the same serial number, or the same barcode and name (worked out when asked);
 * - meaning: when an item is indexed for search, its nearest neighbours in the household's vectors — items whose
 *   summaries read nearly the same ("Drill" / "DeWalt cordless drill" in the same room) — are kept in `item_pair`.
 * Nothing is merged by itself. "Not a duplicate" is remembered. Merging moves everything that points at the merged
 * item (photos, documents, warranties, maintenance, loans, stock, labels, history…) onto the one kept — found from the
 * schema's foreign keys, so a new table pointing at items is covered — and sends the other to Recently deleted with
 * `mergedIntoId`, so old links lead to the one kept. Never across households.
 */
import type { DuplicatePair, DuplicateSide, ItemPatch, MergeInput } from "@ferret/shared";
import { and, eq, getTableColumns, is, isNull, or, sql } from "drizzle-orm";
import { alias, getTableConfig, SQLiteTable, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import * as schema from "../db/schema";
import { activity, item, itemPair, itemTag } from "../db/schema";
import type { Db } from "../ports";
import { type Caller, asListing, getItem, itemChanged, itemScope, logActivity, notFound, updateItem, withTags } from "./inventory";
import { inList } from "./sql";

/**
 * Embedding similarity above which two items' summaries read as the same thing — with `namesAlike` as well: on the home
 * models a chair and a sofa in the same room score 0.94, so the score alone says little (checked on the dev house).
 */
export const DUPLICATE_SCORE = 0.9;
/** …and in the same place, a little less is enough. */
export const DUPLICATE_SCORE_SAME_PLACE = 0.85;

const STOP = new Set(["a", "an", "the", "of", "and", "with", "for", "set", "new", "old", "my", "our"]);
const wordList = (name: string) => name.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => w.length > 1 && !STOP.has(w)) ?? [];
const words = (name: string) => new Set(wordList(name));
type Facts = { name: string; brand: string | null; model: string | null; serialNumber: string | null };
/**
 * Whether two things' own words say they could be the same — a meaning match alone isn't enough (summaries share the
 * room, the category…): one name's words all in the other's and the same last word ("Drill" / "DeWalt cordless
 * drill", not "TV" / "TV stand"), or most of their words shared; and
 * not two different models or serial numbers.
 */
export function namesAlike(a: Facts, b: Facts) {
  const differ = (x: string | null, y: string | null) => Boolean(x?.trim() && y?.trim() && x.replace(/[\s-]/g, "").toLowerCase() !== y.replace(/[\s-]/g, "").toLowerCase());
  if (differ(a.serialNumber, b.serialNumber) || differ(a.model, b.model)) return false;
  const [x, y] = [words([a.brand, a.name].filter(Boolean).join(" ")), words([b.brand, b.name].filter(Boolean).join(" "))];
  const [nx, ny] = [words(a.name), words(b.name)];
  if (!nx.size || !ny.size) return false;
  // The last word is what it is ("cordless drill" is a drill; a "TV stand" isn't a TV): it has to agree.
  const sameKind = wordList(a.name).at(-1) === wordList(b.name).at(-1);
  const inOther = (from: Set<string>, to: Set<string>) => [...from].every((w) => to.has(w));
  if (sameKind && (inOther(nx, y) || inOther(ny, x))) return true;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= 0.6;
}

const ordered = (x: string, y: string) => (x < y ? ([x, y] as const) : ([y, x] as const));

/**
 * From the index job: this item's nearest neighbours, kept as pairs when they read nearly the same. Old pairs that
 * no longer do are dropped (unless someone said "not a duplicate").
 */
export async function recordNeighbours(
  db: Db,
  vectors: { query: (v: number[], o: { limit: number; filter: Record<string, string> }) => Promise<{ id: string; score: number; payload: Record<string, string | number> }[]> },
  it: { id: string; householdId: string; locationId: string | null },
  vector: number[],
  threshold = { any: DUPLICATE_SCORE, samePlace: DUPLICATE_SCORE_SAME_PLACE },
) {
  const near = await vectors.query(vector, { limit: 6, filter: { householdId: it.householdId, source: "item" } });
  const others = near.filter((n) => String(n.payload.itemId ?? n.id) !== it.id && n.score >= threshold.samePlace);
  // Forget this item's earlier meaning pairs; keep remembered "not a duplicate"s.
  await db.delete(itemPair).where(and(eq(itemPair.householdId, it.householdId), or(eq(itemPair.itemA, it.id), eq(itemPair.itemB, it.id)), isNull(itemPair.notDuplicateAt)));
  if (!others.length) return;
  const facts = { id: item.id, locationId: item.locationId, name: item.name, brand: item.brand, model: item.model, serialNumber: item.serialNumber };
  const [self] = await db.select(facts).from(item).where(and(eq(item.id, it.id), eq(item.householdId, it.householdId)));
  if (!self) return;
  const rows = await db
    .select(facts)
    .from(item)
    .where(and(eq(item.householdId, it.householdId), isNull(item.deletedAt), inList(item.id, others.map((o) => String(o.payload.itemId ?? o.id)))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const o of others) {
    const otherId = String(o.payload.itemId ?? o.id);
    const other = byId.get(otherId);
    if (!other || !namesAlike(self, other)) continue;
    const samePlace = it.locationId != null && other.locationId === it.locationId;
    if (o.score < (samePlace ? threshold.samePlace : threshold.any)) continue;
    const [a, b] = ordered(it.id, otherId);
    await db.insert(itemPair).values({ householdId: it.householdId, itemA: a, itemB: b, score: o.score }).onConflictDoNothing();
  }
}

interface Found {
  a: string;
  b: string;
  reasons: string[];
}

/** Every likely pair in the household, minus the ones someone said aren't. */
async function findPairs(v: Caller): Promise<Found[]> {
  const pairs = new Map<string, Found>();
  const add = (x: string, y: string, reason: string) => {
    const [a, b] = ordered(x, y);
    const key = `${a}|${b}`;
    const p = pairs.get(key) ?? { a, b, reasons: [] };
    if (!p.reasons.includes(reason)) p.reasons.push(reason);
    pairs.set(key, p);
  };
  // The same serial number (things that are one of a kind), and the same barcode and name.
  const rows = await v.db
    .select({ id: item.id, name: item.name, serial: item.serialNumber, barcode: item.barcode, quantity: item.quantity })
    .from(item)
    .where(and(itemScope(v), or(sql`${item.serialNumber} is not null and trim(${item.serialNumber}) <> ''`, sql`${item.barcode} is not null`)));
  const group = (key: (r: (typeof rows)[number]) => string | null, reason: string) => {
    const by = new Map<string, string[]>();
    for (const r of rows) {
      const k = key(r);
      if (k) by.set(k, [...(by.get(k) ?? []), r.id]);
    }
    for (const ids of by.values()) {
      if (ids.length < 2 || ids.length > 6) continue; // six of the same is a set, not a mistake
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i]!, ids[j]!, reason);
    }
  };
  group((r) => (r.serial?.trim() ? r.serial.replace(/[\s-]/g, "").toLowerCase() : null), "Same serial number");
  group((r) => (r.barcode ? `${r.barcode}|${r.name.trim().toLowerCase()}` : null), "Same barcode and name");

  // Read alike (from the index job).
  const a = alias(item, "a");
  const b = alias(item, "b");
  const meaning = await v.db
    .select({
      a: itemPair.itemA,
      b: itemPair.itemB,
      score: itemPair.score,
      aFacts: { name: a.name, brand: a.brand, model: a.model, serialNumber: a.serialNumber },
      bFacts: { name: b.name, brand: b.brand, model: b.model, serialNumber: b.serialNumber },
    })
    .from(itemPair)
    .innerJoin(a, and(eq(a.id, itemPair.itemA), isNull(a.deletedAt), isNull(a.disposition), eq(a.wanted, false)))
    .innerJoin(b, and(eq(b.id, itemPair.itemB), isNull(b.deletedAt), isNull(b.disposition), eq(b.wanted, false)))
    .where(and(eq(itemPair.householdId, v.householdId), isNull(itemPair.notDuplicateAt)));
  // Checked again here: an edit since may have told them apart.
  for (const m of meaning) if (namesAlike(m.aFacts, m.bFacts)) add(m.a, m.b, `Described alike (${Math.round(m.score * 100)}%)`);

  // Not a duplicate: remembered.
  const dismissed = await v.db
    .select({ a: itemPair.itemA, b: itemPair.itemB })
    .from(itemPair)
    .where(and(eq(itemPair.householdId, v.householdId), sql`${itemPair.notDuplicateAt} is not null`));
  for (const d of dismissed) pairs.delete(`${d.a}|${d.b}`);
  return [...pairs.values()];
}

export async function duplicateCount(v: Caller) {
  return (await findPairs(v)).length;
}

/** The "Possible duplicates" list: each pair side by side. */
export async function listDuplicates(v: Caller): Promise<DuplicatePair[]> {
  const pairs = (await findPairs(v)).slice(0, 200);
  if (!pairs.length) return [];
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const rows = await asListing(v, await v.db.select().from(item).where(and(itemScope(v), inList(item.id, ids))));
  const side = new Map<string, DuplicateSide>(
    rows.map((r) => [r.id, { id: r.id, name: r.name, brand: r.brand, model: r.model, serialNumber: r.serialNumber, place: r.place, photoId: r.photoId, createdAt: r.createdAt.toISOString() }]),
  );
  return pairs.flatMap((p) => {
    const [a, b] = [side.get(p.a), side.get(p.b)];
    if (!a || !b) return [];
    const reasons = [...p.reasons];
    if (a.place && a.place === b.place) reasons.push("Same place");
    return [{ a, b, reasons }];
  });
}

/** "Not a duplicate": the pair isn't offered again. */
export async function notDuplicate(v: Caller, x: string, y: string) {
  if (x === y) throw new HTTPException(422, { message: "That's the same thing" });
  const found = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v, { gone: "include" }), inList(item.id, [x, y])));
  if (found.length !== 2) throw notFound("Item");
  const [a, b] = ordered(x, y);
  await v.db
    .insert(itemPair)
    .values({ householdId: v.householdId, itemA: a, itemB: b, score: 0, notDuplicateAt: new Date() })
    .onConflictDoUpdate({ target: [itemPair.itemA, itemPair.itemB], set: { notDuplicateAt: new Date() } });
  return { ok: true };
}

/** Fields a merge can fill on the one kept: empty there, from the other (or from the other wherever `take` says). */
const MERGE_FIELDS = [
  "description", "brand", "model", "serialNumber", "barcode", "condition", "purchaseDate", "returnBy", "purchasePriceCents",
  "valueCents", "replacementCents", "notes", "heir", "categoryId", "locationId", "containerItemId", "usageUnit", "minQuantity",
  "partOfItemId",
] as const;

/** Every column in the schema that points at an item's id (the item table's own box column included). */
function columnsPointingAtItems(): { table: SQLiteTable; column: SQLiteColumn; householdColumn: SQLiteColumn | null }[] {
  const out: { table: SQLiteTable; column: SQLiteColumn; householdColumn: SQLiteColumn | null }[] = [];
  for (const t of Object.values(schema)) {
    if (!is(t, SQLiteTable) || t === itemPair) continue;
    const config = getTableConfig(t);
    const columns = getTableColumns(t) as Record<string, SQLiteColumn>;
    const householdColumn = Object.values(columns).find((c) => c.name === "household_id") ?? null;
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (getTableConfig(ref.foreignTable).name !== "item" || ref.columns.length !== 1 || ref.foreignColumns[0]!.name !== "id") continue;
      out.push({ table: t, column: ref.columns[0]!, householdColumn });
    }
  }
  return out;
}

/** Points `column` = from at `into` — row by row where a unique rule would clash (that row is the kept one's already). */
async function repoint(db: Db, target: ReturnType<typeof columnsPointingAtItems>[number], householdId: string, from: string, into: string) {
  const { table, column, householdColumn } = target;
  const where = and(eq(column, from), householdColumn ? eq(householdColumn, householdId) : undefined);
  try {
    await db.update(table).set({ [Object.entries(getTableColumns(table)).find(([, c]) => c === column)![0]]: into }).where(where);
  } catch {
    const rows = (await db.select({ rowid: sql<number>`rowid` }).from(table).where(where)) as { rowid: number }[];
    const key = Object.entries(getTableColumns(table)).find(([, c]) => c === column)![0];
    for (const r of rows) {
      try {
        await db.update(table).set({ [key]: into }).where(sql`rowid = ${r.rowid}`);
      } catch {
        await db.delete(table).where(sql`rowid = ${r.rowid}`);
      }
    }
  }
}

/** Merges `input.from` into `intoId`: fields, tags, links, everything that points at it; the other to Recently deleted. */
export async function mergeItems(v: Caller, intoId: string, input: MergeInput) {
  if (intoId === input.from) throw new HTTPException(422, { message: "Pick two different things" });
  const [into] = await withTags(v, await v.db.select().from(item).where(and(eq(item.id, intoId), itemScope(v, { gone: "include" }))));
  const [from] = await withTags(v, await v.db.select().from(item).where(and(eq(item.id, input.from), itemScope(v, { gone: "include" }))));
  if (!into || !from) throw notFound("Item");
  if (from.isContainer && into.id === from.containerItemId) throw new HTTPException(422, { message: `${from.name} holds ${into.name} — take it out first` });

  const patch: Record<string, unknown> = {};
  for (const f of MERGE_FIELDS) {
    const [mine, theirs] = [into[f], from[f]];
    if (theirs == null) continue;
    if (mine == null || input.take.includes(f)) patch[f] = theirs;
  }
  // A box into itself can't be: the one kept stays where it is if the other was inside it.
  if (patch.containerItemId === into.id) delete patch.containerItemId;
  // Nor a part of itself: a part of the other one stops being a part when merged into it.
  if (patch.partOfItemId === into.id) delete patch.partOfItemId;
  if (into.partOfItemId === from.id) patch.partOfItemId = null;
  if (input.take.includes("name")) patch.name = from.name;
  if (input.take.includes("quantity")) patch.quantity = from.quantity;
  const tags = [...new Set([...into.tags, ...from.tags])];
  if (tags.length !== into.tags.length) patch.tags = tags;
  const links = [...(into.links ?? []), ...(from.links ?? []).filter((l) => !(into.links ?? []).some((m) => m.url === l.url))].slice(0, 10);
  if (links.length !== (into.links ?? []).length) patch.links = links;
  if (from.customFields) patch.customFields = { ...from.customFields, ...(into.customFields ?? {}) };
  if (from.isContainer && !into.isContainer) patch.isContainer = true;

  // Everything that points at the merged one now points at the one kept.
  for (const target of columnsPointingAtItems()) {
    if (target.table === item && target.column === item.containerItemId) {
      // Its contents: into the kept one (now a box, if it wasn't).
      await v.db.update(item).set({ containerItemId: into.id }).where(and(eq(item.householdId, v.householdId), eq(item.containerItemId, from.id), sql`${item.id} <> ${into.id}`));
      continue;
    }
    if (target.table === item && target.column === item.partOfItemId) {
      // Its parts: the kept one's (but not the kept one itself, if it was one of them).
      await v.db.update(item).set({ partOfItemId: into.id }).where(and(eq(item.householdId, v.householdId), eq(item.partOfItemId, from.id), sql`${item.id} <> ${into.id}`));
      continue;
    }
    if (target.table === itemTag) continue; // tags are merged above
    await repoint(v.db, target, v.householdId, from.id, into.id);
  }
  // Its history (no foreign key: history outlives a purge).
  await v.db.update(activity).set({ itemId: into.id }).where(and(eq(activity.householdId, v.householdId), eq(activity.itemId, from.id)));
  await v.db.delete(itemPair).where(and(eq(itemPair.householdId, v.householdId), or(eq(itemPair.itemA, from.id), eq(itemPair.itemB, from.id))));
  await v.db.delete(itemTag).where(and(eq(itemTag.householdId, v.householdId), eq(itemTag.itemId, from.id)));

  await updateItem(v, into.id, patch as ItemPatch, (name) => `Merged ${from.name} into ${name}`);
  await v.db.update(item).set({ deletedAt: new Date(), mergedIntoId: into.id }).where(and(eq(item.id, from.id), eq(item.householdId, v.householdId)));
  await logActivity(v, "item.merge", from.id, `Merged into ${into.name}`, from.id);
  await itemChanged(v, from.id); // out of search
  await itemChanged(v, into.id);
  return getItem(v, into.id);
}

/** A merged item's id leads to the one it went into (its page, GET /items/:id). */
export async function mergedInto(v: Pick<Caller, "db" | "householdId">, id: string) {
  const [row] = await v.db
    .select({ into: item.mergedIntoId })
    .from(item)
    .where(and(eq(item.id, id), eq(item.householdId, v.householdId), sql`${item.mergedIntoId} is not null`));
  return row?.into ?? null;
}
