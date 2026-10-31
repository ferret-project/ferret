import { mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "../../db/schema";

/** SQLite file (via libSQL) — the Db port. */
export function createLocalDb(url: string) {
  if (url.startsWith("file:")) mkdirSync(path.dirname(url.slice(5)), { recursive: true });
  const client = createClient({ url });
  return { db: drizzle(client, { schema }), client };
}

export async function runMigrations(db: ReturnType<typeof createLocalDb>["db"], migrationsFolder: string) {
  await db.run("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder });
}
