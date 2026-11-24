/**
 * Signing in to Ferret from an app (OAuth 2.1 for /mcp) — claude.ai's custom connectors, ChatGPT, and other MCP
 * clients that want "Sign in to Ferret" instead of a pasted API key.
 *
 * Better Auth's oauth-provider plugin is the authorization server (issuer PUBLIC_URL/api/auth): authorization code +
 * PKCE, dynamic client registration (public clients), refresh tokens that rotate. Ferret adds what its API keys
 * already have:
 * - **One household, maybe read-only.** Every time an app asks, the person picks on Ferret's own screen (#/connect,
 *   the plugin's post-login step); the choice becomes the grant's reference, `<householdId>:read|write`. Consent is
 *   remembered per reference, so choosing read-only never reuses an earlier read-write consent.
 * - **Checked on every request** (`verifyOAuthToken`): membership again, viewers read-only — like a key. Not the
 *   plugin's own validator, which ties a token to the browser session that approved it: signing out of the web app
 *   would cut the app off.
 * - Tokens are opaque (no signing keys to look after) and stored hashed, so a revoked one stops at once.
 */
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { and, eq, gt, lt, notExists, or, sql } from "drizzle-orm";
import type { Config } from "../config";
import { appWebSession, oauthAccessToken, oauthChoice, oauthClient, oauthConsent, oauthRefreshToken } from "../db/schema";
import type { Db } from "../ports";
import { membership } from "./context";

/** What an app can ask for: Ferret itself (everything a key could do), and staying connected. */
export const OAUTH_SCOPES = ["ferret", "offline_access"] as const;
export const ACCESS_TOKEN_PREFIX = "ferret_at_";
export const REFRESH_TOKEN_PREFIX = "ferret_rt_";
/** How long the household picked on #/connect is good for: the rest of the OAuth flow takes seconds. */
const CHOICE_TTL_MS = 10 * 60 * 1000;
/** Access tokens are short; the refresh token (which rotates on every use) keeps a connection going. */
const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 60;

/** The web app's screens for the flow (hash routes: the plugin adds `?<signed query>` after them). */
export const OAUTH_PAGES = { signIn: "/#/connect/sign-in", choose: "/#/connect", finish: "/#/connect/finish" } as const;

export function oauthReference(householdId: string, readOnly: boolean) {
  return `${householdId}:${readOnly ? "read" : "write"}`;
}

export function parseReference(reference: string | null | undefined): { householdId: string; readOnly: boolean } | null {
  const match = reference?.match(/^(.+):(read|write)$/);
  return match ? { householdId: match[1]!, readOnly: match[2] === "read" } : null;
}

