/**
 * "Add from a web address": someone gives the address of a photo or a PDF and
 * the server downloads it into the item like an upload (sniffed, encrypted,
 * thumbnailed, read by the models). The download runs in a job — the request
 * only records it — through deps.downloader, which only reaches the public
 * internet (adapters/local/download.ts).
 */
import { type DownloadInput, type PendingDownload, uploadTypes } from "@ferret/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, pendingDownload } from "../db/schema";
import { DownloadError, type JobHandler } from "../ports";
import { addAttachment } from "./attachments";
import type { FileStore } from "./files";
import { type Caller, notFound } from "./inventory";
import { sniffContentType } from "./sniff";
import { householdTimeZone } from "./household-time";

export const DOWNLOAD_JOB = "attachment.download";

const summary = (r: typeof pendingDownload.$inferSelect): PendingDownload => ({
  id: r.id,
  url: r.url,
  status: r.status,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
});

export async function requestDownload(v: Caller, itemId: string, input: DownloadInput) {
  if (!v.deps.downloader || !v.deps.jobs) throw new HTTPException(409, { message: "Downloading from the web isn't available on this server" });
  const [owner] = await v.db
    .select({ id: item.id })
    .from(item)
    .where(and(eq(item.id, itemId), eq(item.householdId, v.householdId), isNull(item.deletedAt)));
  if (!owner) throw notFound("Item");
  const [row] = await v.db
    .insert(pendingDownload)
    .values({ householdId: v.householdId, itemId, url: input.url, kind: input.kind ?? null, createdBy: v.userId })
    .returning();
  await v.deps.jobs.enqueue(DOWNLOAD_JOB, { id: row!.id });
  return summary(row!);
}

export async function listDownloads(v: Caller, itemId: string) {
  const rows = await v.db
    .select()
    .from(pendingDownload)
    .where(and(eq(pendingDownload.itemId, itemId), eq(pendingDownload.householdId, v.householdId)))
    .orderBy(asc(pendingDownload.createdAt));
  return rows.map(summary);
}

export async function dismissDownload(v: Caller, id: string) {
  const gone = await v.db
    .delete(pendingDownload)
    .where(and(eq(pendingDownload.id, id), eq(pendingDownload.householdId, v.householdId)))
    .returning({ id: pendingDownload.id });
  if (!gone.length) throw notFound("Download");
}

/** The job: download, then add it to the item as its uploader would have. A failure is kept, with why. */
export function downloadJob(deps: Caller["deps"] & { files: FileStore; maxBytes: number }): JobHandler {
  return async (payload) => {
    const { db, downloader } = deps;
    const [row] = await db.select().from(pendingDownload).where(eq(pendingDownload.id, (payload as { id: string }).id));
    if (!row || row.status !== "pending" || !downloader) return;
    const fail = (error: string) => db.update(pendingDownload).set({ status: "failed", error }).where(eq(pendingDownload.id, row.id));
    if (!row.createdBy) return await fail("Whoever asked for it no longer has an account");
    try {
      // Only photos and PDFs: anything else is refused by its declared type or its first bytes, never fully fetched.
      const wanted = row.kind ? uploadTypes[row.kind] : [...new Set([...uploadTypes.photo, ...uploadTypes.document])];
      const got = await downloader.get(row.url, {
        maxBytes: deps.maxBytes,
        contentTypes: wanted,
        accepts: (head) => {
          const sniffed = sniffContentType(head);
          return Boolean(sniffed && wanted.includes(sniffed));
        },
      });
      const type = sniffContentType(got.bytes);
      const kind = row.kind ?? (type && uploadTypes.photo.includes(type) ? "photo" : "document");
      if (!type || !uploadTypes[kind].includes(type)) {
        return await fail(kind === "photo" ? "That isn't a photo Ferret can keep (JPEG, PNG, WebP…)" : "That isn't a photo or a PDF — it may be a web page rather than the file itself");
      }
      const caller = { deps, db, householdId: row.householdId, userId: row.createdBy, timeZone: await householdTimeZone(db, row.householdId), via: "web" as const };
      await addAttachment(caller, deps.files, row.itemId, {
        bytes: got.bytes,
        filename: got.filename ?? new URL(got.finalUrl).hostname,
        kind,
      });
      await db.delete(pendingDownload).where(eq(pendingDownload.id, row.id));
    } catch (err) {
      if (err instanceof DownloadError || err instanceof HTTPException) return await fail(err.message);
      throw err; // something of ours: retried
    }
  };
}
