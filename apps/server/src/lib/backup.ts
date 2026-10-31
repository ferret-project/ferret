/**
 * Nightly backups of the whole server: a copy of the database and every file, in a folder off this machine
 * (`BACKUP_DIR`, e.g. a share on the NAS), checked by opening it again.
 *
 * The folder holds:
 *   snapshots/ferret-<time>.db.enc  the database, encrypted with a key made from FILES_KEY (so there's still one
 *                                   secret to keep, and a backup is useless without it — like the files)
 *   snapshots/ferret-<time>.json    its manifest: when, which FILES_KEY, the files it needs (written last, so a
 *                                   snapshot without one never finished)
 *   files/<household>/<id>[.thumb]  the encrypted files, copied as they are; they never change, so each is copied once
 *
 * The newest BACKUP_KEEP snapshots are kept, and the files any of them need. The restore check reads the copy back
 * from the folder, decrypts it, has SQLite check it, makes sure every file it needs is there, and decrypts a few with
 * the household keys inside it — the same steps a restore takes (src/restore.ts).
 */
import { roomPhotoKeys } from "./room-scans";
import { type BackupRun, type BackupStatus, localParts } from "@ferret/shared";
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import { attachment, backupRun, item } from "../db/schema";
import type { BackupElsewhere, BackupTarget, Blobs, Db, DbSnapshots, JobHandler } from "../ports";
import { FileStore, masterKeyId } from "./files";

export const BACKUP_JOB = "backup.run";
const FORMAT_V1 = 1;
const IV_BYTES = 12;
/** How many files the check decrypts. */
const SAMPLE = 3;
/** Run rows kept for the record. */
const KEEP_RUNS = 60;
/** A "running" row older than this was cut short (the server restarted). */
const STALE_MS = 6 * 60 * 60 * 1000;
const utf8 = new TextEncoder();

export interface Manifest {
  version: 1;
  app: "ferret";
  createdAt: string;
  /** Which FILES_KEY it needs (household_key.kek_id). */
  kekId: string;
  /** SHA-256 of the decrypted database, hex. */
  dbSha256: string;
  files: { key: string; size: number }[];
  counts: { items: number; attachments: number };
}

export interface Backups {
  db: Db;
  blobs: Blobs;
  snapshots: DbSnapshots;
  target: BackupTarget;
  filesKey: string;
  keep: number;
}

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: Uint8Array<ArrayBuffer>) => toHex(await crypto.subtle.digest("SHA-256", data));
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** The database's backup key: made from FILES_KEY (HKDF), never stored. */
async function backupKey(filesKey: string) {
  const raw = Uint8Array.from(atob(filesKey), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  raw.fill(0);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode("ferret-backup-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** [version][iv][ciphertext + tag], with the snapshot's name bound in so copies can't be swapped. */
export async function sealSnapshot(filesKey: string, name: string, plain: Uint8Array<ArrayBuffer>) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(name) }, await backupKey(filesKey), plain);
  const out = new Uint8Array(1 + IV_BYTES + sealed.byteLength);
  out.set([FORMAT_V1]);
  out.set(iv, 1);
  out.set(new Uint8Array(sealed), 1 + IV_BYTES);
  return out;
}

export async function openSnapshot(filesKey: string, name: string, bytes: Uint8Array<ArrayBuffer>) {
  if (bytes[0] !== FORMAT_V1) throw new Error(`Unknown backup format ${bytes[0]}`);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(1, 1 + IV_BYTES), additionalData: utf8.encode(name) },
    await backupKey(filesKey),
    bytes.subarray(1 + IV_BYTES),
  );
  return new Uint8Array(plain);
}

/** The backup folder's files/ as a Blobs store, so FileStore can decrypt from it as from the live one. */
export function backupBlobs(target: BackupTarget): Blobs {
  return {
    put: async (key, data) => target.put(`files/${key}`, data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer())),
    get: async (key) => {
      const bytes = await target.get(`files/${key}`);
      return bytes && { body: new Response(bytes).body!, size: bytes.length, contentType: "application/octet-stream" };
    },
    delete: (key) => target.delete(`files/${key}`),
  };
}

/** Snapshot names, newest first (the ones whose manifest was written: finished). */
export async function listSnapshots(target: BackupTarget) {
  const names = await target.list("snapshots/");
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice("snapshots/".length, -".json".length))
    .sort()
    .reverse();
}

