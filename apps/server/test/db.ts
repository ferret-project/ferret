/**
 * The tests' database: SQLite (libSQL) in memory, as Ferret runs on Node — or, with FERRET_TEST_DB_MODULE set to a
 * module's path, another SQLite-compatible database it provides — so its limits (bound parameters a query, no
 * transactions) show up here first.
 *
 * The module exports `nextDatabase(): Promise<unknown>` — a fresh, empty database with the binding API drizzle-orm's
 * D1 driver reads (`prepare`, `batch`, `exec`) — and may export `supportsSnapshots = false` (no `VACUUM INTO`, so the
 * backup tests are skipped).
 */
import path from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { createLocalDb, runMigrations } from "../src/adapters/local/db";
import * as schema from "../src/db/schema";
import type { Db } from "../src/ports";

type Provider = { nextDatabase(): Promise<unknown>; supportsSnapshots?: boolean };

const modulePath = process.env.FERRET_TEST_DB_MODULE;
const provider: Provider | undefined = modulePath ? await import(path.resolve(modulePath)) : undefined;
/** Whether this run's database can be snapshotted (backups use SQLite's `VACUUM INTO`). */
export const supportsSnapshots = provider ? provider.supportsSnapshots !== false : true;
const migrations = path.resolve(__dirname, "../migrations");

/** A fresh, migrated database for one test. */
export async function testDb(): Promise<{ db: Db }> {
  if (!provider) {
    const { db } = createLocalDb(":memory:");
    await runMigrations(db, migrations);
    return { db };
  }
  const db = drizzle((await provider.nextDatabase()) as never, { schema });
  await migrate(db, { migrationsFolder: migrations });
  return { db: db as unknown as Db };
}

/**
 * A database migrated up to (not including) migration `tag` — to put rows in as they were — and `finish()` to run the
 * rest. For testing a migration that changes rows (test/migrations.test.ts).
 */
export async function testDbBefore(tag: string): Promise<{ db: Db; finish(): Promise<void> }> {
  const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const journal = JSON.parse(readFileSync(path.join(migrations, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const upTo = journal.entries.findIndex((e) => e.tag === tag);
  if (upTo < 0) throw new Error(`No migration ${tag}`);
  const folder = mkdtempSync(path.join(tmpdir(), "ferret-migrations-"));
  mkdirSync(path.join(folder, "meta"));
  for (const e of journal.entries.slice(0, upTo)) copyFileSync(path.join(migrations, `${e.tag}.sql`), path.join(folder, `${e.tag}.sql`));
  writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }));
  if (!provider) {
    const { db } = createLocalDb(":memory:");
    await runMigrations(db, folder);
    return { db, finish: () => runMigrations(db, migrations) };
  }
  const db = drizzle((await provider.nextDatabase()) as never, { schema });
  await migrate(db, { migrationsFolder: folder });
  return { db: db as unknown as Db, finish: () => migrate(db, { migrationsFolder: migrations }) };
}
