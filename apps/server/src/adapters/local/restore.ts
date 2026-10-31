import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkSnapshot, listSnapshots, openSnapshot, readManifest } from "../../lib/backup";
import type { BackupTarget } from "../../ports";
import { FsBlobs } from "./blobs";
import { SqliteSnapshots } from "./backup";
import { createLocalDb } from "./db";

/**
 * Rebuilds a data folder (ferret.db + files/) from a backup: the newest snapshot, or the one named. Checks it first,
 * and refuses to write over a folder that already has a database. Start Ferret on the result with the same FILES_KEY.
 */
export async function restoreBackup(opts: { target: BackupTarget; filesKey: string; dataDir: string; snapshot?: string; log?: (line: string) => void }) {
  const log = opts.log ?? (() => {});
  const snapshot = opts.snapshot ?? (await listSnapshots(opts.target))[0];
  if (!snapshot) throw new Error(`No backups in ${opts.target.where}`);
  const dbFile = path.join(opts.dataDir, "ferret.db");
  if (existsSync(dbFile)) throw new Error(`${dbFile} already exists — restore into an empty folder`);

  // checkSnapshot opens the copy on its own; it doesn't touch the live database.
  const { summary } = await checkSnapshot({ snapshots: new SqliteSnapshots(createLocalDb(":memory:").db), target: opts.target, filesKey: opts.filesKey }, snapshot);
  log(`${snapshot}: ${summary}`);

  const manifest = await readManifest(opts.target, snapshot);
  const sealed = await opts.target.get(`snapshots/${snapshot}.db.enc`);
  const plain = await openSnapshot(opts.filesKey, snapshot, sealed!);
  await mkdir(opts.dataDir, { recursive: true });
  await writeFile(dbFile, plain);

  const blobs = new FsBlobs(path.join(opts.dataDir, "files"));
  let n = 0;
  for (const f of manifest.files) {
    const bytes = await opts.target.get(`files/${f.key}`);
    if (!bytes) throw new Error(`File ${f.key} is missing from the backup`);
    await blobs.put(f.key, bytes, "application/octet-stream");
    if (++n % 500 === 0) log(`  ${n} of ${manifest.files.length} files…`);
  }
  log(`Restored ${snapshot} into ${opts.dataDir}: the database and ${manifest.files.length} files`);
  return { snapshot, files: manifest.files.length };
}
