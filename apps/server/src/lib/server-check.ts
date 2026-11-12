/**
 * Server check (Settings → Server, the server admin; run on demand): is the live server in order? Backups check their
 * own copy; this looks at what's running now —
 * - files the database expects that aren't in the store (originals and thumbnails), and a sample that won't decrypt
 *   with their household's key;
 * - rows pointing at something deleted or in another household (a thing in a deleted room or box, a category gone,
 *   a room under a deleted room, a property's rooms in another household);
 * - work that never finished: jobs that failed for good or have been running for over an hour, imports sorted by AI
 *   and web-address downloads stuck for a day, room scans that never ended (failed jobs: the last week only — the
 *   daily purge removes them after 30 days);
 * - backups: the last run failed, or the last good one is over two days old.
 * Read-only: it changes nothing, and names households and things only to the server admin.
 */
import { and, count, eq, gte, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { member, organization } from "../db/schema/auth";
import { aiRun, attachment, backupRun, category, item, job, location, pendingDownload, roomScan } from "../db/schema";
import type { Blobs, Db } from "../ports";
import type { FileStore } from "./files";

export type CheckFinding = {
  /** A stable name for the kind of problem. */
  kind: string;
  /** "problem": something's wrong; "note": worth a look. */
  level: "problem" | "note";
  count: number;
  /** What it is, in a sentence. */
  text: string;
  /** A few of them: "Household › Item › file.jpg". */
  examples: string[];
};
export type ServerCheckResult = {
  at: string;
  ms: number;
  files: { total: number; checked: number; missing: number; decrypted: number; unreadable: number };
  findings: CheckFinding[];
};

/** Most files whose presence is checked in one run (each is a store lookup). */
export const MAX_FILE_CHECKS = 20_000;
/** How many present files are also decrypted, chosen at random. */
const DECRYPT_SAMPLE = 12;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EXAMPLES = 5;
const day = (d: Date) => d.toISOString().slice(0, 10);

type Deps = { db: Db; blobs: Blobs; files: FileStore; now?: Date };

async function exists(blobs: Blobs, key: string) {
  const blob = await blobs.get(key);
  if (!blob) return false;
  await blob.body.cancel().catch(() => {});
  return true;
}

/** Runs `fn` over `xs`, `n` at a time. */
async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (i < xs.length) await fn(xs[i++]!);
  }));
}

