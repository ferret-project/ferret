/**
 * The sign-in guard: what happens after wrong passwords. Nothing ever locks an
 * account outright (anyone could lock you out by typing your email); instead,
 * counting wrong passwords for an email from one address:
 *
 * - 1–4: nothing.
 * - 5th: that address waits 1 minute; 6th: 5 minutes.
 * - Once the 5-minute wait is over, no more waiting, but every try from there must carry a solved
 *   ALTCHA proof-of-work check (self-hosted, no third-party captcha; ≈1 s in the
 *   browser, ≈4 s from 15 wrong passwords, ≈12 s from 30). Challenges are
 *   single-use and expire in 5 minutes.
 * - Guessing from many addresses: once an email has 10 wrong passwords from
 *   anywhere, every address needs the check. One address trying many emails:
 *   after 20 it needs the check for all of them.
 * - "Email me a link to sign in again" (unlock) clears the count for an email.
 * - At 5, 20 and 100 wrong passwords the owner is told (push and Apprise).
 *
 * Counts cover the last 24 hours, and start again after a successful sign-in or
 * an unlock. Wrong two-step codes are the two-factor plugin's business (it locks
 * the second step after 10).
 */
import { createChallenge, randomInt, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/web/pbkdf2";
import type { Challenge, Payload } from "altcha-lib/types";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getIP, isAPIError } from "better-auth/api";
import { and, count, eq, gt, isNull, lt, max } from "drizzle-orm";
import { signIn, signInFailure, signInUnlock, spentChallenge, user } from "../db/schema";
import type { Db } from "../ports";
import { hashToken } from "./calendar";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an address waits after its 5th and 6th wrong password for an email; once the 5-minute wait is over, the check. */
const WAITS_S = { 5: 60, 6: 5 * 60 } as Record<number, number>;
const CHECK_FROM = 6;
/** Wrong passwords for an email from anywhere, or from one address for any email, before every try needs the check. */
const EMAIL_CHECK_FROM = 10;
const ADDRESS_CHECK_FROM = 20;
/** Failure counts that tell the account's owner. */
const ALERT_AT = new Set([5, 20, 100]);
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Header the web app sends a solved challenge in (base64 JSON of { challenge, solution }). */
export const CHALLENGE_HEADER = "x-altcha";

/** How much work each level asks for (PBKDF2 cost × counter range), roughly 1 s, 4 s and 12 s on a laptop. */
const LEVELS = {
  1: { cost: 2_000, counter: [4_000, 8_000] },
  2: { cost: 2_000, counter: [15_000, 30_000] },
  3: { cost: 4_000, counter: [25_000, 50_000] },
} as const;
type Level = 0 | keyof typeof LEVELS;

export interface Guard {
  /** 0: no check needed. */
  level: Level;
  /** Seconds this address must still wait (0: go ahead). */
  waitSeconds: number;
}

export interface FailureAlert {
  userId: string;
  failures: number;
  ipAddress: string | null;
}

/** Where to start counting: a day ago, the account's last successful sign-in, or the last unlock — the latest. */
async function countingFrom(db: Db, email: string, userId: string | undefined, now: number) {
  const [[success], [unlock]] = await Promise.all([
    userId ? db.select({ at: max(signIn.createdAt) }).from(signIn).where(eq(signIn.userId, userId)) : [undefined],
    db.select({ at: max(signInUnlock.usedAt) }).from(signInUnlock).where(eq(signInUnlock.email, email)),
  ]);
  const times = [now - DAY_MS, success?.at?.getTime() ?? 0, unlock?.at?.getTime() ?? 0];
  return new Date(Math.max(...times));
}

/** Check difficulty for this many wrong passwords. */
const levelFor = (n: number): Level => (n >= 30 ? 3 : n >= 15 ? 2 : 1);

const sameAddress = (ip: string | null) => (ip ? eq(signInFailure.ipAddress, ip) : isNull(signInFailure.ipAddress));

