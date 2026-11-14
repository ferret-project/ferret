/**
 * Adding a photo or document to an item: sniff the real type, store it
 * encrypted, make a thumbnail, and queue the analysis. Shared by the upload
 * route and the MCP photo tools.
 */
import { type AttachmentKind, type FileHit, type FileOwnerQuery, uploadTypes } from "@ferret/shared";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item, location, maintenanceLog, maintenanceTask, property } from "../db/schema";
import type { Db } from "../ports";
import { analysisJob, previewKey } from "../jobs/analyze";
import { PDF_THUMB_JOB } from "../jobs/pdf-thumbnail";
import { isOff } from "./demo-switches";
import type { FileStore } from "./files";
import { type Caller, itemChanged, logActivity } from "./inventory";
import { allow, requireAllowed, requireRoom } from "./plan";
import { PHOTO_ORDER } from "./photo-order";
import { sniffContentType } from "./sniff";
import { inList } from "./sql";
import { fileTextSearch, refreshFileSearch } from "./fulltext";

export const attachmentFields = {
  id: attachment.id,
  householdId: attachment.householdId,
  itemId: attachment.itemId,
  propertyId: attachment.propertyId,
  locationId: attachment.locationId,
  taskId: attachment.taskId,
  doneId: attachment.doneId,
  kind: attachment.kind,
  filename: attachment.filename,
  contentType: attachment.contentType,
  size: attachment.size,
  analysisStatus: attachment.analysisStatus,
  analysis: attachment.analysis,
  suggestionsDismissedAt: attachment.suggestionsDismissedAt,
  createdAt: attachment.createdAt,
  hasThumbnail: sql<boolean>`coalesce(${attachment.thumbnailKey}, '') <> ''`.mapWith(Boolean),
  originalRemoved: sql<boolean>`${attachment.originalRemovedAt} is not null`.mapWith(Boolean),
  mainAt: attachment.mainAt,
  repairId: attachment.repairId,
};

/**
 * Asks the model to read a photo or document again (after a failure, a better model, or never read at all): checks it
 * can be (not only the small copy kept, analysis set up for its kind, the plan's AI allowance) and queues it.
 */
export async function analyzeAgain(v: Caller, attachmentId: string) {
  const where = and(eq(attachment.id, attachmentId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt));
  const [found] = await v.db
    .select({ kind: attachment.kind, contentType: attachment.contentType, originalRemovedAt: attachment.originalRemovedAt, itemId: attachment.itemId })
    .from(attachment)
    .where(where);
  if (!found) throw new HTTPException(404, { message: "Attachment not found" });
  if (found.originalRemovedAt) throw new HTTPException(409, { message: "Only a small copy of this is kept, so it can't be read again" });
  const job = analysisJob(v.deps, found.kind as AttachmentKind, found.contentType);
  if (!job) throw new HTTPException(409, { message: "Analysis for this kind of file isn't set up on this server" });
  await requireAllowed(v, found.kind === "photo" ? "ai.photo" : "ai.document");
  const [row] = await v.db.update(attachment).set({ analysisStatus: "pending", suggestionsDismissedAt: null }).where(where).returning(attachmentFields);
  await v.deps.jobs!.enqueue(job, { attachmentId: row!.id });
  return row!;
}

/**
 * Queues every photo and document of an item that hasn't been read — never asked (added before AI was set up, or while
 * the plan had none left) or failed — leaving alone what's read or being read, and files only kept as a small copy.
 * Bulk "Analyze" (Everything's bar). Returns how many were queued; a 402 (allowance used up) stops it there.
 */
export async function analyzeUnread(v: Caller, itemId: string) {
  const [found] = await v.db
    .select({ id: item.id })
    .from(item)
    .where(and(eq(item.id, itemId), eq(item.householdId, v.householdId), isNull(item.deletedAt)));
  if (!found) throw new HTTPException(404, { message: "Item not found" });
  const unread = await v.db
    .select({ id: attachment.id, kind: attachment.kind, contentType: attachment.contentType })
    .from(attachment)
    .where(
      and(
        eq(attachment.itemId, itemId),
        eq(attachment.householdId, v.householdId),
        isNull(attachment.deletedAt),
        isNull(attachment.originalRemovedAt),
        sql`coalesce(${attachment.analysisStatus}, 'failed') = 'failed'`,
      ),
    );
  let queued = 0;
  for (const a of unread) {
    if (!analysisJob(v.deps, a.kind as AttachmentKind, a.contentType)) continue; // e.g. a document with no reader here
    await analyzeAgain(v, a.id);
    queued++;
  }
  return queued;
}

