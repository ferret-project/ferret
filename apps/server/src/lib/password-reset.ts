/**
 * "Forgot password?" — Better Auth's password reset, behind a front that can't
 * be used to find out who has an account:
 *
 * - Every request to /request-password-reset does the same thing, whatever it
 *   holds (an account's email, someone else's, or junk): it queues one job and
 *   answers "if an account uses that email, a link is on its way". Same
 *   answer, same work, so neither the reply nor its timing says anything.
 * - The job does the real work: if there's an account (and no link went to it in
 *   the last 10 minutes) it asks Better Auth for a reset token and emails the link.
 * - Better Auth's limiter covers both ends per address (3 requests a minute,
 *   5 resets a minute), and a reset signs out every session and clears the
 *   wrong-password count.
 *
 * It's there only when Ferret can send email (APPRISE_URL + MAIL_URL); without
 * that the endpoints are switched off and the sign-in screen doesn't offer it.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { and, eq, gt, like } from "drizzle-orm";
import { z } from "zod";
import type { Auth } from "../auth";
import type { Config } from "../config";
import { user, verification } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";

export const RESET_JOB = "auth.password-reset";
/** The one answer every reset request gets. */
export const RESET_ANSWER = { status: true, message: "If an account uses that email, a link to choose a new password is on its way." };
/** Better Auth's paths for it, switched off when Ferret can't send email. */
export const RESET_PATHS = ["/request-password-reset", "/reset-password", "/reset-password/:token"];
/** How long a reset link works. */
export const RESET_TTL_S = 60 * 60;
const RESET_EVERY_MS = 10 * 60 * 1000;

export const passwordResetEnabled = (deps: Pick<Deps, "notifier">, config: Pick<Config, "MAIL_URL">) =>
  Boolean(deps.notifier && config.MAIL_URL);

/** The front: answer every browser request the same way and leave the work to a job. */
export function passwordResetFront(enqueue: (email: string) => Promise<void>) {
  return {
    id: "ferret-password-reset",
    hooks: {
      before: [
        {
          // Only requests from outside: the job calls the real endpoint server-side (no request).
          matcher: (ctx) => ctx.path === "/request-password-reset" && Boolean(ctx.request),
          handler: createAuthMiddleware(async (ctx) => {
            const raw = (ctx.body as { email?: unknown } | undefined)?.email;
            await enqueue(typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 320) : "");
            return ctx.json(RESET_ANSWER);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** The job: if there's an account for the email (and no link in the last 10 minutes), send one. */
export function passwordResetJob(opts: { db: Db; auth: Auth; now?: () => number }): JobHandler {
  return async (payload) => {
    const { email } = payload as { email: string };
    if (!z.email().safeParse(email).success) return;
    const { db } = opts;
    const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!account) return;
    const since = new Date((opts.now?.() ?? Date.now()) - RESET_EVERY_MS);
    const [recent] = await db
      .select({ id: verification.id })
      .from(verification)
      .where(and(eq(verification.value, account.id), like(verification.identifier, "reset-password:%"), gt(verification.createdAt, since)))
      .limit(1);
    if (recent) return;
    // Better Auth makes the token and calls sendResetPassword (auth.ts), which emails the link.
    await opts.auth.api.requestPasswordReset({ body: { email } });
  };
}
