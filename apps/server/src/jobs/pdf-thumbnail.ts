/**
 * A PDF's thumbnail: its first page, drawn by `deps.pdfPages` (slow, and a hostile PDF could make it slower — so a job,
 * not the upload) and shrunk like a photo's. Also run once at startup for PDFs that came before this (`PDF_BACKFILL_JOB`).
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { attachment } from "../db/schema";
import type { FileStore } from "../lib/files";
import type { Db, Images, JobHandler, Jobs, PdfPages } from "../ports";

export const PDF_THUMB_JOB = "attachment.pdf-thumbnail";
export const PDF_BACKFILL_JOB = "attachment.pdf-thumbnail-backfill";
/** As for photos (lib/attachments.ts). */
const THUMBNAIL_PX = 600;

export function pdfThumbnail(deps: { db: Db; files: FileStore; pdfPages: PdfPages; images: Images }): JobHandler {
  return async (payload) => {
    const { attachmentId } = z.object({ attachmentId: z.string() }).parse(payload);
    const [row] = await deps.db
      .select()
      .from(attachment)
      .where(and(eq(attachment.id, attachmentId), isNull(attachment.deletedAt), isNull(attachment.thumbnailKey)));
    if (!row || row.contentType !== "application/pdf") return;
    const bytes = await deps.files.get(row.householdId, row.blobKey);
    if (!bytes) return;
    // Drawn larger than the thumbnail, then shrunk (and made WebP) like a photo.
    const page = await deps.pdfPages.firstPage(bytes, THUMBNAIL_PX * 2);
    const thumb = page ? await deps.images.resize(page, THUMBNAIL_PX, "webp") : null;
    if (!thumb) return; // damaged, password-protected or too slow: the list keeps its PDF icon
    const thumbnailKey = `${row.blobKey}.thumb`;
    await deps.files.put(row.householdId, thumbnailKey, thumb);
    await deps.db.update(attachment).set({ thumbnailKey }).where(eq(attachment.id, row.id));
  };
}

/** PDFs uploaded before thumbnails (or while drawing them was off): queue one job each. */
export function pdfThumbnailBackfill(deps: { db: Db; jobs: Jobs }): JobHandler {
  return async () => {
    const rows = await deps.db
      .select({ id: attachment.id })
      .from(attachment)
      .where(and(eq(attachment.contentType, "application/pdf"), isNull(attachment.thumbnailKey), isNull(attachment.deletedAt)));
    for (const r of rows) await deps.jobs.enqueue(PDF_THUMB_JOB, { attachmentId: r.id });
  };
}
