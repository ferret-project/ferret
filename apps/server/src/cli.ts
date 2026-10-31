/**
 * Ferret from the command line (Node), for what's done on the server itself. In the container:
 *   docker compose exec ferret node dist/cli.js admin                  who the server admin is
 *   docker compose exec ferret node dist/cli.js admin you@example.com  hand it to another (confirmed) account
 *   docker compose run --rm ferret node dist/cli.js backup list
 *   docker compose run --rm ferret node dist/cli.js backup check [snapshot]
 *   docker compose run --rm -v /path/to/new-data:/restore ferret node dist/cli.js backup restore /restore [snapshot]
 * Reads .env (DATA_DIR, FILES_KEY, BACKUP_DIR). In dev: pnpm --filter @ferret/server cli admin
 */
import path from "node:path";
import { FolderBackupTarget, SqliteSnapshots } from "./adapters/local/backup";
import { createLocalDb } from "./adapters/local/db";
import { restoreBackup } from "./adapters/local/restore";
import { checkSnapshot, listSnapshots, readManifest } from "./lib/backup";
import { serverAdmin, setServerAdmin } from "./lib/server-admin";

const USAGE = `Usage: cli.js admin [email] | backup list | backup check [snapshot] | backup restore <data folder> [snapshot]`;
const [command, ...args] = process.argv.slice(2);
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (it's in .env).`);
  return value;
};

async function admin(email?: string) {
  const dbFile = path.join(path.resolve(process.env.DATA_DIR ?? "./data"), "ferret.db");
  const { db, client } = createLocalDb(`file:${dbFile}`);
  try {
    const who = email ? await setServerAdmin(db, email) : await serverAdmin(db);
    console.log(who ? `${email ? "The server admin is now" : "Server admin:"} ${who.name} <${who.email}>` : "No accounts yet");
  } finally {
    client.close();
  }
}

async function backup(sub: string | undefined, rest: string[]) {
  const filesKey = env("FILES_KEY");
  const target = new FolderBackupTarget(path.resolve(env("BACKUP_DIR")));
  if (sub === "list") {
    for (const name of await listSnapshots(target)) {
      const m = await readManifest(target, name);
      console.log(`${name}  ${m.createdAt}  ${m.counts.items} items, ${m.files.length} files`);
    }
  } else if (sub === "check") {
    const name = rest[0] ?? (await listSnapshots(target))[0];
    if (!name) throw new Error(`No backups in ${target.where}`);
    const { summary } = await checkSnapshot({ snapshots: new SqliteSnapshots(createLocalDb(":memory:").db), target, filesKey }, name);
    console.log(`${name}: ${summary}`);
  } else if (sub === "restore" && rest[0]) {
    await restoreBackup({ target, filesKey, dataDir: path.resolve(rest[0]), snapshot: rest[1], log: console.log });
  } else {
    throw new Error(USAGE);
  }
}

try {
  if (command === "admin") await admin(args[0]);
  else if (command === "backup") await backup(args[0], args.slice(1));
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
