import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { BackupTarget, Db, DbSnapshots } from "../../ports";
import { createLocalDb } from "./db";

/** Backups in a folder — e.g. an NFS share on the NAS mounted into the container. */
export class FolderBackupTarget implements BackupTarget {
  constructor(private readonly root: string) {}

  get where() {
    return this.root;
  }

  private resolve(name: string) {
    const full = path.resolve(this.root, name);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid backup file name");
    return full;
  }

  async put(name: string, data: Uint8Array) {
    const file = this.resolve(name);
    await mkdir(path.dirname(file), { recursive: true });
    // Written beside it, then renamed: a crash leaves a stray .partial, never a half file under the real name.
    const partial = `${file}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, data, { flush: true });
      await rename(partial, file);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }

  async get(name: string) {
    try {
      const buf = await readFile(this.resolve(name));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length) as Uint8Array<ArrayBuffer>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async size(name: string) {
    try {
      return (await stat(this.resolve(name))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(prefix: string) {
    const dir = this.resolve(prefix);
    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const names: string[] = [];
    for (const e of entries) {
      if (e.endsWith(".partial")) continue;
      if ((await stat(path.join(dir, e))).isFile()) names.push(path.posix.join(prefix, e.split(path.sep).join("/")));
    }
    return names;
  }

  async delete(name: string) {
    await rm(this.resolve(name), { force: true });
  }
}

/** Copies of the SQLite database by VACUUM INTO: consistent, compact, and taken while the app keeps writing. */
export class SqliteSnapshots implements DbSnapshots {
  constructor(private readonly db: Db) {}

  async take() {
    const file = path.join(tmpdir(), `ferret-snapshot-${randomUUID()}.db`);
    try {
      await this.db.run(sql.raw(`VACUUM INTO '${file.replaceAll("'", "''")}'`));
      const buf = await readFile(file);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length) as Uint8Array<ArrayBuffer>;
    } finally {
      await rm(file, { force: true });
    }
  }

  async open(bytes: Uint8Array) {
    const file = path.join(tmpdir(), `ferret-check-${randomUUID()}.db`);
    await writeFile(file, bytes);
    const { db, client } = createLocalDb(`file:${file}`);
    return {
      db,
      close: async () => {
        client.close();
        await rm(file, { force: true });
      },
    };
  }
}
