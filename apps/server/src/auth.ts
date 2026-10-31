/**
 * Authentication: Better Auth stored in our own database.
 * - email + password, passkeys, emailed sign-in links, and single sign-on (lib/sso.ts). Every account but
 *   the first must confirm its email before signing in — lib/email-verification.ts.
 * - "organization" plugin = households, with owner/admin/member/viewer roles and invites
 *   (shared as links). With ALLOW_SIGNUP=false, only someone holding a pending
 *   invitation's link (or the very first user) can create an account.
 * - API keys for Claude (MCP) and scripts: owned by a user, bound to one household
 *   (see lib/api-keys.ts). Keys never stand in for a session on Better Auth's own
 *   endpoints; only /api/v1 and /mcp accept them.
 * - Two-step sign-in (TOTP from an authenticator app, with backup codes), set up in
 *   Settings → Security; every finished sign-in is logged (lib/security.ts).
 * - Wrong passwords: backoff per address and a self-hosted proof-of-work check
 *   (ALTCHA), never a hard lock — lib/sign-in-guard.ts.
 * - "Forgot password?" by email, only when Ferret can send email, behind a front
 *   that never says who has an account — lib/password-reset.ts.
 */
import { passkey } from "@better-auth/passkey";
import { hashToken, MAGIC_LINK_TTL_S, magicLinkFront } from "./lib/magic-link";
import { apiKey } from "@better-auth/api-key";
import { APIError, type BetterAuthPlugin, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, organization, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { and, count, eq, gt } from "drizzle-orm";
import { type Config, trustedOrigins } from "./config";
import { isNewPlace, recordSignIn, type SignInMethod } from "./lib/security";
import { VERIFY_TTL_S } from "./lib/email-verification";
import { RESET_PATHS, RESET_TTL_S, passwordResetFront } from "./lib/password-reset";
import { clearFailures, type FailureAlert, signInGuard } from "./lib/sign-in-guard";
import type { Db } from "./ports";
import * as schema from "./db/schema";
import { ssoPlugins } from "./lib/sso";

/** Household roles. "viewer" can look and ask but not change anything (enforced by requireWriter and MCP). */
const ac = createAccessControl(defaultStatements);
export const roles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  member: ac.newRole(memberAc.statements),
  viewer: ac.newRole(memberAc.statements),
};

export interface AuthHooks {
  /** Tell an account's owner someone keeps getting its password wrong (a job, in the app). */
  onFailedSignIns?: (alert: FailureAlert) => void | Promise<void>;
  /** Tell them a sign-in came from somewhere new (another network) — a job. */
  onNewPlace?: (signIn: { userId: string; ipAddress: string | null; userAgent: string | null; at: string }) => void | Promise<void>;
  /**
   * Password reset (only when Ferret can send email): queue the work for a reset request, send the
   * link (from that job), and tell the person their password changed.
   */
  passwordReset?: {
    enqueue: (email: string) => Promise<void>;
    send: (to: { email: string; name: string }, token: string) => Promise<void>;
    changed: (who: { id: string; email: string }) => Promise<void>;
  };
  /** Email a new account its verification link (a job). Without it (no email), only the first account can be made. */
  verifyEmail?: (to: { email: string; name: string }, url: string) => Promise<void>;
  /** Email an invitation's link when it's made or sent again (a job, lib/invitation-email.ts). Without email, it's a link only. */
  inviteEmail?: (invitation: { id: string; organizationId: string }) => Promise<void>;
  /** "Email me a sign-in link" (only when Ferret can send email): queue the work for a request, send the link (from that job). */
  magicLink?: {
    enqueue: (email: string) => Promise<void>;
    send: (email: string, url: string) => Promise<void>;
  };
  /** A new account was made — tell the server's admins (ADMIN_WEBHOOK_URL; a job). */
  onAccountCreated?: () => void | Promise<void>;
  /** Tell someone a passkey was added to their account (a job). */
  onPasskeyAdded?: (added: { userId: string; userAgent: string | null }) => void | Promise<void>;
  /** People a household may have — its plan's limit (lib/plan.ts); without, MEMBERSHIP_LIMIT. */
  membershipLimit?: (householdId: string) => Promise<number>;
  /** Whether an account may start another household: null if so, else why not (a plan's rule, lib/plan.ts). */
  mayCreateHousehold?: (userId: string) => Promise<string | null>;
  /** More Better Auth plugins, after Ferret's own (createApp's extensions). */
  plugins?: BetterAuthPlugin[];
}

