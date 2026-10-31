/**
 * Adding a photo or document to an item: sniff the real type, store it
 * encrypted, make a thumbnail, and queue the analysis. Shared by the upload
 * route and the MCP photo tools.
 */
import { type AttachmentKind, uploadTypes } from "@ferret/shared";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item } from "../db/schema";
import type { Db } from "../ports";
import { analysisJob, previewKey } from "../jobs/analyze";
import { PDF_THUMB_JOB } from "../jobs/pdf-thumbnail";
import { isOff } from "./demo-switches";
import type { FileStore } from "./files";
import { type Caller, itemChanged, logActivity } from "./inventory";
import { allow, requireRoom } from "./plan";
import { sniffContentType } from "./sniff";

export const attachmentFields = {
  id: attachment.id,
  householdId: attachment.householdId,
  itemId: attachment.itemId,
  kind: attachment.kind,
  filename: attachment.filename,
  contentType: attachment.contentType,
  size: attachment.size,
  analysisStatus: attachment.analysisStatus,
  analysis: attachment.analysis,
  suggestionsDismissedAt: attachment.suggestionsDismissedAt,
  createdAt: attachment.createdAt,
  hasThumbnail: sql<boolean>`${attachment.thumbnailKey} is not null`.mapWith(Boolean),
  originalRemoved: sql<boolean>`${attachment.originalRemovedAt} is not null`.mapWith(Boolean),
  mainAt: attachment.mainAt,
};

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
      .where(and(eq(attachment.id, id), eq(attachment.householdId, householdId), isNotNull(attachment.thumbnailKey), isNull(attachment.originalRemovedAt)));
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

export async function addAttachment(
  v: Caller,
  files: FileStore,
  itemId: string,
  upload: { bytes: Uint8Array; filename: string; kind: AttachmentKind; made?: MadeCopies; analyze?: boolean },
) {
  const [owner] = await v.db
    .select({ id: item.id, name: item.name })
    .from(item)
    .where(and(eq(item.id, itemId), eq(item.householdId, v.householdId), isNull(item.deletedAt)));
  if (!owner) throw new HTTPException(404, { message: "Item not found" });
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
  const job = analysisJob(v.deps, kind, contentType);
  const analyze = job && upload.analyze !== false && (await allow(v, kind === "photo" ? "ai.photo" : "ai.document")).ok ? job : null;
  const [row] = await v.db
    .insert(attachment)
    .values({
      id,
      householdId: v.householdId,
      itemId: owner.id,
      kind,
      filename: upload.filename.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200) || kind,
      contentType,
      size: bytes.length,
      blobKey,
      thumbnailKey,
      analysisStatus: analyze ? "pending" : null,
      createdBy: v.userId,
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
  await itemChanged(v, owner.id); // its file name is searchable right away
  await logActivity(v, "attachment.create", id, `Added a ${kind} to ${owner.name}`, owner.id);
  return row!;
}