export async function readManifest(target: BackupTarget, snapshot: string) {
  const bytes = await target.get(`snapshots/${snapshot}.json`);
  if (!bytes) throw new Error(`No manifest for ${snapshot}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
}

/**
 * Every file a database refers to, as blob keys (photos, documents and their thumbnails; deleted ones too, until
 * purged; not originals removed to free space). The database may be an older backup's, not migrated yet: only the
 * columns every version has are read, and removed originals only where the column exists.
 */
async function fileKeys(db: Db) {
  const rows = await db.select({ householdId: attachment.householdId, blobKey: attachment.blobKey, thumbnailKey: attachment.thumbnailKey }).from(attachment);
  const removed = new Set(
    (await db
      .select({ blobKey: attachment.blobKey })
      .from(attachment)
      .where(isNotNull(attachment.originalRemovedAt))
      .catch(() => [])) // a backup from before originals could be removed
      .map((r) => r.blobKey),
  );
  const roomPhotos = await roomPhotoKeys(db).catch(() => []); // a backup from before room scans
  return [
    ...rows.flatMap((r) => [
      ...(removed.has(r.blobKey) ? [] : [{ householdId: r.householdId, key: r.blobKey }]),
      ...(r.thumbnailKey ? [{ householdId: r.householdId, key: r.thumbnailKey }] : []),
    ]),
    ...roomPhotos,
  ];
}

/**
 * Opens a snapshot from the backup folder the way a restore would, and says what it found. Throws if anything a
 * restore needs is wrong: the wrong FILES_KEY, a damaged copy, a missing file, a file that won't decrypt.
 */
export async function checkSnapshot(b: Pick<Backups, "snapshots" | "target" | "filesKey">, snapshot: string, prefer: string[] = []) {
  const manifest = await readManifest(b.target, snapshot);
  if (manifest.kekId !== (await masterKeyId(b.filesKey))) {
    throw new Error(`This backup needs another FILES_KEY (${manifest.kekId}) than the one set (${await masterKeyId(b.filesKey)})`);
  }
  const sealed = await b.target.get(`snapshots/${snapshot}.db.enc`);
  if (!sealed) throw new Error(`The database copy ${snapshot}.db.enc is missing`);
  const plain = await openSnapshot(b.filesKey, snapshot, sealed);
  if ((await sha256(plain)) !== manifest.dbSha256) throw new Error("The database copy doesn't match its manifest");

  const copy = await b.snapshots.open(plain);
  try {
    const [integrity] = await copy.db.all<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
    if (integrity?.integrity_check !== "ok") throw new Error(`SQLite found damage in the copy: ${integrity?.integrity_check ?? "no answer"}`);
    const [counted] = await copy.db.select({ items: sql<number>`count(*)` }).from(item).where(isNull(item.deletedAt));
    const items = Number(counted?.items ?? 0);

    const present = new Set(await b.target.list("files/"));
    const missing = manifest.files.filter((f) => !present.has(`files/${f.key}`));
    if (missing.length) throw new Error(`${missing.length} of ${manifest.files.length} files are missing from the backup (e.g. ${missing[0]!.key})`);

    // Decrypt a few with the household keys in the copy: proves FILES_KEY + this folder are enough.
    const inManifest = new Set(manifest.files.map((f) => f.key));
    const keys = (await fileKeys(copy.db)).filter((k) => inManifest.has(k.key));
    const preferred = new Set(prefer);
    const sample = [...keys.filter((k) => preferred.has(k.key)), ...keys.filter((k) => !preferred.has(k.key)).sort(() => Math.random() - 0.5)].slice(0, SAMPLE);
    const restored = new FileStore(copy.db, backupBlobs(b.target), b.filesKey);
    for (const k of sample) {
      if (!(await restored.get(k.householdId, k.key))) throw new Error(`File ${k.key} is missing from the backup`);
    }
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
    return {
      manifest,
      summary: `Opened the copy: ${plural(items, "item")}, ${plural(manifest.files.length, "file")}, all there${sample.length ? `; ${sample.length} decrypted` : ""}`,
    };
  } finally {
    await copy.close();
  }
}

/** One backup: snapshot, files, manifest, check, then tidy up. Records how it went in backup_run. */
export async function runBackup(b: Backups, now = new Date()) {
  // A run still "running" from before a restart never finished.
  await b.db
    .update(backupRun)
    .set({ status: "failed", finishedAt: now, error: "Interrupted (the server stopped)" })
    .where(and(eq(backupRun.status, "running"), lt(backupRun.startedAt, new Date(now.getTime() - STALE_MS))));
  const name = `ferret-${stamp(now)}`;
  const [run] = await b.db.insert(backupRun).values({ startedAt: now, status: "running", snapshot: name }).returning({ id: backupRun.id });
  const runId = run!.id;
  try {
    const plain = await b.snapshots.take();
    const sealed = await sealSnapshot(b.filesKey, name, plain);

    // The files the snapshot refers to — from the snapshot itself, so the two agree.
    const copy = await b.snapshots.open(plain);
    let keys: Awaited<ReturnType<typeof fileKeys>>;
    let attachments: number;
    let items: number;
    try {
      keys = await fileKeys(copy.db);
      attachments = (await copy.db.select({ id: attachment.id }).from(attachment)).length;
      items = Number((await copy.db.select({ n: sql<number>`count(*)` }).from(item).where(isNull(item.deletedAt)))[0]!.n);
    } finally {
      await copy.close();
    }

    const files: Manifest["files"] = [];
    const copied: string[] = [];
    let filesBytes = 0;
    let gone = 0;
    for (const { key } of keys) {
      const have = await b.target.size(`files/${key}`);
      if (have !== null) {
        files.push({ key, size: have });
        filesBytes += have;
        continue;
      }
      const blob = await b.blobs.get(key);
      if (!blob) {
        gone++; // deleted for good since the snapshot (the purge), or lost: nothing to copy
        continue;
      }
      const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
      await b.target.put(`files/${key}`, bytes);
      files.push({ key, size: bytes.length });
      filesBytes += bytes.length;
      copied.push(key);
    }

    await b.target.put(`snapshots/${name}.db.enc`, sealed);
    const manifest: Manifest = {
      version: 1,
      app: "ferret",
      createdAt: now.toISOString(),
      kekId: await masterKeyId(b.filesKey),
      dbSha256: await sha256(plain),
      files,
      counts: { items, attachments },
    };
    await b.target.put(`snapshots/${name}.json`, utf8.encode(JSON.stringify(manifest, null, 1)));

    const { summary } = await checkSnapshot(b, name, copied);
    const checked = gone ? `${summary}. ${gone} ${gone === 1 ? "file was" : "files were"} not on the server to copy` : summary;
    await prune(b);
    await b.db
      .update(backupRun)
      .set({ status: "ok", finishedAt: new Date(), dbBytes: sealed.length, files: files.length, filesCopied: copied.length, filesBytes, checked })
      .where(eq(backupRun.id, runId));
  } catch (err) {
    console.warn(`Backup failed: ${errorText(err)}`);
    await b.db.update(backupRun).set({ status: "failed", finishedAt: new Date(), error: errorText(err) }).where(eq(backupRun.id, runId));
  }
  // Keep the record short.
  const old = (await b.db.select({ id: backupRun.id }).from(backupRun).orderBy(desc(backupRun.startedAt))).slice(KEEP_RUNS);
  if (old.length) await b.db.delete(backupRun).where(inArray(backupRun.id, old.map((r) => r.id)));
  return runId;
}

/** Keeps the newest `keep` snapshots and the files they need; drops unfinished snapshots and everything else. */
async function prune(b: Backups) {
  const kept = (await listSnapshots(b.target)).slice(0, b.keep);
  const keptSet = new Set(kept);
  for (const n of await b.target.list("snapshots/")) {
    const base = n.slice("snapshots/".length).replace(/\.(db\.enc|json)$/, "");
    if (!keptSet.has(base)) await b.target.delete(n);
  }
  const needed = new Set<string>();
  for (const s of kept) for (const f of (await readManifest(b.target, s)).files) needed.add(`files/${f.key}`);
  for (const n of await b.target.list("files/")) if (!needed.has(n)) await b.target.delete(n);
}

/** Whether tonight's backup is due: from `hour`, once a day (a failed one is tried again the next hour). */
export async function backupDue(db: Db, hour: number, now = new Date()) {
  const t = localParts(now);
  if (t.hour < hour) return false;
  // Today at `hour`, where the household is.
  const since = new Date(now.getTime() - ((t.hour - hour) * 3600 + t.minute * 60 + t.second) * 1000 - now.getMilliseconds());
  const [recent] = await db
    .select({ status: backupRun.status, startedAt: backupRun.startedAt })
    .from(backupRun)
    .where(notInArray(backupRun.status, ["failed"]))
    .orderBy(desc(backupRun.startedAt))
    .limit(1);
  return !recent || recent.startedAt < since;
}

export function backupJob(b: Backups): JobHandler {
  return async () => {
    await runBackup(b);
  };
}

const toRun = (r: typeof backupRun.$inferSelect | undefined): BackupRun | null =>
  r
    ? {
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        status: r.status,
        dbBytes: r.dbBytes,
        files: r.files,
        filesCopied: r.filesCopied,
        filesBytes: r.filesBytes,
        checked: r.checked,
        error: r.error,
      }
    : null;

export async function backupStatus(
  db: Db,
  opts: { where: string | null; hour: number; keep: number; elsewhere?: BackupElsewhere },
): Promise<BackupStatus> {
  const [last] = await db.select().from(backupRun).orderBy(desc(backupRun.startedAt)).limit(1);
  const [lastOk] = await db.select().from(backupRun).where(eq(backupRun.status, "ok")).orderBy(desc(backupRun.startedAt)).limit(1);
  const run = opts.elsewhere ? await opts.elsewhere.latest() : null;
  return {
    enabled: opts.where !== null,
    where: opts.where,
    hour: opts.hour,
    keep: opts.keep,
    last: toRun(last),
    lastOk: toRun(lastOk),
    elsewhere: opts.elsewhere ? { where: opts.elsewhere.where, at: run?.at.toISOString() ?? null, ok: run?.ok ?? null, detail: run?.detail ?? null } : null,
  };
}