export async function runServerCheck({ db, blobs, files, now = new Date() }: Deps): Promise<ServerCheckResult> {
  const started = Date.now();
  const findings: CheckFinding[] = [];
  const households = new Map((await db.select({ id: organization.id, name: organization.name }).from(organization)).map((h) => [h.id, h.name]));
  const where = (householdId: string, ...rest: (string | null | undefined)[]) => [households.get(householdId) ?? "?", ...rest.filter(Boolean)].join(" › ");
  const add = (f: Omit<CheckFinding, "examples" | "count"> & { rows: string[] }) => {
    if (f.rows.length) findings.push({ kind: f.kind, level: f.level, text: f.text, count: f.rows.length, examples: f.rows.slice(0, EXAMPLES) });
  };

  // ── Files ───────────────────────────────────────────────────────────────
  const rows = await db
    .select({
      id: attachment.id,
      householdId: attachment.householdId,
      blobKey: attachment.blobKey,
      thumbnailKey: attachment.thumbnailKey,
      removed: attachment.originalRemovedAt,
      filename: attachment.filename,
      itemName: item.name,
    })
    .from(attachment)
    .leftJoin(item, eq(item.id, attachment.itemId));
  const keys = rows.flatMap((r) => [
    ...(r.removed ? [] : [{ r, key: r.blobKey, what: "original" as const }]),
    ...(r.thumbnailKey ? [{ r, key: r.thumbnailKey, what: "thumbnail" as const }] : []),
  ]);
  const toCheck = keys.slice(0, MAX_FILE_CHECKS);
  const missing: string[] = [];
  const missingThumbs: string[] = [];
  const present: typeof toCheck = [];
  await pool(toCheck, 8, async (k) => {
    if (await exists(blobs, k.key)) present.push(k);
    else (k.what === "original" ? missing : missingThumbs).push(where(k.r.householdId, k.r.itemName, k.r.filename));
  });
  add({ kind: "files.missing", level: "problem", rows: missing, text: "Files the database lists that aren't in the file store — their photos or documents can't be opened." });
  add({ kind: "thumbnails.missing", level: "note", rows: missingThumbs, text: "Small pictures (thumbnails) missing from the file store — the thing shows no picture in lists." });
  const sample = present.filter((k) => k.what === "original").sort(() => Math.random() - 0.5).slice(0, DECRYPT_SAMPLE);
  const unreadable: string[] = [];
  for (const k of sample) {
    try {
      await files.get(k.r.householdId, k.key);
    } catch {
      unreadable.push(where(k.r.householdId, k.r.itemName, k.r.filename));
    }
  }
  add({ kind: "files.unreadable", level: "problem", rows: unreadable, text: `Files that won't decrypt with their household's key (a sample of ${sample.length} was tried) — damaged, or written with another FILES_KEY.` });
  if (keys.length > toCheck.length) {
    findings.push({ kind: "files.partial", level: "note", count: keys.length - toCheck.length, text: `Only the first ${MAX_FILE_CHECKS.toLocaleString("en-US")} files were looked for.`, examples: [] });
  }

  // ── Rows pointing at nothing ─────────────────────────────────────────────
  const box = alias(item, "box");
  const parent = alias(location, "parent");
  const live = isNull(item.deletedAt);
  const inDeletedRoom = await db
    .select({ householdId: item.householdId, name: item.name, room: location.name, other: ne(location.householdId, item.householdId) })
    .from(item)
    .innerJoin(location, eq(location.id, item.locationId))
    .where(and(live, or(isNotNull(location.deletedAt), ne(location.householdId, item.householdId))));
  add({
    kind: "items.room",
    level: "problem",
    rows: inDeletedRoom.map((r) => where(r.householdId, r.name, `${r.room}${r.other ? " (another household)" : " (deleted)"}`)),
    text: "Things in a room that's been deleted or belongs to another household — they don't show under any room.",
  });
  const inDeletedBox = await db
    .select({ householdId: item.householdId, name: item.name, box: box.name, other: ne(box.householdId, item.householdId) })
    .from(item)
    .innerJoin(box, eq(box.id, item.containerItemId))
    .where(and(live, or(isNotNull(box.deletedAt), ne(box.householdId, item.householdId))));
  add({
    kind: "items.box",
    level: "problem",
    rows: inDeletedBox.map((r) => where(r.householdId, r.name, `${r.box}${r.other ? " (another household)" : " (deleted)"}`)),
    text: "Things in a box that's been deleted or belongs to another household.",
  });
  const deletedCategory = await db
    .select({ householdId: item.householdId, name: item.name, category: category.name })
    .from(item)
    .innerJoin(category, eq(category.id, item.categoryId))
    .where(and(live, or(isNotNull(category.deletedAt), ne(category.householdId, item.householdId))));
  add({ kind: "items.category", level: "note", rows: deletedCategory.map((r) => where(r.householdId, r.name, r.category)), text: "Things whose category was deleted (or is another household's) — they count as having none." });
  const orphanRooms = await db
    .select({ householdId: location.householdId, name: location.name, parent: parent.name })
    .from(location)
    .innerJoin(parent, eq(parent.id, location.parentId))
    .where(and(isNull(location.deletedAt), or(isNotNull(parent.deletedAt), ne(parent.householdId, location.householdId))));
  add({ kind: "locations.parent", level: "problem", rows: orphanRooms.map((r) => where(r.householdId, r.parent, r.name)), text: "Places inside a place that's been deleted — they can't be reached in Places." });
  const homeless = await db
    .select({ householdId: attachment.householdId, filename: attachment.filename })
    .from(attachment)
    .leftJoin(item, eq(item.id, attachment.itemId))
    .where(and(isNull(attachment.deletedAt), or(isNull(item.id), ne(item.householdId, attachment.householdId))));
  add({ kind: "attachments.item", level: "problem", rows: homeless.map((r) => where(r.householdId, r.filename)), text: "Photos or documents whose thing is missing or in another household." });
  const noHousehold = await db
    .select({ name: item.name, householdId: item.householdId })
    .from(item)
    .leftJoin(organization, eq(organization.id, item.householdId))
    .where(isNull(organization.id))
    .limit(1000);
  add({ kind: "items.household", level: "problem", rows: noHousehold.map((r) => `${r.householdId} › ${r.name}`), text: "Things belonging to a household that no longer exists." });
  const emptyHouseholds = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .leftJoin(member, eq(member.organizationId, organization.id))
    .where(isNull(member.id));
  add({ kind: "households.members", level: "note", rows: emptyHouseholds.map((h) => h.name), text: "Households nobody is a member of — nobody can open them." });

  // ── Work that never finished ────────────────────────────────────────────
  const failedJobs = await db
    .select({ type: job.type, n: count() })
    .from(job)
    .where(and(eq(job.status, "failed"), gte(job.runAt, new Date(now.getTime() - 7 * DAY))))
    .groupBy(job.type);
  add({ kind: "jobs.failed", level: "note", rows: failedJobs.map((j) => `${j.type}: ${j.n}`), text: "Background jobs that gave up after their last try in the last week (the service error log says why)." });
  const stuckJobs = await db
    .select({ type: job.type, n: count() })
    .from(job)
    .where(and(eq(job.status, "running"), lt(job.runAt, new Date(now.getTime() - HOUR))))
    .groupBy(job.type);
  add({ kind: "jobs.stuck", level: "note", rows: stuckJobs.map((j) => `${j.type}: ${j.n}`), text: "Background jobs still running whose turn came over an hour ago — a slow model, or a restart mid-job (picked up again at the next start)." });
  const stuckRuns = await db.select({ householdId: aiRun.householdId, at: aiRun.createdAt }).from(aiRun).where(and(eq(aiRun.status, "pending"), lt(aiRun.createdAt, new Date(now.getTime() - DAY))));
  add({ kind: "imports.ai", level: "note", rows: stuckRuns.map((r) => where(r.householdId, `Sort with AI, ${day(r.at)}`)), text: "Imports sorted with AI that never finished." });
  const stuckDownloads = await db
    .select({ householdId: pendingDownload.householdId, at: pendingDownload.createdAt })
    .from(pendingDownload)
    .where(and(eq(pendingDownload.status, "pending"), lt(pendingDownload.createdAt, new Date(now.getTime() - DAY))));
  add({ kind: "downloads.stuck", level: "note", rows: stuckDownloads.map((r) => where(r.householdId, `Add from a web address, ${day(r.at)}`)), text: "Downloads from a web address still waiting after a day." });
  const stuckScans = await db
    .select({ householdId: roomScan.householdId, at: roomScan.createdAt })
    .from(roomScan)
    .where(and(eq(roomScan.status, "pending"), lt(roomScan.createdAt, new Date(now.getTime() - DAY))));
  add({ kind: "roomscans.stuck", level: "note", rows: stuckScans.map((r) => where(r.householdId, `Room scan, ${day(r.at)}`)), text: "Room scans that never finished." });

  // ── Backups ─────────────────────────────────────────────────────────────
  const [last] = await db.select().from(backupRun).orderBy(sql`${backupRun.startedAt} desc`).limit(1);
  if (last?.status === "failed") findings.push({ kind: "backups.failed", level: "problem", count: 1, text: "The last backup failed (Backups, above, says why).", examples: [] });
  if (last) {
    const [ok] = await db.select({ at: backupRun.startedAt }).from(backupRun).where(eq(backupRun.status, "ok")).orderBy(sql`${backupRun.startedAt} desc`).limit(1);
    if (!ok || now.getTime() - ok.at.getTime() > 2 * DAY) {
      findings.push({ kind: "backups.stale", level: "problem", count: 1, text: ok ? `The last good backup is from ${ok.at.toISOString().slice(0, 10)} — over two days ago.` : "No backup has succeeded yet.", examples: [] });
    }
  }

  return {
    at: now.toISOString(),
    ms: Date.now() - started,
    files: { total: keys.length, checked: toCheck.length, missing: missing.length + missingThumbs.length, decrypted: sample.length, unreadable: unreadable.length },
    findings,
  };
}