/**
 * The files of a property, a place, a maintenance task (its own, and its done records' — a thing's task keeps those on
 * the thing) or one done record: photos first as everywhere (PHOTO_ORDER), then documents in the order added.
 */
export async function listFiles(v: Caller, of: FileOwnerQuery) {
  const mine = and(eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt));
  let which;
  if (of.propertyId) which = eq(attachment.propertyId, of.propertyId);
  else if (of.locationId) which = eq(attachment.locationId, of.locationId);
  else if (of.doneId) which = eq(attachment.doneId, of.doneId);
  else {
    const logs = await v.db.select({ id: maintenanceLog.id }).from(maintenanceLog).where(and(eq(maintenanceLog.householdId, v.householdId), eq(maintenanceLog.taskId, of.taskId!)));
    which = or(eq(attachment.taskId, of.taskId!), logs.length ? inList(attachment.doneId, logs.map((l) => l.id)) : undefined);
  }
  return v.db.select(attachmentFields).from(attachment).where(and(mine, which)).orderBy(...PHOTO_ORDER);
}

/** Removes a photo or document (to the purge's 30 days; the encrypted file stays until then). */
export async function removeFile(v: Caller, attachmentId: string) {
  const [row] = await v.db
    .update(attachment)
    .set({ deletedAt: new Date() })
    .where(and(eq(attachment.id, attachmentId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)))
    .returning({ id: attachment.id, kind: attachment.kind, filename: attachment.filename, itemId: attachment.itemId });
  if (!row) throw new HTTPException(404, { message: "Attachment not found" });
  await logActivity(v, "attachment.delete", row.id, `Removed a ${row.kind}`, row.itemId);
  if (row.itemId) await itemChanged(v, row.itemId);
  else await refreshFileSearch(v.db, row.id);
  return { id: row.id, name: row.filename };
}

/**
 * Files of properties, places and maintenance tasks matching words (their names, and what was read in them), each with
 * what it belongs to — for search, beside the things found. A thing's files are found with the thing.
 */
export async function searchFiles(v: Caller, query: string, limit = 10) {
  const hits = await fileTextSearch(v.db, v.householdId, query, limit);
  if (!hits.length) return [];
  const rows = await v.db
    .select({ file: attachmentFields, propertyName: property.name, locationName: location.name, taskTitle: maintenanceTask.title })
    .from(attachment)
    .leftJoin(property, eq(property.id, attachment.propertyId))
    .leftJoin(location, eq(location.id, attachment.locationId))
    .leftJoin(maintenanceTask, eq(maintenanceTask.id, attachment.taskId))
    .where(and(eq(attachment.householdId, v.householdId), inList(attachment.id, hits.map((h) => h.attachmentId)), isNull(attachment.deletedAt)));
  const byId = new Map(rows.map((r) => [r.file.id, r]));
  return hits.flatMap((h) => {
    const r = byId.get(h.attachmentId);
    if (!r) return [];
    const of: FileHit["of"] = r.file.propertyId
      ? { kind: "property", id: r.file.propertyId, name: r.propertyName ?? "" }
      : r.file.locationId
        ? { kind: "place", id: r.file.locationId, name: r.locationName ?? "" }
        : { kind: "task", id: r.file.taskId!, name: r.taskTitle ?? "" };
    return [{ ...r.file, of, snippet: h.snippet ?? null }];
  });
}

/**
 * Removes the files of a property, places or a maintenance task being removed (to Recently deleted's 30 days with
 * them: the purge then deletes the encrypted files before their owner — lib/trash.ts).
 */
export async function removeFilesOf(v: Caller, owner: { propertyId: string } | { locationIds: string[] } | { taskId: string }, at: Date) {
  const which =
    "propertyId" in owner ? eq(attachment.propertyId, owner.propertyId) : "taskId" in owner ? eq(attachment.taskId, owner.taskId) : inList(attachment.locationId, owner.locationIds);
  await v.db.update(attachment).set({ deletedAt: at }).where(and(eq(attachment.householdId, v.householdId), which, isNull(attachment.deletedAt)));
}

/** Makes a photo its item's main photo — its picture in lists, first on its page. */
export async function setMainPhoto(v: Caller, attachmentId: string) {
  const [row] = await v.db
    .select({ id: attachment.id, itemId: attachment.itemId, filename: attachment.filename, name: item.name })
    .from(attachment)
    .innerJoin(item, eq(item.id, attachment.itemId))
    .where(and(eq(attachment.id, attachmentId), eq(attachment.householdId, v.householdId), eq(attachment.kind, "photo"), isNull(attachment.deletedAt)));
  if (!row) throw new HTTPException(404, { message: "Photo not found" });
  await v.db.update(attachment).set({ mainAt: new Date() }).where(eq(attachment.id, row.id));
  await logActivity(v, "attachment.main", row.id, `Made ${row.filename} the main photo of ${row.name}`, row.itemId);
  return { id: row.id, itemId: row.itemId };
}