/** What a sign-in for this email from this address has to go through right now. */
export async function guardFor(db: Db, email: string, ip: string | null, now = Date.now()): Promise<Guard> {
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  const since = await countingFrom(db, email, account?.id, now);
  const recent = and(eq(signInFailure.email, email), gt(signInFailure.createdAt, since));
  const [[forEmail], [fromHere], [fromAddress]] = await Promise.all([
    db.select({ n: count() }).from(signInFailure).where(recent),
    db
      .select({ n: count(), last: max(signInFailure.createdAt) })
      .from(signInFailure)
      .where(and(recent, sameAddress(ip))),
    // One address trying many emails (password spraying).
    db
      .select({ n: count() })
      .from(signInFailure)
      .where(and(sameAddress(ip), gt(signInFailure.createdAt, new Date(now - DAY_MS)))),
  ]);
  const hereN = fromHere?.n ?? 0;
  const emailN = forEmail?.n ?? 0;
  const addressN = fromAddress?.n ?? 0;

  // The waits, for this address: after the 5th and 6th wrong password.
  const wait = WAITS_S[hereN];
  if (wait && fromHere?.last) {
    const waitSeconds = Math.ceil(wait - (now - fromHere.last.getTime()) / 1000);
    if (waitSeconds > 0) return { level: 0, waitSeconds };
  }
  // After the long wait (or under attack from many addresses, or one address spraying): the check.
  const level =
    hereN >= CHECK_FROM || emailN >= EMAIL_CHECK_FROM || addressN >= ADDRESS_CHECK_FROM ? levelFor(Math.max(hereN, emailN, addressN)) : 0;
  return { level, waitSeconds: 0 };
}

/** Records a wrong password; returns an alert for the account's owner when the count reaches a threshold. */
export async function recordFailure(
  db: Db,
  attempt: { email: string; ipAddress: string | null; userAgent: string | null },
  now = Date.now(),
): Promise<FailureAlert | null> {
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, attempt.email));
  await db.insert(signInFailure).values({ ...attempt, userId: account?.id ?? null, createdAt: new Date(now) });
  await db.delete(signInFailure).where(lt(signInFailure.createdAt, new Date(now - 30 * DAY_MS)));
  if (!account) return null;
  const since = await countingFrom(db, attempt.email, account.id, now);
  const [recent] = await db
    .select({ n: count() })
    .from(signInFailure)
    .where(and(eq(signInFailure.userId, account.id), gt(signInFailure.createdAt, since)));
  const failures = recent?.n ?? 0;
  return ALERT_AT.has(failures) ? { userId: account.id, failures, ipAddress: attempt.ipAddress } : null;
}

