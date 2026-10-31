/**
 * Recently deleted: a deleted item is kept (soft delete) for TRASH_DAYS, listed
 * in "Recently deleted" where it can be restored or deleted for good, and then
 * purged. The purge (jobs/purge.ts, daily) also clears everything else that was
 * soft-deleted that long ago — photos and documents (with their encrypted
 * files), warranties, claims, maintenance, providers, categories and places.
 *
 * An item's photos, warranties and maintenance stay with it while it's deleted
 * (they're hidden because it is), so a restore brings them all back.
 */
import { PHOTO_ORDER } from "./photo-order";
import { previewKey } from "../jobs/analyze";
import { requireRoom } from "./plan";
import { addDays, type DeletedItem, TRASH_DAYS } from "@ferret/shared";
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  collection,
  itemTemplate,
  activity,
  attachment,
  category,
  item,
  location,
  maintenanceLog,
  maintenanceTask,
  property,
  provider,
  user,
  warranty,
  warrantyClaim,
} from "../db/schema";
import type { Db, Deps } from "../ports";
import type { FileStore } from "./files";
import { type Caller, itemChanged, logActivity, notFound } from "./inventory";
import { todayFor } from "./household-time";
import { inList } from "./sql";
import { purgeRoomScans } from "./room-scans";

const DAY_MS = 24 * 60 * 60 * 1000;
const deletedItems = (v: Caller) => and(eq(item.householdId, v.householdId), isNotNull(item.deletedAt));

/** This household's deleted items, most recently deleted first. */
export async function listDeleted(v: Caller): Promise<DeletedItem[]> {
  const rows = await v.db
    .select({ id: item.id, name: item.name, brand: item.brand, model: item.model, deletedAt: item.deletedAt })
    .from(item)
    .where(deletedItems(v))
    .orderBy(desc(item.deletedAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [photos, deleters] = await Promise.all([
    v.db
      .select({ itemId: attachment.itemId, id: attachment.id })
      .from(attachment)
      .where(and(inList(attachment.itemId, ids), eq(attachment.kind, "photo"), isNull(attachment.deletedAt)))
      .orderBy(...PHOTO_ORDER),
    v.db
      .select({ entityId: activity.entityId, name: user.name })
      .from(activity)
      .leftJoin(user, eq(user.id, activity.actorId))
      .where(and(eq(activity.householdId, v.householdId), eq(activity.action, "item.delete"), inList(activity.entityId, ids)))
      .orderBy(desc(activity.createdAt)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    model: r.model,
    deletedAt: r.deletedAt!.toISOString(),
    purgesOn: addDays(todayFor(v, r.deletedAt!), TRASH_DAYS),
    deletedBy: deleters.find((d) => d.entityId === r.id)?.name ?? null,
    photoId: photos.find((p) => p.itemId === r.id)?.id ?? null,
  }));
}

/**
 * Brings a deleted item back, with its photos, warranties and maintenance. If its
 * place or box was deleted meanwhile, it comes back without one.
 */
export async function restoreItem(v: Caller, id: string) {
  const [row] = await v.db.select().from(item).where(and(eq(item.id, id), deletedItems(v)));
  if (!row) throw notFound("Deleted item");
  await requireRoom(v, { items: 1 }); // back among the things a plan counts (lib/plan.ts)
  const [place] = row.locationId
    ? await v.db.select({ id: location.id }).from(location).where(and(eq(location.id, row.locationId), isNull(location.deletedAt)))
    : [];
  const [box] = row.containerItemId
    ? await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, row.containerItemId), isNull(item.deletedAt)))
    : [];
  await v.db
    .update(item)
    .set({ deletedAt: null, locationId: place?.id ?? null, containerItemId: box?.id ?? null })
    .where(eq(item.id, id));
  await itemChanged(v, id);
  if (box) await itemChanged(v, box.id);
  await logActivity(v, "item.restore", id, `Restored ${row.name}`);
  return { id, name: row.name };
}

