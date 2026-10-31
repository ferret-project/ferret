import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Extensions } from "../app";
import type { Auth } from "../auth";
import type { Config } from "../config";
import { householdSetting, member } from "../db/schema";
import type { Db, Deps } from "../ports";
import { type KeyHolder, keyFromHeaders, verifyKey } from "./api-keys";
import type { FileStore } from "./files";
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
  };
};

/** Requires a signed-in user: a session cookie, or an API key (`Authorization: Bearer ferret_…`). */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const key = keyFromHeaders(c.req.raw.headers);
  if (key) {
    const holder = await verifyKey(c.var.auth, c.var.db, key);
    if (!holder) throw new HTTPException(401, { message: "Invalid or expired API key" });
    // A plan without API keys pauses them (kept, not deleted — they work again once it has them).
    await requireFeature({ deps: c.var.deps, householdId: holder.key.householdId }, "apiKeys");
    c.set("user", holder.user);
    c.set("apiKey", holder.key);
    c.set("session", undefined);
  } else {
    const result = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
    if (!result) throw new HTTPException(401, { message: "Sign in required" });
    c.set("user", result.user);
    c.set("session", result.session);
  }
  await next();
});

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
    .select({ timeZone: householdSetting.timeZone, lastActiveOn: householdSetting.lastActiveOn })
    .from(householdSetting)
    .where(eq(householdSetting.householdId, householdId));
  c.set("timeZone", setting?.timeZone ?? serverTimeZone());
  await markActive(c.var.db, householdId, setting?.lastActiveOn);
  await next();
});

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
