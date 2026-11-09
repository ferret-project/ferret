import { t as translateText } from "./i18n";
/**
 * Verified email addresses. Every account but the very first (whoever sets Ferret up) must open a link sent to
 * its email before it can sign in — Better Auth's requireEmailVerification, with the email sent by a job
 * (MAIL_URL through Apprise). So an account always belongs to someone who reads that inbox: nobody can sign up
 * as someone else, or hold an invited person's address.
 *
 * The link alone isn't enough: it proves the inbox, not who chose the password. So it opens the sign-in screen
 * (`/?confirm=<token>`), and the account is confirmed only with the password it was made with
 * (POST /api/auth/confirm-email). Better Auth's own GET /verify-email is switched off; links to it are sent on
 * to that screen (app.ts). Signing up again with an address nobody has confirmed replaces that account (auth.ts
 * signUpGate), so a stranger who got there first can't keep it.
 *
 * Without email (no APPRISE_URL + MAIL_URL) a new account could never be verified, so sign-up past the first
 * account is refused until email is set up. Accounts nobody verified are removed after a week, which frees the
 * address for its owner.
 */
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { and, eq, gt, like, lt } from "drizzle-orm";
import * as z from "zod";
import { user, verification } from "../db/schema";
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
      title: translateText("Confirm your email for Ferret"),
      body:
        translateText("Hi {v0}, to finish setting up your Ferret account, confirm this is your email address — open this link ", { v0: name }) +
        translateText("(it works for a day):\n\n{v0}\n\nThen sign in. If you didn't sign up for Ferret, ignore this and the account goes away in a week.", { v0: url }),
    });
  };
}

/** Removes accounts whose email nobody confirmed within a week (run by the daily purge). */
export async function purgeUnverified(db: Db, now = Date.now()) {
  const gone = await db
    .delete(user)
    .where(and(eq(user.emailVerified, false), lt(user.createdAt, new Date(now - UNVERIFIED_KEPT_MS))))
    .returning({ id: user.id });
  await db.delete(verification).where(and(like(verification.identifier, `${SENT}%`), lt(verification.expiresAt, new Date(now))));
  return gone.length;
}

/** Confirmation emails an account gets: a record per email sent, kept a day. */
const SENT = "verify-email-sent:";
const SENDS_A_DAY = 5;

/** Whether another confirmation email may go to this account now (at most 5 a day) — and counts it. */
export async function mayEmailConfirmation(db: Db, userId: string, now = Date.now()) {
  const identifier = SENT + userId;
  const sent = await db
    .select({ at: verification.createdAt })
    .from(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.createdAt, new Date(now - 24 * 60 * 60_000))));
  if (sent.length >= SENDS_A_DAY) return false;
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier,
    value: userId,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    expiresAt: new Date(now + 24 * 60 * 60_000),
  });
  return true;
}

/** Signing up again with an address nobody has confirmed: that account goes, so this one can be made. */
export async function replaceUnconfirmed(db: Db, email: string) {
  await db.delete(user).where(and(eq(user.email, email.trim().toLowerCase()), eq(user.emailVerified, false)));
}

const WRONG_LINK = "That link didn't work — it may have expired. Sign in, and we'll offer a new one.";

/**
 * POST /api/auth/confirm-email {token, password}: the emailed link's token, and the password the account was made
 * with. Answers the email, so the app can sign in with it.
 */
export function confirmEmail() {
  return {
    id: "ferret-confirm-email",
    endpoints: {
      confirmEmail: createAuthEndpoint(
        "/confirm-email",
        { method: "POST", body: z.object({ token: z.string().max(4096), password: z.string().max(1024) }) },
        async (ctx) => {
          const payload = await verifyJWT<{ email?: unknown; updateTo?: unknown }>(ctx.body.token, ctx.context.secret);
          const email = typeof payload?.email === "string" ? payload.email.toLowerCase() : null;
          if (!email || payload?.updateTo) throw new APIError("BAD_REQUEST", { code: "LINK_EXPIRED", message: WRONG_LINK });
          const found = await ctx.context.internalAdapter.findUserByEmail(email, { includeAccounts: true });
          if (!found) throw new APIError("BAD_REQUEST", { code: "LINK_EXPIRED", message: WRONG_LINK });
          const hash = found.accounts.find((a) => a.providerId === "credential")?.password;
          const right = hash ? await ctx.context.password.verify({ hash, password: ctx.body.password }) : false;
          if (!right) {
            throw new APIError("UNAUTHORIZED", {
              code: "WRONG_PASSWORD",
              message: translateText("That isn't the password this account was made with. Forgotten it? Create the account again with this email."),
            });
          }
          if (!found.user.emailVerified) await ctx.context.internalAdapter.updateUserByEmail(email, { emailVerified: true });
          return ctx.json({ email });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
