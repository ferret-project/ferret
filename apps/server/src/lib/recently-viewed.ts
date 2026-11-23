/**
 * Recently viewed: what each person opened lately (`item_view`), for the dashboard. The web app says so when a thing's
 * page opens (`POST /items/:id/viewed`); one row per person and thing, the newest KEEP kept. Personal: never another
 * person's, not history, not a change to the thing (no re-index, no activity row, no webhook).
 */
import type { ThingCard } from "@ferret/shared";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { collection, item, itemView } from "../db/schema";
import { asListing, type Caller, itemScope } from "./inventory";
import { inList } from "./sql";

/** How many each person keeps (the dashboard shows a few; the rest stand in for things deleted since). */
const KEEP = 12;

export async function recordView(v: Caller, itemId: string) {
  if (!v.userId) return;
  const [found] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!found) throw new HTTPException(404, { message: "Item not found" });
  const at = new Date();
  await v.db
    .insert(itemView)
    .values({ householdId: v.householdId, userId: v.userId, itemId, at })
    .onConflictDoUpdate({ target: [itemView.userId, itemView.itemId], set: { at, householdId: v.householdId } });
  const mine = and(eq(itemView.householdId, v.householdId), eq(itemView.userId, v.userId));
  const kept = (await v.db.select({ itemId: itemView.itemId }).from(itemView).where(mine).orderBy(desc(itemView.at)).limit(KEEP)).map((r) => r.itemId);
  // KEEP is a short fixed list, so a plain NOT IN stays well under D1's bound-parameter limit.
  await v.db.delete(itemView).where(and(mine, notInArray(itemView.itemId, kept)));
}

/** The things this person opened lately in this household, newest first (deleted ones left out; gone ones kept). */
export async function recentlyViewed(v: Caller, limit = 6): Promise<ThingCard[]> {
  if (!v.userId) return [];
  const rows = await v.db
    .select({ item, at: itemView.at })
    .from(itemView)
    .innerJoin(item, eq(item.id, itemView.itemId))
    .where(and(eq(itemView.householdId, v.householdId), eq(itemView.userId, v.userId), itemScope(v, { gone: "include" })))
    .orderBy(desc(itemView.at))
    .limit(limit);
  return thingCards(v, rows);
}

/** Things as the dashboard's photo cards, in the order given (`at`: when each was opened or added). */
export async function thingCards(v: Caller, rows: { item: typeof item.$inferSelect; at: Date }[]): Promise<ThingCard[]> {
  const listed = await asListing(v, rows.map((r) => r.item));
  const collectionIds = [...new Set(listed.flatMap((l) => (l.collectionId ? [l.collectionId] : [])))];
  const collections = new Map(
    (collectionIds.length
      ? await v.db.select({ id: collection.id, name: collection.name }).from(collection).where(and(eq(collection.householdId, v.householdId), inList(collection.id, collectionIds)))
      : []
    ).map((c) => [c.id, c]),
  );
  return listed.map((l, i) => ({
    id: l.id,
    name: l.name,
    photoId: l.photoId,
    place: l.place,
    container: l.container,
    category: l.category,
    disposition: l.disposition,
    brand: l.brand,
    model: l.model,
    graded: l.graded,
    collection: (l.collectionId && collections.get(l.collectionId)) || null,
    worthCents: l.valueCents ?? l.purchasePriceCents,
    at: rows[i]!.at.toISOString(),
  }));
}
