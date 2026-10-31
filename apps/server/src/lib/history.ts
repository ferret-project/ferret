/**
 * An item's history: everything the activity log says about it — added, each edit in words (lib/inventory.ts
 * describeChanges), moves, photos and documents, warranties and claims, maintenance done, stock used and added, pairing
 * codes shown — newest first. Rows carry `activity.item_id`; there's no FK, so a thing's history outlives it.
 */
import type { ItemHistoryEntry } from "@ferret/shared";
import { and, desc, eq } from "drizzle-orm";
import { activity, item, user } from "../db/schema";
import { type Caller, itemScope, notFound } from "./inventory";

export async function itemHistory(v: Caller, itemId: string, page: { limit: number; offset: number }) {
  const [found] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!found) throw notFound("Item");
  const rows = await v.db
    .select({ a: activity, by: user.name })
    .from(activity)
    .leftJoin(user, eq(user.id, activity.actorId))
    .where(and(eq(activity.householdId, v.householdId), eq(activity.itemId, itemId)))
    .orderBy(desc(activity.createdAt))
    .limit(page.limit + 1)
    .offset(page.offset);
  const data: ItemHistoryEntry[] = rows.slice(0, page.limit).map(({ a, by }) => ({
    id: a.id,
    at: a.createdAt.toISOString(),
    action: a.action,
    summary: a.summary ?? a.action,
    by,
    via: a.via as ItemHistoryEntry["via"],
  }));
  return { data, more: rows.length > page.limit };
}
