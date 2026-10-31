/**
 * Daily: removes for good whatever was deleted more than 30 days ago, in every
 * household — items with their photos and documents (encrypted files too),
 * and every other soft-deleted row (lib/trash.ts). Also accounts whose email
 * nobody confirmed within a week (lib/email-verification.ts).
 */
import type { FileStore } from "../lib/files";
import { purgeUnverified } from "../lib/email-verification";
import { purgeDeleted } from "../lib/trash";
import type { Deps, JobHandler } from "../ports";

export const PURGE_JOB = "trash.purge";

export function purgeJob(deps: Deps & { files: FileStore }): JobHandler {
  return async () => {
    const counts = { ...(await purgeDeleted({ db: deps.db, deps, files: deps.files })), "unconfirmed accounts": await purgeUnverified(deps.db) };
    const gone = Object.entries(counts).filter(([, n]) => n > 0);
    if (gone.length) console.log(`Purged deleted ${gone.map(([what, n]) => `${what}: ${n}`).join(", ")}`);
  };
}