/** Households are small: generous, but finite. */
export const MEMBERSHIP_LIMIT = 50;

/** Header the web app sends the invitation's id in when signing up from an invitation link. */
export const INVITATION_HEADER = "x-invitation-id";

export function createAuth(db: Db, config: Config, opts: AuthHooks = {}) {
  const reset = opts.passwordReset;
  const link = opts.magicLink;
  const site = new URL(config.PUBLIC_URL);
  const verify = opts.verifyEmail;
  return betterAuth({
    appName: "Ferret",
    baseURL: config.PUBLIC_URL,
    basePath: "/api/auth",
    secret: config.AUTH_SECRET,
    trustedOrigins: trustedOrigins(config),
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      requireEmailVerification: true,
      ...(reset && {
        sendResetPassword: ({ user, token }) => reset.send(user, token),
        resetPasswordTokenExpiresIn: RESET_TTL_S,
        revokeSessionsOnPasswordReset: true,
        onPasswordReset: async ({ user }) => {
          await clearFailures(db, user.email.toLowerCase());
          await reset.changed(user);
        },
      }),
    },
    emailVerification: {
      sendOnSignUp: true,
      // Not on every sign-in try: "Send the link again" on the sign-in screen asks for one (rate-limited).
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: VERIFY_TTL_S,
      sendVerificationEmail: async ({ user, url }) => {
        // The first account is confirmed as it's made: nothing to send.
        if (!user.emailVerified) await verify?.(user, url);
      },
    },
    databaseHooks: {
      user: {
        create: {
          // The rules again, for any way an account gets made (signUpGate answers sign-ups with the reason).
          before: async (user, ctx) => {
            // The very first account sets Ferret up: it's trusted as it is.
            if (await isFirstAccount(db)) return { data: { ...user, emailVerified: true } };
            const refused = await signUpRefusal(db, config, user.email, ctx?.request ? ctx.request.headers.get(INVITATION_HEADER) : undefined, Boolean(verify));
            if (refused && !(refused === NO_EMAIL && user.emailVerified)) throw new APIError("FORBIDDEN", { message: refused });
          },
          after: async () => {
            await opts.onAccountCreated?.();
          },
        },
      },
    },
    // Better Auth's own limiter (per address: 3 sign-ins per 10 s etc.), kept in the database so a restart doesn't
    // reset it. Off in tests, which sign in quickly from one address. Wrong passwords: lib/sign-in-guard.ts.
    rateLimit: {
      enabled: config.NODE_ENV !== "test",
      storage: "database",
      // A sign-in after a few wrong passwords is two requests (the first asks for the proof-of-work check).
      customRules: {
        "/sign-in/email": { window: 10, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 3 },
        "/sign-in/magic-link": { window: 60, max: 3 },
        "/passkey/verify-authentication": { window: 10, max: 5 },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh daily
    },
    // Keys are created through /api/v1/api-keys, which binds them to a household.
    // Reset links go straight to the web app (#/reset-password/:token), not through Better Auth's redirect;
    // without email, no reset at all.
    disabledPaths: ["/api-key/create", "/api-key/update", ...(reset ? ["/reset-password/:token"] : RESET_PATHS)],
    plugins: [
      apiKey({
        defaultPrefix: "ferret_",
        // "ferret_" plus a few characters, so keys can be told apart in Settings.
        startingCharactersConfig: { charactersLength: 11 },
        enableMetadata: true,
        // A chatty Claude session makes a few requests per question; this only stops a runaway loop.
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
      organization({
        ac,
        roles,
        // Households are deleted only through Ferret (DELETE /api/v1/household): it removes their files and search
        // entries and runs the beforeDelete hooks — Better Auth's own endpoint would skip all that.
        disableOrganizationDeletion: true,
        // Households are small; keep the limits generous but finite — and a plan may set its own (lib/plan.ts).
        organizationLimit: 10,
        membershipLimit: opts.membershipLimit ? (_user, org) => opts.membershipLimit!(org.id) : MEMBERSHIP_LIMIT,
        organizationHooks: {
          // A plan's rule on starting households (e.g. one free household an account), with its own reason — Better
          // Auth's organizationLimit could only say "maximum reached".
          ...(opts.mayCreateHousehold && {
            beforeCreateOrganization: async ({ user }) => {
              const refused = await opts.mayCreateHousehold!(user.id);
              if (refused) throw new APIError("FORBIDDEN", { message: refused });
            },
          }),
          // Better Auth checks the membership limit only when an invitation is accepted: say so when it's sent instead,
          // counting the invitations still pending, so nobody's sent a link that can't work.
          ...(opts.membershipLimit && {
            beforeCreateInvitation: async ({ organization: org }) => {
              const limit = await opts.membershipLimit!(org.id);
              const [members] = await db.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, org.id));
              const [pending] = await db
                .select({ n: count() })
                .from(schema.invitation)
                .where(and(eq(schema.invitation.organizationId, org.id), eq(schema.invitation.status, "pending")));
              if ((members?.n ?? 0) + (pending?.n ?? 0) >= limit) {
                throw new APIError("FORBIDDEN", { message: `This household's plan has room for ${limit} ${limit === 1 ? "person" : "people"} — upgrade to invite more.` });
              }
            },
          }),
        },
        ...(opts.inviteEmail && { sendInvitationEmail: ({ invitation }) => opts.inviteEmail!(invitation) }),
        invitationExpiresIn: 60 * 60 * 24 * 14, // two weeks to get round to it
        cancelPendingInvitationsOnReInvite: true,
      }),
      twoFactor({
        issuer: "Ferret",
        backupCodeOptions: { amount: 10 },
      }),
      // After twoFactor, so a sign-in still waiting for its code isn't logged as one.
      signInLog(db, opts.onNewPlace),
      signInGuard({ db, authSecret: config.AUTH_SECRET, onAlert: opts.onFailedSignIns }),
      signUpGate(db, config, Boolean(verify)),
      // Single sign-on, self-hosted: OIDC and a forward-auth proxy's headers, when they're set up (lib/sso.ts).
      ...ssoPlugins(db, config, opts.onAccountCreated),
      ...(reset ? [passwordResetFront(reset.enqueue)] : []),
      // Passkeys belong to this server's name (PUBLIC_URL's host): the browser only offers them here. In development the app
      // runs on another port (Vite), so its origins are allowed too.
      passkey({ rpID: site.hostname, rpName: "Ferret", origin: [site.origin, ...trustedOrigins(config)] }),
      passkeyAdded(opts.onPasskeyAdded),
      ...(link
        ? [
            magicLink({
              // Never makes an account: invitations are the way in.
              disableSignUp: true,
              expiresIn: MAGIC_LINK_TTL_S,
              storeToken: { type: "custom-hasher", hash: hashToken },
              sendMagicLink: ({ email, url }) => link.send(email, url),
            }),
            magicLinkFront(db, link.enqueue),
          ]
        : []),
      // Typed as none, so `auth.api` keeps Ferret's own plugins' types; an extension calls its own endpoints itself.
      ...((opts.plugins ?? []) as []),
    ],
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Where a session can start, and what it says about how the person proved who they are. */
const SIGN_IN_PATHS: Record<string, SignInMethod> = {
  "/sign-in/email": "password",
  "/sign-up/email": "sign-up",
  "/two-factor/verify-totp": "password+code",
  "/two-factor/verify-backup-code": "password+backup-code",
  "/magic-link/verify": "email-link",
  "/passkey/verify-authentication": "passkey",
  "/callback/:id": "sso",
  "/sign-in/trusted-header": "trusted-header",
};

/** After a passkey is registered: tell its owner (a new way into the account should never go unnoticed). */
function passkeyAdded(notify: AuthHooks["onPasskeyAdded"]) {
  return {
    id: "ferret-passkey-added",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            const session = ctx.context.session;
            const ok = !(ctx.context.returned instanceof Error);
            if (notify && session && ok) await notify({ userId: session.user.id, userAgent: ctx.request?.headers.get("user-agent") ?? null });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/**
 * Logs every finished sign-in (Settings → Security). The two-factor plugin drops
 * the session of a password sign-in that still needs its code, so newSession is
 * null then; turning two-step on also makes a new session, but from a signed-in
 * request (context.session), so that isn't a sign-in either.
 */
function signInLog(db: Db, onNewPlace?: AuthHooks["onNewPlace"]) {
  return {
    id: "ferret-sign-in-log",
    hooks: {
      after: [
        {
          matcher: (ctx) => Boolean(ctx.path && ctx.path in SIGN_IN_PATHS),
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (!created || ctx.context.session) return;
            const newPlace = onNewPlace ? await isNewPlace(db, created.user.id, created.session.ipAddress) : false;
            await recordSignIn(db, {
              userId: created.user.id,
              ipAddress: created.session.ipAddress,
              userAgent: created.session.userAgent,
              method: SIGN_IN_PATHS[ctx.path!]!,
            });
            if (newPlace) {
              await onNewPlace!({
                userId: created.user.id,
                ipAddress: created.session.ipAddress ?? null,
                userAgent: created.session.userAgent ?? null,
                at: new Date().toISOString(),
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

const INVITE_ONLY = "Ferret is invite-only — ask someone in your household for an invitation link";
const NO_EMAIL = "Ferret can't send email yet, so a new account can't be confirmed — ask whoever runs Ferret to set up email";

async function isFirstAccount(db: Db) {
  const [users] = await db.select({ n: count() }).from(schema.user);
  return !users?.n;
}

/** Why this sign-up can't happen (the message to show), or null if it can. Not for the first account. */
async function signUpRefusal(db: Db, config: Config, email: string, invitationId: string | null | undefined, canEmail: boolean) {
  if (!(await maySignUp(db, config, email, invitationId))) return INVITE_ONLY;
  if (!canEmail) return NO_EMAIL;
  return null;
}

/**
 * Sign-up's rules, checked before Better Auth's own sign-up runs: with email
 * verification on, Better Auth answers every sign-up the same way (so it can't
 * be used to find out who has an account), which would hide a refusal behind
 * "check your email". This says why instead.
 */
function signUpGate(db: Db, config: Config, canEmail: boolean) {
  return {
    id: "ferret-sign-up-gate",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            if (await isFirstAccount(db)) return;
            const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase();
            const refused = await signUpRefusal(db, config, email, ctx.request?.headers.get(INVITATION_HEADER) ?? null, canEmail);
            if (refused) throw new APIError("FORBIDDEN", { code: refused === NO_EMAIL ? "EMAIL_NOT_SET_UP" : "INVITE_ONLY", message: refused });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/**
 * Who may create an account: anyone while ALLOW_SIGNUP is on; otherwise only
 * someone with a pending, unexpired invitation for their email — and, signing
 * up through the app (invitationId not undefined), holding that invitation's
 * link, so knowing who was invited isn't enough. Or the very first user, who
 * sets Ferret up.
 */
export async function maySignUp(db: Db, config: Config, email: string, invitationId?: string | null) {
  if (config.ALLOW_SIGNUP) return true;
  const [users] = await db.select({ n: count() }).from(schema.user);
  if (!users?.n) return true;
  if (invitationId === null) return false;
  const [invited] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
        ...(invitationId ? [eq(schema.invitation.id, invitationId)] : []),
      ),
    )
    .limit(1);
  return Boolean(invited);
}
