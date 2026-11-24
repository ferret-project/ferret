import { and, eq } from "drizzle-orm";
import { DEFAULT_CURRENCY } from "@ferret/shared";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Extensions } from "../app";
import type { Auth } from "../auth";
import type { Config } from "../config";
import { householdSetting, member, organization, user } from "../db/schema";
import type { Db, Deps } from "../ports";
import { type KeyHolder, keyFromHeaders, verifyKey } from "./api-keys";
import type { FileStore } from "./files";
import { ACCESS_TOKEN_PREFIX, type OAuthHolder, verifyOAuthToken } from "./oauth";
import { appWebCookieName, verifyAppWebSession } from "./app-web-session";
import { isServerAdmin } from "./server-admin";
import type { Caller } from "./inventory";
import { serverTimeZone } from "./household-time";
import { markActive, requireFeature } from "./plan";

type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export type AppEnv = {
  Variables: {
    deps: Deps;
    /** What another codebase added (app.ts Extensions): its hooks. */
    extensions: Extensions | undefined;
    db: Db;
    auth: Auth;
    config: Config;
    /** Encrypted photo/document storage (per-household keys). */
    files: FileStore;
    user: Session["user"];
    /** The sign-in session — absent when the request came with an API key. */
    session: Session["session"] | undefined;
    /** The API key the request came with, if any (it fixes the household, and may be read-only). */
    apiKey: KeyHolder["key"] | undefined;
    householdId: string;
    role: string;
    /** The household's time zone (lib/household-time.ts), for "today". */
    timeZone: string;
    /** The household's currency (ISO 4217). */
    currency: string;
  };
};

/**
 * Requires a signed-in user: a session cookie, an API key (`Authorization: Bearer ferret_…`), an app's OAuth access
 * token (`Bearer ferret_at_…`, lib/oauth.ts — e.g. the phone app), or the phone app's web screens' cookie
 * (lib/app-web-session.ts). A token or that cookie acts exactly like a key: one household, maybe read-only, never a real
 * sign-in. The cookie counts only when there's no real sign-in, so one planted in a browser can't take its place.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith(ACCESS_TOKEN_PREFIX)) {
    await actForApp(c, await verifyOAuthToken(c.var.db, bearer));
    return next();
  }
  const key = keyFromHeaders(c.req.raw.headers);
  if (key) {
    const holder = await verifyKey(c.var.auth, c.var.db, key);
    if (!holder) throw new HTTPException(401, { message: "Invalid or expired API key" });
    // A plan without API keys pauses them (kept, not deleted — they work again once it has them).
    await requireFeature({ deps: c.var.deps, householdId: holder.key.householdId }, "apiKeys");
    c.set("user", holder.user);
    c.set("apiKey", holder.key);
    c.set("session", undefined);
    return next();
  }
  const result = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (result) {
    c.set("user", result.user);
    c.set("session", result.session);
    return next();
  }
  const appCookie = getCookie(c, appWebCookieName(c.var.config));
  if (!appCookie) throw new HTTPException(401, { message: "Sign in required" });
  await actForApp(c, await verifyAppWebSession(c.var.db, appCookie));
  await next();
});

/** Acts for an app signed in with OAuth (its token, or its web screens' cookie): like an API key. */
async function actForApp(c: Context<AppEnv>, app: OAuthHolder | null) {
  const [owner] = app ? await c.var.db.select().from(user).where(eq(user.id, app.userId)) : [];
  if (!app || !owner) throw new HTTPException(401, { message: "Sign in again: this app's sign-in has ended" });
  await requireFeature({ deps: c.var.deps, householdId: app.householdId }, "apiKeys");
  c.set("user", owner);
  c.set("apiKey", { id: `oauth:${app.clientId}`, name: app.clientName, householdId: app.householdId, readOnly: app.readOnly });
  c.set("session", undefined);
}

/** For account settings (like managing API keys): a real sign-in, not a key. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.apiKey) throw new HTTPException(403, { message: "API keys can't manage account settings" });
  await next();
});

/**
 * Resolves the household for this request — the API key's household, or the
 * X-Household-Id header, or the session's active household — and checks the
 * user is (still) a member of it. Every inventory query below this point must
 * filter by c.var.householdId.
 */
export const requireHousehold = createMiddleware<AppEnv>(async (c, next) => {
  const requested = c.req.header("x-household-id");
  const keyHousehold = c.var.apiKey?.householdId;
  if (keyHousehold && requested && requested !== keyHousehold) {
    throw new HTTPException(403, { message: "This API key is for a different household" });
  }
  const householdId = keyHousehold ?? requested ?? c.var.session?.activeOrganizationId ?? undefined;
  if (!householdId) {
    throw new HTTPException(400, { message: "No household selected. Create or pick a household first." });
  }
  const role = await membership(c.var.db, householdId, c.var.user.id);
  if (!role) throw new HTTPException(403, { message: "Not a member of this household" });
  c.set("householdId", householdId);
  c.set("role", role);
  // Its time zone, and the last day it was used (lib/plan.ts) — one read, and a write at most once a day.
  const [setting] = await c.var.db
    .select({ timeZone: householdSetting.timeZone, currency: householdSetting.currency, lastActiveOn: householdSetting.lastActiveOn })
    .from(householdSetting)
    .where(eq(householdSetting.householdId, householdId));
  c.set("timeZone", setting?.timeZone ?? serverTimeZone());
  c.set("currency", setting?.currency ?? DEFAULT_CURRENCY);
  await markActive(c.var.db, householdId, setting?.lastActiveOn);
  await next();
});

/** `/me`'s household: its name, your role, and whether this sign-in can only look (a read-only key or app, a viewer). */
export async function householdAccess(db: Db, userId: string, householdId: string | null, readOnly: boolean) {
  if (!householdId) return null;
  const role = await membership(db, householdId, userId);
  if (!role) return null;
  const [found] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, householdId));
  return { id: householdId, name: found?.name ?? "", role, readOnly: readOnly || role === "viewer" };
}

/** The user's role in a household, or undefined if they're not in it. */
export async function membership(db: Db, householdId: string, userId: string) {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, householdId), eq(member.userId, userId)))
    .limit(1);
  return row?.role;
}

/** For the server's own settings (Settings → Server): the server admin, signed in (not with an API key). */
export const requireServerAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.apiKey) throw new HTTPException(403, { message: "API keys can't manage the server" });
  if (!(await isServerAdmin(c.var.db, c.var.user.id))) throw new HTTPException(403, { message: "Only the server admin can do this" });
  await next();
});

/** Blocks read-only roles and read-only API keys from writes. Better Auth roles: owner, admin, member — plus our own "viewer". */
export const requireWriter = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.role === "viewer") throw new HTTPException(403, { message: "Read-only access" });
  if (c.var.apiKey?.readOnly) throw new HTTPException(403, { message: "This API key is read-only" });
  await next();
});

/** The inventory service's view of this request. */
export const callerOf = (c: Context<AppEnv>): Caller => ({
  deps: c.var.deps,
  db: c.var.db,
  householdId: c.var.householdId,
  userId: c.var.user.id,
  timeZone: c.var.timeZone,
  currency: c.var.currency,
  via: c.var.apiKey ? "api" : "web",
  keyName: c.var.apiKey?.name ?? null,
});

/** Parses and validates a JSON body: 400 if it isn't JSON, 422 (with the issues) if it doesn't fit. */
export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const json = await req.json().catch(() => {
    throw new HTTPException(400, { message: "Body must be JSON" });
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "Invalid input", cause: parsed.error.issues });
  }
  return parsed.data;
}
