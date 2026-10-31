/** Nightly backups: snapshot + files to a folder, the restore check, keeping the newest, restoring, and who sees it. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AttentionItem, BackupSnapshot, BackupStatus } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { supportsSnapshots } from "./db";
import { FsBlobs } from "../src/adapters/local/blobs";
import { createLocalDb } from "../src/adapters/local/db";
import { restoreBackup } from "../src/adapters/local/restore";
import { attachment, backupRun, item } from "../src/db/schema";
import { type Backups, backupDue, checkSnapshot, listSnapshots, readManifest, runBackup } from "../src/lib/backup";
import { FileStore } from "../src/lib/files";
import { purgeDeleted } from "../src/lib/trash";
import type { BackupTarget } from "../src/ports";
import { config, photo, setup } from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const at = (iso: string) => new Date(iso);
const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function household() {
  const t = await setup({ backups: true });
  const ann = await t.user("ann");
  const drill = await ann.addItem({ name: "Cordless drill", brand: "DeWalt" });
  const picture = await photo();
  const up = await ann.upload(drill.id, picture, "drill.jpg");
  const b: Backups = { db: t.db, blobs: t.deps.blobs, ...t.deps.backups!, filesKey: config.FILES_KEY, keep: 14 };
  return { ...t, ann, drill, picture, attachmentId: up.id, b, target: t.deps.backups!.target };
}

// Backups copy the SQLite file itself (VACUUM INTO): not on a test database that can't (test/db.ts).
describe.skipIf(!supportsSnapshots)("backups", () => {
  it("copies the database and files, checks the copy, and shows how it went", async () => {
    const { jobs, ann, drill, picture, attachmentId, target } = await household();

    expect((await json<BackupStatus>(ann.as("/api/v1/backup"))).last).toBeNull();
    expect((await ann.as("/api/v1/backup", { method: "POST" })).status).toBe(202);
    await jobs.drain();

    const status = await json<BackupStatus>(ann.as("/api/v1/backup"));
    expect(status).toMatchObject({ enabled: true, where: target.where, hour: 3, keep: 14 });
    expect(status.last).toMatchObject({ status: "ok", files: 2, filesCopied: 2, error: null });
    expect(status.last!.checked).toMatch(/^Opened the copy: 1 item, 2 files, all there; 2 decrypted/);
    expect(status.lastOk).toEqual(status.last);

    // What's in the folder: the database only encrypted, the files as they were (ciphertext).
    const [name] = await listSnapshots(target);
    const sealed = await target.get(`snapshots/${name}.db.enc`);
    expect(Buffer.from(sealed!).includes("Cordless drill")).toBe(false);
    const manifest = await readManifest(target, name!);
    expect(manifest.files.map((f) => f.key).sort()).toEqual([`${ann.householdId}/${attachmentId}`, `${ann.householdId}/${attachmentId}.thumb`]);

    const snapshots = await json<{ data: BackupSnapshot[] }>(ann.as("/api/v1/backup/snapshots"));
    expect(snapshots.data).toEqual([{ name, createdAt: manifest.createdAt, items: 1, files: 2, filesBytes: status.last!.filesBytes }]);
    expect(await json(ann.as(`/api/v1/backup/snapshots/${name}/check`, { method: "POST" }))).toEqual({ ok: true, summary: expect.stringMatching(/^Opened the copy/) });
    expect((await ann.as("/api/v1/backup/snapshots/ferret-20990101T000000Z/check", { method: "POST" })).status).toBe(404);

    // A restore from just the folder and FILES_KEY: the item, and the photo decrypted with the key inside the copy.
    const dataDir = path.join(mkdtempSync(path.join(tmpdir(), "ferret-restore-")), "data");
    await restoreBackup({ target, filesKey: config.FILES_KEY, dataDir });
    const restored = createLocalDb(`file:${path.join(dataDir, "ferret.db")}`);
    const [row] = await restored.db.select({ name: item.name }).from(item).where(eq(item.id, drill.id));
    expect(row).toEqual({ name: "Cordless drill" });
    const files = new FileStore(restored.db, new FsBlobs(path.join(dataDir, "files")), config.FILES_KEY);
    expect(Buffer.from((await files.get(ann.householdId, `${ann.householdId}/${attachmentId}`))!).equals(Buffer.from(picture))).toBe(true);
    restored.client.close();

    // …and never over an existing database.
    await expect(restoreBackup({ target, filesKey: config.FILES_KEY, dataDir })).rejects.toThrow(/already exists/);
  });

  it("copies each file once, keeps the newest snapshots and only the files they need", async () => {
    const { db, deps, ann, drill, attachmentId, b, target, files } = await household();
    await runBackup(b, at("2026-10-01T03:00:00Z"));
    const second = await ann.addItem({ name: "Stand mixer" });
    await ann.upload(second.id, await photo(), "mixer.jpg");
    await runBackup(b, at("2026-10-02T03:00:00Z"));
    const runs = await db.select().from(backupRun).orderBy(backupRun.startedAt);
    expect(runs.map((r) => [r.files, r.filesCopied])).toEqual([[2, 2], [4, 2]]);

    // The drill's photo is removed and purged: the next snapshots don't need it, and once the older ones are
    // dropped (keep 2), neither does the folder.
    await ann.as(`/api/v1/items/${drill.id}/attachments/${attachmentId}`, { method: "DELETE" });
    await db.update(attachment).set({ deletedAt: at("2026-01-01T00:00:00Z") }).where(eq(attachment.id, attachmentId));
    await purgeDeleted({ db, deps, files });
    const keep2 = { ...b, keep: 2 };
    await runBackup(keep2, at("2026-10-03T03:00:00Z"));
    expect(await target.size(`files/${ann.householdId}/${attachmentId}`)).not.toBeNull(); // the 10-02 snapshot needs it
    await runBackup(keep2, at("2026-10-04T03:00:00Z"));
    expect(await listSnapshots(target)).toEqual(["ferret-20261004T030000Z", "ferret-20261003T030000Z"]);
    expect(await target.size(`files/${ann.householdId}/${attachmentId}`)).toBeNull();
    expect((await target.list("files/")).length).toBe(2);
  });

  it("fails the check on a damaged copy, a missing file or the wrong FILES_KEY", async () => {
    const { b, target, ann, attachmentId } = await household();
    await runBackup(b);
    const [name] = await listSnapshots(target);
    const check = (filesKey = config.FILES_KEY) => checkSnapshot({ ...b, filesKey }, name!);
    await expect(check()).resolves.toMatchObject({ summary: expect.stringContaining("all there") });

    await expect(check(otherKey)).rejects.toThrow(/needs another FILES_KEY/);

    const fileName = `files/${ann.householdId}/${attachmentId}`;
    const good = (await target.get(fileName))!;
    const bad = good.slice();
    bad[bad.length - 1]! ^= 1;
    await target.put(fileName, bad);
    await expect(check()).rejects.toThrow(); // GCM won't open a changed file
    await target.delete(fileName);
    await expect(check()).rejects.toThrow(/1 of 2 files are missing/);
    await target.put(fileName, good);

    const db = (await target.get(`snapshots/${name}.db.enc`))!;
    db[20]! ^= 1;
    await target.put(`snapshots/${name}.db.enc`, db);
    await expect(check()).rejects.toThrow();
  });

  it("records a failure, and tells the server admin (the first account) in the bell — nobody else", async () => {
    const t = await setup({ backups: true });
    const ann = await t.user("ann");
    const bob = await t.user("bob"); // a second account, owner of his own household
    const real = t.deps.backups!.target;
    const broken: BackupTarget = {
      where: "/nowhere",
      put: async () => Promise.reject(new Error("Read-only file system")),
      get: (n) => real.get(n),
      size: (n) => real.size(n),
      list: (p) => real.list(p),
      delete: (n) => real.delete(n),
    };
    await runBackup({ db: t.db, blobs: t.deps.blobs, snapshots: t.deps.backups!.snapshots, target: broken, filesKey: config.FILES_KEY, keep: 14 });

    const status = await json<BackupStatus>(ann.as("/api/v1/backup"));
    expect(status.last).toMatchObject({ status: "failed", error: "Read-only file system" });
    expect(status.lastOk).toBeNull();
    const bell = await json<{ data: AttentionItem[] }>(ann.as("/api/v1/attention"));
    expect(bell.data[0]).toMatchObject({ kind: "backup", severity: "urgent", title: "Backup failed", detail: "No backup has worked yet: Read-only file system" });

    expect(await json<{ serverAdmin: boolean }>(ann.as("/api/v1/me"))).toMatchObject({ serverAdmin: true });
    expect(await json<{ serverAdmin: boolean }>(bob.as("/api/v1/me"))).toMatchObject({ serverAdmin: false });
    for (const [method, url] of [["GET", "/api/v1/backup"], ["POST", "/api/v1/backup"], ["GET", "/api/v1/backup/snapshots"]]) {
      expect((await bob.as(url!, { method })).status).toBe(403);
    }
    expect((await json<{ data: AttentionItem[] }>(bob.as("/api/v1/attention"))).data).toEqual([]);
  });

  it("is due once a day from BACKUP_HOUR, and tried again after a failure", async () => {
    const { db, b } = await household();
    const local = (h: number, day = 18) => new Date(2026, 9, day, h, 5);
    expect(await backupDue(db, 3, local(2))).toBe(false);
    expect(await backupDue(db, 3, local(3))).toBe(true);
    await runBackup(b, local(3));
    expect(await backupDue(db, 3, local(4))).toBe(false);
    expect(await backupDue(db, 3, local(2, 19))).toBe(false);
    expect(await backupDue(db, 3, local(3, 19))).toBe(true);
    await db.insert(backupRun).values({ startedAt: local(3, 19), status: "failed", error: "NAS asleep" });
    expect(await backupDue(db, 3, local(4, 19))).toBe(true);
  });

  it("is off without BACKUP_DIR", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await json<BackupStatus>(ann.as("/api/v1/backup"))).toMatchObject({ enabled: false, where: null, last: null });
    expect((await ann.as("/api/v1/backup", { method: "POST" })).status).toBe(409);
  });
});
