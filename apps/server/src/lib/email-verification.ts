/**
 * Verified email addresses. Every account but the very first (whoever sets Ferret up) must open a link sent to
 * its email before it can sign in — Better Auth's requireEmailVerification, with the email sent by a job
 * (MAIL_URL through Apprise). So an account always belongs to someone who reads that inbox: nobody can sign up
 * as someone else, or hold an invited person's address.
 *
 * Without email (no APPRISE_URL + MAIL_URL) a new account could never be verified, so sign-up past the first
 * account is refused until email is set up. Accounts nobody verified are removed after a week, which frees the
 * address for its owner.
 */
import { and, eq, lt } from "drizzle-orm";
import { user } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import { mailTo } from "./notifications";

export const VERIFY_EMAIL_JOB = "auth.verify-email";
/** How long a verification link works. */
export const VERIFY_TTL_S = 24 * 60 * 60;
/** An account still unverified after this long is removed. */
const UNVERIFIED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

export const emailEnabled = (deps: Pick<Deps, "notifier" | "jobs">, config: { MAIL_URL?: string }) =>
  Boolean(deps.notifier && deps.jobs && config.MAIL_URL);

/** The job: email the link Better Auth made (its token is signed and expires; it isn't stored anywhere else). */
export function sendVerificationJob(deps: Pick<Deps, "notifier"> & { mailUrl?: string }): JobHandler {
  return async (payload) => {
    const { email, name, url } = payload as { email: string; name: string; url: string };
    if (!deps.notifier || !deps.mailUrl) return;
    await deps.notifier.send(mailTo(deps.mailUrl, email), {
      title: "Confirm your email for Ferret",
      body:
        `Hi ${name}, to finish setting up your Ferret account, confirm this is your email address — open this link ` +
        `(it works for a day):\n\n${url}\n\nThen sign in. If you didn't sign up for Ferret, ignore this and the account goes away in a week.`,
    });
  };
}

/** Removes accounts whose email nobody confirmed within a week (run by the daily purge). */
export async function purgeUnverified(db: Db, now = Date.now()) {
  const gone = await db
    .delete(user)
    .where(and(eq(user.emailVerified, false), lt(user.createdAt, new Date(now - UNVERIFIED_KEPT_MS))))
    .returning({ id: user.id });
  return gone.length;
}