/**
 * Frees space by removing originals and keeping their thumbnails: the thing still shows its picture, Download
 * everything has the small copy, and it stops counting towards the household's files. Only attachments that have a
 * thumbnail (never one that would vanish altogether). Returns the bytes freed.
 */
export async function removeOriginals(deps: { db: Db; files: FileStore }, householdId: string, attachmentIds: string[]) {
  let freed = 0;
  for (const id of attachmentIds) {
    const [row] = await deps.db
      .select({ blobKey: attachment.blobKey, size: attachment.size })
      .from(attachment)
      .where(and(eq(attachment.id, id), eq(attachment.householdId, householdId), isNotNull(attachment.thumbnailKey), ne(attachment.thumbnailKey, ""), isNull(attachment.originalRemovedAt)));
    if (!row) continue;
    // The row first: if deleting the file then fails, it's an orphan blob, never a row pointing at nothing.
    await deps.db.update(attachment).set({ originalRemovedAt: new Date() }).where(eq(attachment.id, id));
    await deps.files.delete(row.blobKey);
    freed += row.size;
  }
  return freed;
}

/** Longest side of a thumbnail, in px: crisp on a 3× phone screen, even for the 2×2 cover tile. */
export const THUMBNAIL_PX = 600;

/**
 * Copies of a photo the browser made before uploading (the web app does; the API and MCP don't): its thumbnail, and
 * the smaller copy the vision model looks at (`VISION_PX`). Made there, the server doesn't have to.
 * Only believed if they really are small images; otherwise made here as before.
 */
export interface MadeCopies {
  thumbnail?: Uint8Array;
  preview?: Uint8Array;
}
const COPY_TYPES = ["image/webp", "image/jpeg", "image/png"];
const usable = (bytes: Uint8Array | undefined, maxBytes: number) =>
  bytes && bytes.length > 0 && bytes.length <= maxBytes && COPY_TYPES.includes(sniffContentType(bytes) ?? "") ? bytes : undefined;

/**
 * What a file is added to: a thing (an id alone means one), a property, a place, a maintenance task, or a done record —
 * whose files belong to its task's thing (or the house-wide task) and are shown with the record too, like a repair's.
 */
export type FileOwner = string | { itemId: string } | { propertyId: string } | { locationId: string } | { taskId: string } | { doneId: string };

/** Who a new file belongs to, checked to be this household's: its owner columns, a name for the history, its thing. */
async function resolveOwner(v: Caller, owner: FileOwner) {
  const o = typeof owner === "string" ? { itemId: owner } : owner;
  const mine = <T>(rows: T[], what: string) => {
    if (!rows[0]) throw new HTTPException(404, { message: `${what} not found` });
    return rows[0];
  };
  if ("itemId" in o) {
    const it = mine(await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, o.itemId), eq(item.householdId, v.householdId), isNull(item.deletedAt))), "Item");
    return { columns: { itemId: it.id }, name: it.name, itemId: it.id as string | null };
  }
  if ("propertyId" in o) {
    const p = mine(await v.db.select({ id: property.id, name: property.name }).from(property).where(and(eq(property.id, o.propertyId), eq(property.householdId, v.householdId), isNull(property.deletedAt))), "Property");
    return { columns: { propertyId: p.id }, name: p.name, itemId: null };
  }
  if ("locationId" in o) {
    const l = mine(await v.db.select({ id: location.id, name: location.name }).from(location).where(and(eq(location.id, o.locationId), eq(location.householdId, v.householdId), isNull(location.deletedAt))), "Location");
    return { columns: { locationId: l.id }, name: l.name, itemId: null };
  }
  const task = async (taskId: string) =>
    mine(
      await v.db
        .select({ id: maintenanceTask.id, title: maintenanceTask.title, itemId: maintenanceTask.itemId, itemName: item.name })
        .from(maintenanceTask)
        .leftJoin(item, and(eq(item.id, maintenanceTask.itemId), isNull(item.deletedAt)))
        .where(and(eq(maintenanceTask.id, taskId), eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt))),
      "Task",
    );
  let doneId: string | null = null;
  let taskId: string;
  if ("doneId" in o) {
    const done = mine(await v.db.select({ id: maintenanceLog.id, taskId: maintenanceLog.taskId }).from(maintenanceLog).where(and(eq(maintenanceLog.id, o.doneId), eq(maintenanceLog.householdId, v.householdId))), "Done record");
    doneId = done.id;
    taskId = done.taskId;
  } else taskId = o.taskId;
  const t = await task(taskId);
  // A thing's task keeps its files with the thing (its page shows them); a house-wide one keeps its own.
  if (t.itemId && t.itemName) return { columns: { itemId: t.itemId, doneId }, name: t.itemName, itemId: t.itemId as string | null };
  if (t.itemId) throw new HTTPException(404, { message: "Item not found" });
  return { columns: { taskId: t.id, doneId }, name: t.title, itemId: null };
}

