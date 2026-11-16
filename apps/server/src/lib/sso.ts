/**
 * Single sign-on for a self-hosted Ferret (docs: hosting/single-sign-on).
 *
 * - **OpenID Connect** (OIDC_*): Better Auth's generic OAuth plugin with the provider's discovery document. People are
 *   known by the provider's `sub` (an `account` row), so a changed email is still the same person; the first sign-in
 *   links to an existing account with the same, provider-verified email. If the provider is down when Ferret starts,
 *   the plugin tries discovery again on the next sign-in instead of giving up. Sign-up follows Ferret's own rules
 *   (ALLOW_SIGNUP, invitations) — the database hook in auth.ts checks every account made.
 * - **Trusted headers** (TRUSTED_HEADER_*): a forward-auth proxy (Authelia, Authentik…) has already signed the person
 *   in and says who in Remote-User / Remote-Email. Believed only on requests the Node server marked as coming from
 *   TRUSTED_HEADER_PROXIES (server.ts sets PROXY_MARK, and strips any a client sent); never on the Worker.
 */
import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { genericOAuth } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { maySignUp } from "../auth";
import type { Config } from "../config";
import { account, session, user } from "../db/schema";
import type { Db } from "../ports";

export const OIDC_PROVIDER = "oidc";
export const TRUSTED_HEADER_PROVIDER = "trusted-header";
/** Set by server.ts (only) on requests from TRUSTED_HEADER_PROXIES. */
export const PROXY_MARK = "x-ferret-auth-proxy";

/** What the sign-in screen offers (GET /api/v1/auth-options). */
export function ssoOptions(config: Config) {
  return {
    sso: config.OIDC_ISSUER && config.OIDC_CLIENT_ID ? { providerId: OIDC_PROVIDER, name: config.OIDC_NAME } : null,
    trustedHeader: config.TRUSTED_HEADER_AUTH,
  };
}

/** Node's TLS error codes for a certificate nobody here vouches for (Settings → Server → Certificates fixes them). */
const UNTRUSTED = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

/** Why a fetch failed, in words — from the error's cause (Node's fetch puts the socket/TLS error there). */
function whyUnreachable(err: unknown): string {
  const cause = err instanceof Error && err.cause && typeof err.cause === "object" ? (err.cause as { code?: unknown; message?: unknown }) : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "it didn't answer within 10 seconds";
  if (UNTRUSTED.has(code)) return "its certificate isn't trusted — add the certificate authority that signed it in Settings → Server → Certificates (or `cli.js certificates trust`)";
  if (code === "CERT_HAS_EXPIRED") return "its certificate has expired";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "its certificate is for a different name";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "that name can't be found (DNS)";
  if (code === "ECONNREFUSED") return "nothing is listening there";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "the connection timed out";
  const said = typeof cause?.message === "string" ? cause.message : err instanceof Error ? err.message : String(err);
  return code ? `${code}: ${said}` : said;
}

/**
 * Why the OIDC provider's discovery document can't be used, or null when it can — for a sign-in Better Auth answered
 * only "Provider not found", and the startup log. Fetches it the way Better Auth does (same address, 10 s).
 */
export async function oidcProblem(config: Config, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID) return null;
  const url = `${config.OIDC_ISSUER.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const where = `Couldn't reach ${config.OIDC_NAME} at ${config.OIDC_ISSUER}`;
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  } catch (err) {
    return `${where}: ${whyUnreachable(err)}.`;
  }
  if (!res.ok) return `${where}: ${url} answered ${res.status}. Is OIDC_ISSUER the issuer's exact address?`;
  const doc = (await res.json().catch(() => null)) as { authorization_endpoint?: unknown; token_endpoint?: unknown } | null;
  if (!doc || typeof doc.authorization_endpoint !== "string" || typeof doc.token_endpoint !== "string") {
    return `${where}: ${url} isn't an OpenID Connect discovery document. Is OIDC_ISSUER the issuer's exact address?`;
  }
  return null;
}

