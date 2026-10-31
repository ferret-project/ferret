/**
 * "Are you a person?" on sign-up, by a Turnstile widget — for a server where anyone can make an account (and
 * so have a confirmation email sent to any address). Only with TURNSTILE_SITE_KEY + TURNSTILE_SECRET; a home Ferret
 * runs without it. The browser gets a token from the widget and sends it as X-Turnstile-Token; the server redeems it
 * once at siteverify and lets the sign-up through only if it passed, for this action, on one of our own hostnames.
 */
import { and, like, lt } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Config } from "../config";
import { serverSetting } from "../db/schema";
import type { HumanCheck } from "../ports";
import type { AppEnv } from "./context";

export const TURNSTILE_HEADER = "X-Turnstile-Token";
const SIGN_UP_ACTION = "signup";
/** Where the widget's script and frame come from (the CSP allows it only when the check is on). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const SITEVERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

export class TurnstileCheck implements HumanCheck {
  constructor(
    private readonly secret: string,
    // Called through a wrapper: some runtimes' fetch, kept as a property and called as a method, throws "Illegal invocation".
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async verify(token: string, ip?: string) {
    const res = await this.fetcher(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret: this.secret, response: token, ...(ip && { remoteip: ip }) }),
    });
    if (!res.ok) throw new Error(`Turnstile siteverify answered ${res.status}`);
    const out = (await res.json()) as { success?: boolean; action?: string; hostname?: string; challenge_ts?: string };
    const issuedAt = out.challenge_ts ? Date.parse(out.challenge_ts) : NaN;
    return { success: out.success === true, action: out.action, hostname: out.hostname, issuedAt: Number.isNaN(issuedAt) ? undefined : issuedAt };
  }
}

/** The hostnames a token may come from: TURNSTILE_HOSTNAMES, or PUBLIC_URL's. */
export const turnstileHostnames = (config: Config) =>
  new Set(
    (config.TURNSTILE_HOSTNAMES ?? new URL(config.PUBLIC_URL).hostname)
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );

/** A token is good for 5 minutes after the check (Turnstile's own limit). */
const TOKEN_LIFE_MS = 5 * 60_000;
/** Redeemed tokens (their SHA-256) are remembered this long, so none is used twice. */
const USED = "turnstile.used.";
const REMEMBER_MS = 10 * 60_000;

/**
 * Marks the token used; false if it already was. Siteverify should refuse a token seen before, but in testing it
 * answered success to the same one again and again — so Ferret keeps its own record (atomic: the key is the row's).
 */
async function firstUse(db: AppEnv["Variables"]["db"], token: string, now = Date.now()) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const key = USED + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const stored = await db.insert(serverSetting).values({ key, value: "1" }).onConflictDoNothing().returning({ key: serverSetting.key });
  await db.delete(serverSetting).where(and(like(serverSetting.key, `${USED}%`), lt(serverSetting.updatedAt, new Date(now - REMEMBER_MS))));
  return stored.length === 1;
}

const refused = (message: string) => Response.json({ code: "HUMAN_CHECK_FAILED", message }, { status: 403 });

/** Sign-up (Better Auth's /sign-up/email) only after a passed check, when there's one to pass. Fails closed. */
export const signUpHumanCheck = createMiddleware<AppEnv>(async (c, next) => {
  const check = c.var.deps.humanCheck;
  if (!check) return next();
  const token = c.req.header(TURNSTILE_HEADER);
  if (!token || token.length > 2048) return refused("Tick the \"I'm a person\" check first.");
  let result: Awaited<ReturnType<HumanCheck["verify"]>>;
  try {
    result = await check.verify(token, c.req.header("cf-connecting-ip"));
  } catch {
    return refused("Couldn't check you're a person just now — try again in a moment.");
  }
  const hostnames = turnstileHostnames(c.var.config);
  const fresh = result.issuedAt !== undefined && Date.now() - result.issuedAt <= TOKEN_LIFE_MS;
  if (!result.success || !fresh || result.action !== SIGN_UP_ACTION || !result.hostname || !hostnames.has(result.hostname.toLowerCase())) {
    return refused("That check didn't pass — try it again.");
  }
  if (!(await firstUse(c.var.db, token))) return refused("That check was used already — tick it again.");
  await next();
});
