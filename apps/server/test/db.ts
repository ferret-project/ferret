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
