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
import { account, user } from "../db/schema";
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
          const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
          if (existing) userId = existing.id;
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
        const session = await ctx.context.internalAdapter.createSession(found.id);
        await setSessionCookie(ctx, { session, user: found });
        return ctx.json({ ok: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}