/** Deletes a deleted item for good, now rather than when its 30 days are up. */
export async function deleteItemForGood(v: Caller, files: FileStore, id: string) {
  const [row] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, id), deletedItems(v)));
  if (!row) throw notFound("Deleted item");
  await purgeItems({ db: v.db, deps: v.deps, files }, [id]);
  await logActivity(v, "item.purge", id, `Deleted ${row.name} for good`);
}

type Purger = { db: Db; deps: Pick<Deps, "vectors">; files: FileStore };

/** The encrypted files of these attachments (originals, thumbnails, and a vision copy never analysed). */
async function deleteFiles(p: Purger, rows: { blobKey: string; thumbnailKey: string | null }[]) {
  for (const r of rows) {
    await p.files.delete(r.blobKey);
    if (r.thumbnailKey) await p.files.delete(r.thumbnailKey);
    await p.files.delete(previewKey(r.blobKey)).catch(() => {});
  }
}

/** Removes items for good: their files, search entries and rows (photos, warranties… go with them). */
async function purgeItems(p: Purger, ids: string[]) {
  if (!ids.length) return;
  await deleteFiles(
    p,
    await p.db.select({ blobKey: attachment.blobKey, thumbnailKey: attachment.thumbnailKey }).from(attachment).where(inList(attachment.itemId, ids)),
  );
  for (const id of ids) {
    await p.db.run(sql`DELETE FROM item_search WHERE item_id = ${id}`);
    await p.db.run(sql`DELETE FROM item_search_trigram WHERE item_id = ${id}`);
    await p.deps.vectors?.deleteWhere({ itemId: id });
  }
  await p.db.delete(item).where(inList(item.id, ids));
}

/**
 * Removes for good everything deleted more than TRASH_DAYS ago, in every household.
 * Returns how many of each went, for the log.
 */
export async function purgeDeleted(p: Purger, now = Date.now()) {
  const cutoff = new Date(now - TRASH_DAYS * DAY_MS);
  const old = (t: { deletedAt: AnySQLiteColumn }) => and(isNotNull(t.deletedAt), lt(t.deletedAt, cutoff));

  const items = (await p.db.select({ id: item.id }).from(item).where(old(item))).map((r) => r.id);
  await purgeItems(p, items);

  // Photos and documents removed from items that are still here.
  const files = await p.db
    .select({ id: attachment.id, blobKey: attachment.blobKey, thumbnailKey: attachment.thumbnailKey })
    .from(attachment)
    .where(old(attachment));
  await deleteFiles(p, files);
  if (files.length) await p.db.delete(attachment).where(inList(attachment.id, files.map((f) => f.id)));

  // Past maintenance can still name a removed provider, and those columns predate ON DELETE SET NULL (migration 0012):
  // clear them first, or SQLite refuses the delete — and the rest of the purge with it.
  const goneProviders = (await p.db.select({ id: provider.id }).from(provider).where(old(provider))).map((r) => r.id);
  if (goneProviders.length) {
    await p.db.update(maintenanceLog).set({ providerId: null }).where(inList(maintenanceLog.providerId, goneProviders));
    await p.db.update(maintenanceTask).set({ providerId: null }).where(inList(maintenanceTask.providerId, goneProviders));
  }

  // Dismissed room scans: their photos, then the rows (items found in them keep their place, just not the link).
  const roomScans = await purgeRoomScans(p, cutoff);

  // The rest: rows only (foreign keys clear what pointed at them).
  const counts: Record<string, number> = { items: items.length, files: files.length, "room scans": roomScans };
  for (const [name, table] of [
    ["claims", warrantyClaim],
    ["warranties", warranty],
    ["maintenance", maintenanceTask],
    ["providers", provider],
    ["collections", collection],
    ["templates", itemTemplate],
    ["categories", category],
    ["places", location],
    ["properties", property],
  ] as const) {
    const gone = await p.db.delete(table).where(old(table)).returning({ id: table.id });
    counts[name] = gone.length;
  }
  return counts;
}