export async function addAttachment(
  v: Caller,
  files: FileStore,
  to: FileOwner,
  upload: { bytes: Uint8Array; filename: string; kind: AttachmentKind; made?: MadeCopies; analyze?: boolean; repairId?: string | null },
) {
  const owner = await resolveOwner(v, to);
  // The public demo's admin can stop uploads (lib/demo-switches.ts); never set on a home Ferret.
  if (await isOff(v.db, "uploads")) throw new HTTPException(503, { message: "Adding photos and files is paused in the demo for now." });

  const { bytes, kind } = upload;
  const contentType = sniffContentType(bytes);
  if (!contentType || !uploadTypes[kind].includes(contentType)) {
    throw new HTTPException(415, { message: `Unsupported file type for a ${kind}` });
  }
  await requireRoom(v, { bytes: bytes.length }); // a plan's room for files (lib/plan.ts)

  const id = crypto.randomUUID();
  const blobKey = `${v.householdId}/${id}`;
  await files.put(v.householdId, blobKey, bytes);
  // A thumbnail is a nice-to-have: if it can't be made, the grid shows the original. A PDF's is its first page: drawn
  // in the background (below), unless it came with one (the demo's receipts — lib/demo.ts).
  const isImage = contentType.startsWith("image/");
  const isPdf = contentType === "application/pdf";
  const made = usable(upload.made?.thumbnail, 400_000);
  const thumb = isImage ? (made ?? (await v.deps.images?.resize(bytes, THUMBNAIL_PX, "webp"))) : isPdf ? made : null;
  const thumbnailKey = thumb ? `${blobKey}.thumb` : null;
  if (thumb && thumbnailKey) await files.put(v.householdId, thumbnailKey, thumb);
  // Photos (vision model) and documents (docling) are analysed in the background (see jobs/analyze.ts) — when the
  // household's plan has AI and some left (lib/plan.ts; counted by the job, once it's done). Without, it's just kept.
  // A property's, a place's or a task's are read for their words only (to find them by): no suggestions, nothing to
  // put them on — jobs/analyze.ts.
  const job = analysisJob(v.deps, kind, contentType);
  const analyze = job && upload.analyze !== false && (await allow(v, kind === "photo" ? "ai.photo" : "ai.document")).ok ? job : null;
  const [row] = await v.db
    .insert(attachment)
    .values({
      id,
      householdId: v.householdId,
      ...owner.columns,
      kind,
      filename: upload.filename.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200) || kind,
      contentType,
      size: bytes.length,
      blobKey,
      thumbnailKey,
      analysisStatus: analyze ? "pending" : null,
      createdBy: v.userId,
      repairId: upload.repairId ?? null,
    })
    .returning(attachmentFields)
    .catch(async (err) => {
      // Don't leave orphaned blobs behind.
      await files.delete(blobKey);
      if (thumbnailKey) await files.delete(thumbnailKey);
      throw err;
    });
  // The browser's vision copy, kept (encrypted) until the analysis has used it.
  const preview = analyze && isImage ? usable(upload.made?.preview, 2_000_000) : undefined;
  if (preview) await files.put(v.householdId, previewKey(blobKey), preview);
  if (analyze) await v.deps.jobs!.enqueue(analyze, { attachmentId: id });
  // A PDF's thumbnail is its first page, drawn in the background.
  if (isPdf && !thumb && v.deps.pdfPages && v.deps.jobs) await v.deps.jobs.enqueue(PDF_THUMB_JOB, { attachmentId: id });
  // Its file name is searchable right away.
  if (owner.itemId) await itemChanged(v, owner.itemId);
  else await refreshFileSearch(v.db, id);
  await logActivity(v, "attachment.create", id, `Added a ${kind} to ${owner.name}`, owner.itemId);
  return row!;
}
