import { t as translateText } from "./i18n";
/**
 * Making a key file shows up: `cli.js key export` records it (server_setting "keyfile.last") and queues a message to the
 * server admin, and Settings → Server shows the newest. Not a gate — whoever can run the command can read FILES_KEY from
 * the environment anyway — but every key file made through Ferret is known, and a server without one says so.
 */
import { eq } from "drizzle-orm";
import { serverSetting, user } from "../db/schema";
import type { Db, Deps, JobHandler, Jobs } from "../ports";
import type { FileStore } from "./files";
import { notifyPerson } from "./notifications";
import { serverAdmin } from "./server-admin";
import { adminTimeZone, localTime } from "./service-errors";

export const KEY_FILE_JOB = "key_file_notice";
const LAST = "keyfile.last";

export interface KeyFileRecord {
  at: string;
  /** Which FILES_KEY it holds. */
  keyId: string;
  /** Where it was written, as the server saw it. */
  where: string;
}

export async function recordKeyFile(db: Db, jobs: Pick<Jobs, "enqueue">, record: KeyFileRecord) {
  const value = JSON.stringify(record);
  await db.insert(serverSetting).values({ key: LAST, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value, updatedAt: new Date() } });
  await jobs.enqueue(KEY_FILE_JOB, record);
}

/** The newest key file made, and whether it holds the key the server runs with now. */
export async function lastKeyFile(db: Db, keyId: string): Promise<(KeyFileRecord & { current: boolean }) | null> {
  const [row] = await db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, LAST));
  if (!row) return null;
  try {
    const r = JSON.parse(row.value) as KeyFileRecord;
    return { ...r, current: r.keyId === keyId };
  } catch {
    return null;
  }
}

export function keyFileNotice(deps: Deps & { files: FileStore; appUrl: string; mailUrl?: string }): JobHandler {
  return async (payload) => {
    const r = payload as KeyFileRecord;
    const admin = await serverAdmin(deps.db);
    if (!admin) return;
    const [who] = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, admin.id));
    const when = localTime(new Date(r.at), await adminTimeZone(deps.db));
    await notifyPerson(
      deps,
      admin.id,
      {
        title: translateText("A key file was made for Ferret's files"),
        body:
          translateText("On {v0}, a key file for FILES_KEY {v1} was written on the server ({v2}). With its passphrase it opens ", { v0: when, v1: r.keyId, v2: r.where }) +
          translateText("every photo and document. If that wasn't you, someone can run commands on the server — find out who before anything else."),
        url: `${deps.appUrl}/#/settings/server`,
        tag: "ferret-key-file",
      },
      { email: who?.email },
    );
  };
}
