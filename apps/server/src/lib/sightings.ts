/**
 * When a thing was last seen (`item_sighting`), by kind: "scanned" — its QR label opened, or its barcode, label or
 * pairing code scanned in the app to one item (lib/stock.ts `scan`, lib/labels.ts `resolveLabel`); "confirmed" — someone
 * tapped "Still here" (or found it); "reviewed" — checked in a room review (lib/room-reviews.ts). Overwritten each
 * time; not history and not a change to the item (no re-index, no "recently changed", no activity row). Viewers'
 * scans count. Claude's lookup_barcode doesn't: reading out a code isn't seeing the thing.
 *
 * And "Can't find it" (`item.missingSince`): a state, not a disposition — the thing still counts as owned. Seeing it
 * again clears it ("Found …" in its history); giving it up as lost is a disposition (GoneDialog), which clears it too.
 */
import type { ItemListing } from "@ferret/shared";
import type { SightingHow, SightingKind } from "@ferret/shared/utils";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, itemSighting, user } from "../db/schema";
import { type Caller, itemScope, logActivity } from "./inventory";
import { inList } from "./sql";

export async function recordSighting(v: Pick<Caller, "db" | "householdId" | "userId">, itemId: string, kind: SightingKind, how: SightingHow) {
  await recordSightings(v, [itemId], kind, how);
}

/** One sighting each for these items (a box and what's in it). */
export async function recordSightings(v: Pick<Caller, "db" | "householdId" | "userId">, itemIds: string[], kind: SightingKind, how: SightingHow) {
  if (!itemIds.length) return;
  const at = new Date();
  await v.db
    .insert(itemSighting)
    .values(itemIds.map((itemId) => ({ householdId: v.householdId, itemId, kind, at, userId: v.userId || null, how })))
    .onConflictDoUpdate({ target: [itemSighting.itemId, itemSighting.kind], set: { at, userId: v.userId || null, how: sql`excluded.how` } });
}

type Sighting = { itemId: string; at: Date; by: string | null; kind: SightingKind; how: SightingHow };

/** These items' last scans, and when each was last seen at all: when, by whom (their name), which way. */
export async function sightingsOf(v: Pick<Caller, "db" | "householdId">, itemIds: string[]) {
  const rows: Sighting[] = itemIds.length
    ? await v.db
        .select({ itemId: itemSighting.itemId, at: itemSighting.at, by: user.name, kind: itemSighting.kind, how: itemSighting.how })
        .from(itemSighting)
        .leftJoin(user, eq(user.id, itemSighting.userId))
        .where(and(eq(itemSighting.householdId, v.householdId), inList(itemSighting.itemId, itemIds)))
    : [];
  const scanned = new Map<string, NonNullable<ItemListing["lastScanned"]>>();
  const seen = new Map<string, NonNullable<ItemListing["lastSeen"]>>();
  for (const r of rows) {
    const at = r.at.toISOString();
    if (r.kind === "scanned") scanned.set(r.itemId, { at, by: r.by ?? null, how: r.how });
    const was = seen.get(r.itemId);
    if (!was || was.at < at) seen.set(r.itemId, { at, by: r.by ?? null, kind: r.kind, how: r.how });
  }
  return { scanned, seen };
}

/** A thing and, for a box, everything in it (a box confirmed is its contents confirmed). */
async function withContents(v: Caller, itemId: string) {
  const [row] = await v.db.select({ id: item.id, isContainer: item.isContainer, missingSince: item.missingSince, name: item.name }).from(item).where(and(eq(item.id, itemId), itemScope(v)));
  if (!row) throw new HTTPException(404, { message: "Item not found" });
  const inside = row.isContainer ? (await v.db.select({ id: item.id }).from(item).where(and(itemScope(v), eq(item.containerItemId, row.id)))).map((r) => r.id) : [];
  return { row, inside };
}

/**
 * Seen it: "Still here" (`confirmed`) or checked in a room review (`reviewed`). A box takes what's in it along (`box`).
 * Anything that was missing is found again. Returns how many things that was.
 */
export async function markSeen(v: Caller, itemId: string, kind: "confirmed" | "reviewed" = "confirmed") {
  const { row, inside } = await withContents(v, itemId);
  await recordSighting(v, row.id, kind, "app");
  await recordSightings(v, inside, kind, "box");
  await clearMissing(v, [row.id, ...inside]);
  return 1 + inside.length;
}

/** Found again: no longer missing, and a line in each one's history. */
async function clearMissing(v: Caller, itemIds: string[]) {
  const found = await v.db
    .update(item)
    .set({ missingSince: null })
    .where(and(itemScope(v), inList(item.id, itemIds), isNotNull(item.missingSince)))
    .returning({ id: item.id, name: item.name });
  for (const f of found) await logActivity(v, "item.found", f.id, `Found ${f.name}`);
}

/** "Can't find it": missing from now on (until found, or given up as lost). Already missing stays missing since then. */
export async function markMissing(v: Caller, itemId: string) {
  const { row } = await withContents(v, itemId);
  if (row.missingSince) return;
  await v.db.update(item).set({ missingSince: new Date() }).where(and(eq(item.id, row.id), itemScope(v)));
  await logActivity(v, "item.missing", row.id, `Couldn't find ${row.name}`);
}
