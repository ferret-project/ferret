/**
 * "Email me a sign-in link" — Better Auth's magic-link plugin, behind the same kind of front as password reset
 * (lib/password-reset.ts), and only when Ferret can send email:
 *
 * - Every request to /sign-in/magic-link gets the same answer and queues one job, whatever it holds — so it can't be
 *   used to find out who has an account.
 * - The job sends a link only to an account that exists, has confirmed its email and doesn't use two-step sign-in, and
 *   at most one every 10 minutes. It never makes an account (the plugin's sign-up is off): invitations stay the way in.
 * - A link works once, for 15 minutes, and is kept only as a hash. Opening one for an account that has turned on
 *   two-step sign-in since is refused — a link mustn't skip the second step.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { and, eq, gt, like } from "drizzle-orm";
import { z } from "zod";
import type { Auth } from "../auth";
import { user, verification } from "../db/schema";
import type { Db, JobHandler } from "../ports";

export const MAGIC_LINK_JOB = "auth.magic-link";
/** The one answer every request gets. */
export const MAGIC_LINK_ANSWER = { status: true };
/** How long a link works. */
export const MAGIC_LINK_TTL_S = 15 * 60;
const EVERY_MS = 10 * 60 * 1000;
/** Where the browser lands when a link didn't work, or was refused for two-step sign-in (the sign-in screen says so). */
export const MAGIC_LINK_FAILED = "/?signin-link=failed#/";
export const MAGIC_LINK_TWO_STEP = "/?signin-link=two-step#/";

/** How tokens are kept: a SHA-256, so the database never holds a working link (and the front can look one up). */
export async function hashToken(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The front: answer every browser request the same way, leave the work to a job; refuse links that would skip a code. */
export function magicLinkFront(db: Db, enqueue: (email: string) => Promise<void>) {
  return {
    id: "ferret-magic-link",
    hooks: {
      before: [
        {
          // Only requests from outside: the job calls the real endpoint server-side (no request).
          matcher: (ctx) => ctx.path === "/sign-in/magic-link" && Boolean(ctx.request),
          handler: createAuthMiddleware(async (ctx) => {
            const raw = (ctx.body as { email?: unknown } | undefined)?.email;
            await enqueue(typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 320) : "");
            return ctx.json(MAGIC_LINK_ANSWER);
          }),
        },
        {
          // Two-step sign-in turned on after the link went out: it doesn't get to skip the code.
          matcher: (ctx) => ctx.path === "/magic-link/verify",
          handler: createAuthMiddleware(async (ctx) => {
            const token = (ctx.query as { token?: unknown } | undefined)?.token;
            if (typeof token !== "string") return;
            const [row] = await db
              .select({ value: verification.value })
              .from(verification)
              .where(eq(verification.identifier, `magic-link:${await hashToken(token)}`));
            if (!row) return; // the plugin answers expired/unknown links itself
            const email = (JSON.parse(row.value) as { email?: string }).email;
            if (!email) return;
            const [account] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.email, email));
            if (account?.twoFactorEnabled) {
              await db.delete(verification).where(eq(verification.identifier, `magic-link:${await hashToken(token)}`));
              throw ctx.redirect(MAGIC_LINK_TWO_STEP);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** The job: send a link if there's an account that can use one, and none went out in the last 10 minutes. */
export function magicLinkJob(opts: { db: Db; auth: Auth; now?: () => number }): JobHandler {
  return async (payload) => {
    const { email } = payload as { email: string };
    if (!z.email().safeParse(email).success) return;
    const { db } = opts;
    const [account] = await db
      .select({ id: user.id, emailVerified: user.emailVerified, twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.email, email));
    if (!account?.emailVerified || account.twoFactorEnabled) return;
    const since = new Date((opts.now?.() ?? Date.now()) - EVERY_MS);
    const [recent] = await db
      .select({ id: verification.id })
      .from(verification)
      .where(and(like(verification.identifier, "magic-link:%"), like(verification.value, `%"email":${JSON.stringify(email)}%`), gt(verification.createdAt, since)))
      .limit(1);
    if (recent) return;
    // Better Auth makes the token and calls sendMagicLink (auth.ts), which emails the link.
    // The plugin is there only with email, so the API's type doesn't promise it.
    const api = opts.auth.api as unknown as { signInMagicLink: (req: { body: Record<string, string>; headers: Headers }) => Promise<unknown> };
    await api.signInMagicLink({
      body: { email, callbackURL: "/", errorCallbackURL: MAGIC_LINK_FAILED },
      headers: new Headers(),
    });
  };
}
