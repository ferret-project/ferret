/**
 * The phone app's web screens: some of the app's screens are Ferret's own web pages in a web view, and they need the
 * app's sign-in — with the app's limits (one household, maybe read-only, never a real sign-in), not a full one.
 *
 * A one-time handoff, so the app's access token never sits in the web view:
 * 1. The app, with its access token in the header, asks `POST /api/v1/app/web-session` and gets a link with a code
 *    (random, kept hashed, good once and for a minute).
 * 2. The web view opens it (`GET /app/enter`): the code is swapped for a cookie Ferret sets itself — HttpOnly,
 *    SameSite=Strict, and on HTTPS named `__Host-…` so no sibling site on the same domain can plant one.
 * 3. `requireUser` (lib/context.ts) reads the cookie only when there's no real sign-in, and acts for the app exactly as
 *    for its access token. It stops when the app's approval is removed (Disconnect), the person leaves the household,
 *    the app signs out (`DELETE /api/v1/app/web-session`), or after 30 days.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Config } from "../config";
import { appWebSession, oauthClient, oauthConsent } from "../db/schema";
import type { Db } from "../ports";
import { hashOAuthToken, type OAuthHolder, oauthHolder } from "./oauth";

const CODE_TTL_MS = 60 * 1000;
export const APP_WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** On HTTPS the `__Host-` prefix: the browser takes it only from this host itself, Secure, for the whole site. */
export function appWebCookieName(config: Pick<Config, "PUBLIC_URL">) {
  return isHttps(config) ? "__Host-ferret_app" : "ferret_app";
}

export function isHttps(config: Pick<Config, "PUBLIC_URL">) {
  return new URL(config.PUBLIC_URL).protocol === "https:";
}

function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Step 1: a one-time code for this app's approval. */
export async function startAppWebSession(db: Db, app: OAuthHolder, now = Date.now()) {
  const code = secret();
  await db.insert(appWebSession).values({
    codeHash: await hashOAuthToken(code),
    userId: app.userId,
    clientId: app.clientId,
    referenceId: app.referenceId,
    expiresAt: new Date(now + CODE_TTL_MS),
  });
  return { code, expiresAt: new Date(now + APP_WEB_SESSION_TTL_MS) };
}

/** Step 2: the code swapped for the cookie's value — once (one statement, so two tries can't both win). Null if it isn't good. */
export async function enterAppWebSession(db: Db, code: string, now = Date.now()) {
  const token = secret();
  const expiresAt = new Date(now + APP_WEB_SESSION_TTL_MS);
  const [row] = await db
    .update(appWebSession)
    .set({ codeHash: null, tokenHash: await hashOAuthToken(token), expiresAt })
    .where(and(eq(appWebSession.codeHash, await hashOAuthToken(code)), isNull(appWebSession.tokenHash), gt(appWebSession.expiresAt, new Date(now))))
    .returning({ id: appWebSession.id });
  return row ? { token, expiresAt } : null;
}

/** Step 3: the cookie → who it acts for, or null (unknown, ended, app disabled, approval removed, left the household). */
export async function verifyAppWebSession(db: Db, token: string): Promise<OAuthHolder | null> {
  const [row] = await db
    .select({
      userId: appWebSession.userId,
      clientId: appWebSession.clientId,
      referenceId: appWebSession.referenceId,
      expiresAt: appWebSession.expiresAt,
      clientName: oauthClient.name,
      disabled: oauthClient.disabled,
    })
    .from(appWebSession)
    .innerJoin(oauthClient, eq(oauthClient.clientId, appWebSession.clientId))
    // The approval must still be there, as for the app's tokens: Disconnect removes it.
    .innerJoin(
      oauthConsent,
      and(eq(oauthConsent.clientId, appWebSession.clientId), eq(oauthConsent.userId, appWebSession.userId), eq(oauthConsent.referenceId, appWebSession.referenceId)),
    )
    .where(eq(appWebSession.tokenHash, await hashOAuthToken(token)));
  if (!row || row.disabled || row.expiresAt <= new Date()) return null;
  return oauthHolder(db, row);
}

/** Every web-screen sign-in of one approval: the app signing out, or Disconnect. */
export async function endAppWebSessions(db: Db, grant: { clientId: string; userId: string; referenceId: string }) {
  await db
    .delete(appWebSession)
    .where(and(eq(appWebSession.clientId, grant.clientId), eq(appWebSession.userId, grant.userId), eq(appWebSession.referenceId, grant.referenceId)));
}