/** How tokens, refresh tokens and codes are kept: SHA-256, base64url — the plaintext is never stored. */
export async function hashOAuthToken(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  let s = "";
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** /mcp, the resource every token is for. */
export function mcpResource(config: Pick<Config, "PUBLIC_URL">) {
  return `${new URL(config.PUBLIC_URL).origin}/mcp`;
}

/** The household this browser session just picked on #/connect (for `clientId`, if given), if fresh and they're still in it. */
export async function currentChoice(db: Db, sessionId: string, userId: string, clientId?: string) {
  const [row] = await db
    .select()
    .from(oauthChoice)
    .where(and(eq(oauthChoice.sessionId, sessionId), eq(oauthChoice.userId, userId), gt(oauthChoice.createdAt, new Date(Date.now() - CHOICE_TTL_MS))));
  if (!row || (clientId !== undefined && row.clientId !== clientId)) return null;
  const role = await membership(db, row.householdId, userId);
  if (!role) return null;
  return { householdId: row.householdId, readOnly: row.readOnly || role === "viewer", clientId: row.clientId };
}

/** Remembers what was picked on #/connect for this browser session (the next step of the flow reads it). */
export async function saveChoice(db: Db, choice: { sessionId: string; userId: string; clientId: string; householdId: string; readOnly: boolean }) {
  const values = { ...choice, createdAt: new Date() };
  await db
    .insert(oauthChoice)
    .values(values)
    .onConflictDoUpdate({
      target: oauthChoice.sessionId,
      set: { userId: values.userId, clientId: values.clientId, householdId: values.householdId, readOnly: values.readOnly, createdAt: values.createdAt },
    });
}

/**
 * Better Auth's steps after #/connect (`/oauth2/continue`, `/oauth2/consent`) carry the app's signed request: they're
 * refused unless this browser session picked a household for that same app, on #/connect, minutes ago. So a choice made
 * for one app can never approve another, and nothing is approved without Allow.
 */
export function choiceGuard(db: Db) {
  return {
    id: "ferret-oauth-choice",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/continue" || ctx.path === "/oauth2/consent",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { accept?: unknown; oauth_query?: unknown } | undefined;
            // Cancel needs no choice: it only sends the app away with access_denied.
            if (ctx.path === "/oauth2/consent" && body?.accept !== true) return;
            const session = await getSessionFromCtx(ctx);
            const clientId = new URLSearchParams(typeof body?.oauth_query === "string" ? body.oauth_query : "").get("client_id");
            if (!session || !clientId || !(await currentChoice(db, session.session.id, session.user.id, clientId))) {
              throw new APIError("FORBIDDEN", { message: "Pick a household for this app on Ferret's Connect an app screen first" });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** Better Auth's endpoints Ferret doesn't use: client admin (apps register themselves), OIDC, introspection. */
export const OAUTH_DISABLED_PATHS = [
  "/admin/oauth2/create-client",
  "/admin/oauth2/update-client",
  "/admin/oauth2/resources",
  "/admin/oauth2/resources/:identifier",
  "/admin/oauth2/resources/:identifier/clients/:client_id",
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/client/rotate-secret",
  "/oauth2/client/rotate-keys",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  "/oauth2/introspect",
  "/oauth2/userinfo",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
  "/oauth2/public-client-prelogin",
  "/.well-known/openid-configuration",
];

/** The authorization server, as a Better Auth plugin. */
export function oauthPlugin(db: Db, config: Config) {
  return oauthProvider({
    scopes: [...OAUTH_SCOPES],
    clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    // claude.ai, ChatGPT and the others register themselves (RFC 7591). Public clients only: no secrets to keep.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Signed-in people don't make clients through Better Auth's endpoints (they're switched off too).
    clientPrivileges: () => false,
    disableJwtPlugin: true,
    storeTokens: { hash: (token) => hashOAuthToken(token) },
    prefix: { opaqueAccessToken: ACCESS_TOKEN_PREFIX, refreshToken: REFRESH_TOKEN_PREFIX },
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_S,
    refreshTokenExpiresIn: REFRESH_TOKEN_TTL_S,
    // A client that retries a refresh (a dropped reply) gets the same answer for a minute, not a revoked family.
    refreshTokenReuseInterval: 60,
    // No `resources`: the plugin would seed them in its startup (a database write Better Auth's whole context waits on)
    // — on Workers, a startup cut short with its request left every later sign-in check hanging (2026.11.18).
    // Without them a token is for any resource, and /mcp is the only one.
    enforcePerClientResources: false,
    loginPage: OAUTH_PAGES.signIn,
    consentPage: OAUTH_PAGES.finish,
    postLogin: {
      page: OAUTH_PAGES.choose,
      // Every new request shows #/connect; coming back from it (isContinuation), the pick must be there.
      shouldRedirect: async ({ session, user, isContinuation }) => !isContinuation || !(await currentChoice(db, session.id, user.id)),
      consentReferenceId: async ({ session, user }) => {
        const choice = await currentChoice(db, session.id, user.id);
        if (!choice) throw new APIError("FORBIDDEN", { message: "Pick a household for this app first" });
        return oauthReference(choice.householdId, choice.readOnly);
      },
    },
  });
}

export type OAuthHolder = {
  userId: string;
  householdId: string;
  role: string;
  readOnly: boolean;
  clientId: string;
  /** What the app calls itself (its own claim, from registering). */
  clientName: string;
  /** Its approval's reference (`<householdId>:read|write`). */
  referenceId: string;
};

/** A `ferret_at_…` access token → who it acts for, or null (unknown, expired, revoked, app disabled, left the household). */
export async function verifyOAuthToken(db: Db, token: string): Promise<OAuthHolder | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const hashed = await hashOAuthToken(token.slice(ACCESS_TOKEN_PREFIX.length));
  const [row] = await db
    .select({
      userId: oauthAccessToken.userId,
      clientId: oauthAccessToken.clientId,
      referenceId: oauthAccessToken.referenceId,
      scopes: oauthAccessToken.scopes,
      expiresAt: oauthAccessToken.expiresAt,
      revoked: oauthAccessToken.revoked,
      clientName: oauthClient.name,
      disabled: oauthClient.disabled,
    })
    .from(oauthAccessToken)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    // The approval must still be there: Disconnect removes it, so even a token minted afterwards from a code issued
    // just before is refused.
    .innerJoin(
      oauthConsent,
      and(
        eq(oauthConsent.clientId, oauthAccessToken.clientId),
        eq(oauthConsent.userId, oauthAccessToken.userId),
        eq(oauthConsent.referenceId, oauthAccessToken.referenceId),
      ),
    )
    .where(eq(oauthAccessToken.token, hashed));
  if (!row?.userId || row.revoked || row.disabled || !row.expiresAt || row.expiresAt <= new Date()) return null;
  const scopes = scopeList(row.scopes);
  if (!scopes.includes("ferret")) return null;
  return oauthHolder(db, { userId: row.userId, clientId: row.clientId, clientName: row.clientName, referenceId: row.referenceId });
}

/**
 * Who an approved app acts for (its approval already found): the household in its reference, if they're still in it;
 * read-only when chosen, or when they're a viewer. Shared with the app's web screens (lib/app-web-session.ts).
 */
export async function oauthHolder(
  db: Db,
  grant: { userId: string; clientId: string; clientName: string | null; referenceId: string | null },
): Promise<OAuthHolder | null> {
  const reference = parseReference(grant.referenceId);
  if (!reference) return null;
  const role = await membership(db, reference.householdId, grant.userId);
  if (!role) return null;
  return {
    userId: grant.userId,
    householdId: reference.householdId,
    role,
    readOnly: reference.readOnly || role === "viewer",
    clientId: grant.clientId,
    clientName: grant.clientName ?? "An app",
    referenceId: grant.referenceId!,
  };
}

/** Scopes as Better Auth stores them (a JSON array, or space-separated in older rows). */
export function scopeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // space-separated
  }
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Daily (jobs/purge.ts): picks from #/connect older than a day, access and refresh tokens a week past expiring or
 * being revoked, the app's web-screen sign-ins and codes that ended, and apps that registered themselves but nobody
 * approved within a week (registration is open, so anything could register).
 */
export async function purgeOAuth(db: Db, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const weekAgo = new Date(now - 7 * day);
  const choices = await db.delete(oauthChoice).where(lt(oauthChoice.createdAt, new Date(now - day))).returning({ id: oauthChoice.sessionId });
  const access = await db
    .delete(oauthAccessToken)
    .where(or(lt(oauthAccessToken.expiresAt, weekAgo), lt(oauthAccessToken.revoked, weekAgo)))
    .returning({ id: oauthAccessToken.id });
  const refresh = await db
    .delete(oauthRefreshToken)
    .where(or(lt(oauthRefreshToken.expiresAt, weekAgo), lt(oauthRefreshToken.revoked, weekAgo)))
    .returning({ id: oauthRefreshToken.id });
  // The phone app's web screens (lib/app-web-session.ts): codes never swapped, and sign-ins that ended.
  const webSessions = await db.delete(appWebSession).where(lt(appWebSession.expiresAt, new Date(now))).returning({ id: appWebSession.id });
  const apps = await db
    .delete(oauthClient)
    .where(
      and(
        lt(oauthClient.createdAt, weekAgo),
        notExists(db.select({ one: sql`1` }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthClient.clientId))),
        notExists(db.select({ one: sql`1` }).from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, oauthClient.clientId))),
      ),
    )
    .returning({ id: oauthClient.id });
  return choices.length + access.length + refresh.length + webSessions.length + apps.length;
}

/** A registration (RFC 7591) whose redirect addresses are all http loopback, marked `application_type: native` unless it says. */
export function loopbackIsNative(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
  const registration = parsed as { redirect_uris?: unknown; application_type?: unknown };
  const uris = registration.redirect_uris;
  if (registration.application_type !== undefined || !Array.isArray(uris) || uris.length === 0) return body;
  const loopback = uris.every((uri) => {
    try {
      const url = new URL(String(uri));
      return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    } catch {
      return false;
    }
  });
  return loopback ? JSON.stringify({ ...registration, application_type: "native" }) : body;
}