export function ssoPlugins(db: Db, config: Config, onAccountCreated?: () => void | Promise<void>): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [];
  if (config.OIDC_ISSUER && config.OIDC_CLIENT_ID) {
    const issuer = config.OIDC_ISSUER.replace(/\/+$/, "");
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER,
            name: config.OIDC_NAME,
            discoveryUrl: `${issuer}/.well-known/openid-configuration`,
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            scopes: config.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean),
            ...(config.OIDC_CLIENT_SECRET && { authentication: config.OIDC_CLIENT_AUTH }),
            pkce: true,
            // An address the provider hasn't checked is never trusted to sign in as (or link to) an account.
            requireEmailVerification: true,
            mapProfileToUser: (profile) => ({
              name: String(profile.name ?? profile.preferred_username ?? profile.email ?? "Someone"),
              emailVerified: profile.email_verified === true,
            }),
          },
        ],
      }) as BetterAuthPlugin,
    );
  }
  if (config.TRUSTED_HEADER_AUTH) plugins.push(trustedHeaderSignIn(db, config, onAccountCreated));
  return plugins;
}

/**
 * POST /api/auth/sign-in/trusted-header: a session for whoever the proxy says, when it's the proxy saying it. The
 * person is known by the proxy's user name (an `account` row); the first time, by their email — an existing account
 * with it is linked, or a new one made if Ferret's sign-up rules allow it (ALLOW_SIGNUP, or a pending invitation).
 */
function trustedHeaderSignIn(db: Db, config: Config, onAccountCreated?: () => void | Promise<void>) {
  return {
    id: "ferret-trusted-header",
    endpoints: {
      trustedHeaderSignIn: createAuthEndpoint("/sign-in/trusted-header", { method: "POST" }, async (ctx) => {
        const headers = ctx.request?.headers;
        if (headers?.get(PROXY_MARK) !== "1") throw new APIError("UNAUTHORIZED", { message: "Not from the sign-in proxy" });
        const email = headers.get(config.TRUSTED_HEADER_EMAIL)?.trim().toLowerCase();
        const username = headers.get(config.TRUSTED_HEADER_USER)?.trim() || email;
        if (!email || !username || !email.includes("@")) throw new APIError("UNAUTHORIZED", { message: "The sign-in proxy didn't say who you are" });

        const [linked] = await db
          .select({ userId: account.userId })
          .from(account)
          .where(and(eq(account.providerId, TRUSTED_HEADER_PROVIDER), eq(account.accountId, username)));
        let userId = linked?.userId;
        if (!userId) {
          const [existing] = await db.select({ id: user.id, emailVerified: user.emailVerified }).from(user).where(eq(user.email, email));
          if (existing) {
            if (!existing.emailVerified) {
              // Made with this address but never confirmed — maybe by someone else. The proxy's person takes it over,
              // without whatever password was set on it, and it's confirmed now (the proxy vouches for the address).
              await db.delete(account).where(eq(account.userId, existing.id));
              await db.delete(session).where(eq(session.userId, existing.id));
              await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.id));
            }
            userId = existing.id;
          }
          else {
            if (!(await maySignUp(db, config, email))) {
              throw new APIError("FORBIDDEN", { code: "INVITE_ONLY", message: "Ferret is invite-only — ask someone in your household for an invitation link" });
            }
            const name = headers.get(config.TRUSTED_HEADER_NAME)?.trim() || username;
            const [made] = await db.insert(user).values({ id: crypto.randomUUID(), name, email, emailVerified: true }).returning({ id: user.id });
            userId = made!.id;
            await onAccountCreated?.();
          }
          await db.insert(account).values({ id: crypto.randomUUID(), accountId: username, providerId: TRUSTED_HEADER_PROVIDER, userId });
        }
        const found = await ctx.context.internalAdapter.findUserById(userId);
        if (!found) throw new APIError("UNAUTHORIZED", { message: "No such account" });
        const made = await ctx.context.internalAdapter.createSession(found.id);
        await setSessionCookie(ctx, { session: made, user: found });
        return ctx.json({ ok: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}
