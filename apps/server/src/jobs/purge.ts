/**
 * Daily: removes for good whatever was deleted more than 30 days ago, in every
 * household — items with their photos and documents (encrypted files too),
 * and every other soft-deleted row (lib/trash.ts). Also accounts whose email
 * nobody confirmed within a week (lib/email-verification.ts), and background jobs that gave up more than 30 days
 * ago (each failure is in the service error log already).
 */
import type { FileStore } from "../lib/files";
import { purgeUnverified } from "../lib/email-verification";
import { purgeDeleted } from "../lib/trash";
import { purgeAiRuns } from "../lib/ai-runs";
import type { Deps, JobHandler } from "../ports";
import { and, eq, lt } from "drizzle-orm";
import { job } from "../db/schema";

const FAILED_JOB_DAYS = 30;

/** Jobs that gave up more than 30 days ago (their last try was then). */
export async function purgeFailedJobs(db: Deps["db"], now = Date.now()) {
  const gone = await db
    .delete(job)
    .where(and(eq(job.status, "failed"), lt(job.runAt, new Date(now - FAILED_JOB_DAYS * 24 * 60 * 60 * 1000))))
    .returning({ id: job.id });
  return gone.length;
}

export const PURGE_JOB = "trash.purge";

export function purgeJob(deps: Deps & { files: FileStore }): JobHandler {
  return async () => {
    const counts = { ...(await purgeDeleted({ db: deps.db, deps, files: deps.files })), "unconfirmed accounts": await purgeUnverified(deps.db), "failed jobs": await purgeFailedJobs(deps.db) };
    await purgeAiRuns(deps);
    const gone = Object.entries(counts).filter(([, n]) => n > 0);
    if (gone.length) console.log(`Purged deleted ${gone.map(([what, n]) => `${what}: ${n}`).join(", ")}`);
  };
}
