/**
 * Whether anyone uses the public demo: counts of what visitors
 * do, nothing about who they are or their things — an event name and, for a visit, where the link came from (`?ref=`).
 * `deps.analytics` is the demo's own counter (the Analytics port); a home Ferret has
 * none, and every count is a no-op. Kept outside the database, so the nightly reset doesn't touch it.
 */
import { createMiddleware } from "hono/factory";
import type { Analytics, Deps } from "../ports";
import type { AppEnv } from "./context";

export const ANALYTICS_EVENTS = [
  "visit",
  "demo.sign_in",
  "demo.sign_up",
  "sign_in",
  "item.add",
  "photo.analyzed",
  "search",
  "ask",
  "api_key.create",
  "mcp.call",
  "install",
  "return.d1",
  "return.d7",
  "self_host.click",
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** What the browser may count itself (POST /api/v1/usage): the rest are counted by the server where they happen. */
export const BROWSER_EVENTS = ["visit", "install", "return.d1", "return.d7", "self_host.click"] as const satisfies readonly AnalyticsEvent[];

/** A `?ref=` as given ("github", "example.com"…), or "other": never free text from a stranger in the counts. */
export const cleanRef = (ref: string | null | undefined) => (ref ? (/^[a-z0-9._-]{1,40}$/i.test(ref) ? ref.toLowerCase() : "other") : undefined);

/** Counts one event — never fails the request it's part of. */
export function countEvent(deps: Pick<Deps, "analytics">, event: AnalyticsEvent, ref?: string) {
  try {
    deps.analytics?.count(event, ref);
  } catch {
    // a count is never worth an error
  }
}

/** Sign-ins and sign-ups (Better Auth's endpoints): counted once they've worked, the shared demo account apart. */
export const countSignIns = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.deps.analytics) return next();
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => null)) as { email?: unknown } | null;
  await next();
  if (c.res.status !== 200) return;
  if (c.req.path.endsWith("/sign-up/email")) return countEvent(c.var.deps, "demo.sign_up");
  const shared = typeof body?.email === "string" && body.email.trim().toLowerCase() === c.var.config.DEMO_EMAIL.toLowerCase();
  countEvent(c.var.deps, shared ? "demo.sign_in" : "sign_in");
});

export type { Analytics };