// ── ALTCHA ──────────────────────────────────────────────────────────────────
/** The challenges' HMAC key, kept apart from AUTH_SECRET itself. */
async function challengeKey(authSecret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ferret-altcha:${authSecret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSignInChallenge(authSecret: string, level: Exclude<Level, 0>): Promise<Challenge> {
  const { cost, counter } = LEVELS[level];
  return createChallenge({
    algorithm: "PBKDF2/SHA-256",
    cost,
    counter: randomInt(counter[0], counter[1]),
    deriveKey,
    hmacSignatureSecret: await challengeKey(authSecret),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    data: { level },
  });
}

/** True if the header holds a solved, unexpired, unused challenge of at least this level. Spends it. */
export async function spendChallenge(db: Db, authSecret: string, header: string | null, level: Exclude<Level, 0>) {
  if (!header || header.length > 4_000) return false;
  let payload: Payload;
  try {
    payload = JSON.parse(atob(header)) as Payload;
  } catch {
    return false;
  }
  if (!payload?.challenge?.signature || !payload.solution) return false;
  if (Number(payload.challenge.parameters.data?.level ?? 0) < level) return false;
  const result = await verifySolution({
    challenge: payload.challenge,
    solution: payload.solution,
    deriveKey,
    hmacSignatureSecret: await challengeKey(authSecret),
  });
  if (!result.verified) return false;
  await db.delete(spentChallenge).where(lt(spentChallenge.expiresAt, new Date()));
  const spent = await db
    .insert(spentChallenge)
    .values({ signature: payload.challenge.signature, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) })
    .onConflictDoNothing()
    .returning({ signature: spentChallenge.signature });
  return spent.length === 1;
}

// ── The Better Auth plugin ──────────────────────────────────────────────────
const SIGN_IN = "/sign-in/email";

const minutes = (s: number) => (s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} ${Math.ceil(s / 60) === 1 ? "minute" : "minutes"}`);

export function signInGuard(opts: { db: Db; authSecret: string; onAlert?: (alert: FailureAlert) => void | Promise<void> }) {
  const { db, authSecret } = opts;
  return {
    id: "ferret-sign-in-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN,
          handler: createAuthMiddleware(async (ctx) => {
            const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
            if (!email || !ctx.request) return;
            const ip = getIP(ctx.request, ctx.context.options);
            const guard = await guardFor(db, email, ip);
            if (guard.waitSeconds > 0) {
              throw new APIError("TOO_MANY_REQUESTS", {
                code: "SIGN_IN_BACKOFF",
                message: `Too many wrong passwords from here. Try again in ${minutes(guard.waitSeconds)}.`,
                retryAfter: guard.waitSeconds,
              });
            }
            if (guard.level > 0) {
              const level = guard.level as Exclude<Level, 0>;
              if (!(await spendChallenge(db, authSecret, ctx.request.headers.get(CHALLENGE_HEADER), level))) {
                throw new APIError("FORBIDDEN", {
                  code: "CHALLENGE_REQUIRED",
                  message: "One more check before signing in.",
                  challenge: await createSignInChallenge(authSecret, level),
                });
              }
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN,
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!isAPIError(returned) || returned.body?.code !== "INVALID_EMAIL_OR_PASSWORD" || !ctx.request) return;
            const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
            const alert = await recordFailure(db, {
              email,
              ipAddress: getIP(ctx.request, ctx.context.options),
              userAgent: ctx.request.headers.get("user-agent"),
            });
            if (alert) await opts.onAlert?.(alert);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

// ── Unlock links ("email me a link to sign in again") ──────────────────────
const UNLOCK_TTL_MS = 30 * 60 * 1000;
/** At most one link per email this often, so asking for links can't flood someone. */
const UNLOCK_EVERY_MS = 10 * 60 * 1000;

/** A new one-time unlock token for this email, or null if one was made in the last 10 minutes. */
export async function createUnlock(db: Db, email: string, now = Date.now()) {
  const [recent] = await db
    .select({ id: signInUnlock.id })
    .from(signInUnlock)
    .where(and(eq(signInUnlock.email, email), gt(signInUnlock.createdAt, new Date(now - UNLOCK_EVERY_MS))))
    .limit(1);
  if (recent) return null;
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  await db.delete(signInUnlock).where(lt(signInUnlock.expiresAt, new Date(now - DAY_MS)));
  await db.insert(signInUnlock).values({
    email,
    tokenHash: await hashToken(token),
    createdAt: new Date(now),
    expiresAt: new Date(now + UNLOCK_TTL_MS),
  });
  return token;
}

/** Uses an unlock link: clears the count for its email. False if it's unknown, used or expired. */
export async function useUnlock(db: Db, token: string, now = Date.now()) {
  const used = await db
    .update(signInUnlock)
    .set({ usedAt: new Date(now) })
    .where(
      and(eq(signInUnlock.tokenHash, await hashToken(token)), isNull(signInUnlock.usedAt), gt(signInUnlock.expiresAt, new Date(now))),
    )
    .returning({ email: signInUnlock.email });
  return used.length === 1;
}

/** Starts the count again for an email (after a password reset), as using an unlock link does. */
export async function clearFailures(db: Db, email: string, now = Date.now()) {
  await db.insert(signInUnlock).values({
    email,
    tokenHash: await hashToken(crypto.randomUUID()),
    createdAt: new Date(now),
    expiresAt: new Date(now),
    usedAt: new Date(now),
  });
}
