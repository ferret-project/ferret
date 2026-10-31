/**
 * Collections: coins, Barbies, baseball cards — things kept as a set. A collection has a name, a description and,
 * usually, a template (lib/templates.ts) whose fields are its columns; things in it have `collectionId`, and new ones
 * start from its template. The **want list** is the pieces still being looked for: items with `wanted`, which
 * itemScope leaves out of everything that counts what you own (totals, the insurance report, stock, search) unless
 * asked — so "Got it" just clears the flag. A collection's page lists both; completeness is owned ÷ (owned + wanted).
 */
import { PHOTO_ORDER } from "./photo-order";
import type { CollectionInput, CollectionPatch, CollectionSummary } from "@ferret/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { attachment, collection, item, itemTemplate } from "../db/schema";
import { type Caller, itemChanged, itemScope, logActivity, notFound } from "./inventory";
import { inList } from "./sql";

const collectionIn = (v: Caller, id: string) => and(eq(collection.id, id), eq(collection.householdId, v.householdId), isNull(collection.deletedAt));

async function checkTemplate(v: Caller, templateId: string | null | undefined) {
  if (!templateId) return;
  const [found] = await v.db
    .select({ id: itemTemplate.id })
    .from(itemTemplate)
    .where(and(eq(itemTemplate.id, templateId), eq(itemTemplate.householdId, v.householdId), isNull(itemTemplate.deletedAt)));
  if (!found) throw notFound("Template");
}

/** Every collection, with what's in it: owned (and pieces, counting duplicates), wanted, worth, cost, a photo. */
export async function listCollections(v: Caller): Promise<CollectionSummary[]> {
  const rows = await v.db
    .select()
    .from(collection)
    .where(and(eq(collection.householdId, v.householdId), isNull(collection.deletedAt)))
    .orderBy(collection.name);
  if (!rows.length) return [];
  const stats = await v.db
    .select({
      collectionId: item.collectionId,
      wanted: item.wanted,
      n: sql<number>`count(*)`,
      pieces: sql<number>`coalesce(sum(max(${item.quantity}, 1)), 0)`,
      value: sql<number>`coalesce(sum(coalesce(${item.valueCents}, ${item.purchasePriceCents}) * max(${item.quantity}, 1)), 0)`,
      cost: sql<number>`coalesce(sum(${item.purchasePriceCents} * max(${item.quantity}, 1)), 0)`,
    })
    .from(item)
    .where(and(itemScope(v, { wanted: "include" }), inList(item.collectionId, rows.map((r) => r.id))))
    .groupBy(item.collectionId, item.wanted);
  // A photo for each: its most valuable owned thing that has one.
  const photos = await v.db
    .select({ collectionId: item.collectionId, photoId: attachment.id, worth: sql<number>`coalesce(${item.valueCents}, ${item.purchasePriceCents}, 0)` })
    .from(item)
    .innerJoin(attachment, and(eq(attachment.itemId, item.id), eq(attachment.kind, "photo"), isNull(attachment.deletedAt)))
    .where(and(itemScope(v), inList(item.collectionId, rows.map((r) => r.id))))
    .orderBy(...PHOTO_ORDER);
  const photoOf = new Map<string, { photoId: string; worth: number }>();
  for (const p of photos) {
    const best = photoOf.get(p.collectionId!);
    if (!best || Number(p.worth) > best.worth) photoOf.set(p.collectionId!, { photoId: p.photoId, worth: Number(p.worth) });
  }
  return rows.map((r) => {
    const owned = stats.find((s) => s.collectionId === r.id && !s.wanted);
    const wanted = stats.find((s) => s.collectionId === r.id && s.wanted);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      templateId: r.templateId,
      owned: Number(owned?.n ?? 0),
      pieces: Number(owned?.pieces ?? 0),
      wanted: Number(wanted?.n ?? 0),
      valueCents: Number(owned?.value ?? 0),
      costCents: Number(owned?.cost ?? 0),
      photoId: photoOf.get(r.id)?.photoId ?? null,
    };
  });
}

export async function getCollection(v: Caller, id: string) {
  const found = (await listCollections(v)).find((c) => c.id === id);
  if (!found) throw notFound("Collection");
  return found;
}

export async function createCollection(v: Caller, input: CollectionInput) {
  await checkTemplate(v, input.templateId);
  const [row] = await v.db
    .insert(collection)
    .values({ householdId: v.householdId, name: input.name, description: input.description ?? null, templateId: input.templateId ?? null })
    .returning();
  await logActivity(v, "collection.create", row!.id, `Started the ${row!.name} collection`);
  return getCollection(v, row!.id);
}

export async function updateCollection(v: Caller, id: string, input: CollectionPatch) {
  await checkTemplate(v, input.templateId);
  const [row] = await v.db.update(collection).set(input).where(collectionIn(v, id)).returning();
  if (!row) throw notFound("Collection");
  // Its name is in what its things say to search.
  if (input.name) {
    const inIt = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v, { wanted: "include" }), eq(item.collectionId, id)));
    for (const i of inIt) await itemChanged(v, i.id);
  }
  return getCollection(v, id);
}

/**
 * Removes the collection (kept 30 days, then purged). What's owned stays, just out of it; its want list goes to
 * Recently deleted with it — those were never things you had.
 */
export async function deleteCollection(v: Caller, id: string) {
  const [row] = await v.db.update(collection).set({ deletedAt: new Date() }).where(collectionIn(v, id)).returning();
  if (!row) throw notFound("Collection");
  const now = new Date();
  await v.db.update(item).set({ deletedAt: now }).where(and(eq(item.householdId, v.householdId), eq(item.collectionId, id), eq(item.wanted, true), isNull(item.deletedAt)));
  const owned = await v.db.select({ id: item.id }).from(item).where(and(eq(item.householdId, v.householdId), eq(item.collectionId, id), isNull(item.deletedAt)));
  await v.db.update(item).set({ collectionId: null }).where(and(eq(item.householdId, v.householdId), eq(item.collectionId, id), isNull(item.deletedAt)));
  for (const i of owned) await itemChanged(v, i.id);
  await logActivity(v, "collection.delete", id, `Removed the ${row.name} collection`);
}
