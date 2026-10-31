/**
 * Joining Ferret, before signing in: is sign-up open, and what an invitation
 * link is for. (Plus the API description, which does need a sign-in or key.) The invitation id in the link is the secret (long and random),
 * the same as Better Auth's own accept/reject endpoints rely on.
 */
import { ssoOptions } from "../lib/sso";
import type { InvitationPreview } from "@ferret/shared";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { BROWSER_EVENTS, cleanRef, countEvent } from "../lib/analytics";
import { partsOff } from "../lib/demo-switches";
import { emailEnabled } from "../lib/email-verification";
import { passwordResetEnabled } from "../lib/password-reset";
import { HTTPException } from "hono/http-exception";
import { invitation, organization, user } from "../db/schema";
import { type AppEnv, requireUser } from "../lib/context";
import { openApiDocument } from "../lib/openapi";

export const join = new Hono<AppEnv>();

/** The API described as OpenAPI 3.1 — for Postman, Bruno or code generators (with a key); the app's API page reads it too. */
join.get("/openapi.json", requireUser, (c) => c.json(openApiDocument(c.var.config.PUBLIC_URL)));

/**
 * What the sign-in screen offers. "Create an account": for the very first account (it sets Ferret up), then only
 * while sign-up is open and Ferret can send the email that confirms a new account.
 */
join.get("/auth-options", async (c) => {
  const [users] = await c.var.db.select({ n: count() }).from(user);
  const firstAccount = !users?.n;
  const demoOff = c.var.config.DEMO ? await partsOff(c.var.db) : null;
  return c.json({
    signUp: firstAccount || (c.var.config.ALLOW_SIGNUP && emailEnabled(c.var.deps, c.var.config) && !demoOff?.has("signups")),
    passwordReset: passwordResetEnabled(c.var.deps, c.var.config),
    // "Email me a sign-in link" needs email, just like password reset.
    signInLink: passwordResetEnabled(c.var.deps, c.var.config),
    // Single sign-on (self-hosted): "Sign in with …" for OIDC, and a forward-auth proxy's headers (lib/sso.ts).
    ...ssoOptions(c.var.config),
    // "Are you a person?" before sign-up (lib/turnstile.ts): the widget's site key.
    ...(c.var.deps.humanCheck && c.var.config.TURNSTILE_SITE_KEY && { humanCheck: { siteKey: c.var.config.TURNSTILE_SITE_KEY } }),
    // The public demo: its shared account, shown on the sign-in screen (lib/demo.ts).
    ...(demoOff && {
      demo: {
        email: c.var.config.DEMO_EMAIL,
        password: c.var.config.DEMO_PASSWORD,
        paused: c.var.config.DEMO_PAUSED || demoOff.has("everything"),
        visitorDays: c.var.config.DEMO_VISITOR_DAYS,
        // What's switched off (Settings → Server → Demo), so the app can say so.
        off: [...demoOff],
      },
    }),
  });
});

/**
 * The demo's counts that only the browser sees (lib/analytics.ts): a visit (with its `?ref=`), the Home Screen offer
 * taken, coming back after a day or a week, "Run your own". Nothing else, and nothing about who; a no-op at home.
 */
join.post("/usage", async (c) => {
  const input = z.object({ event: z.enum(BROWSER_EVENTS), ref: z.string().max(200).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) throw new HTTPException(422, { message: "Not a usage event" });
  countEvent(c.var.deps, input.data.event, input.data.event === "visit" ? cleanRef(input.data.ref) : undefined);
  return c.body(null, 204);
});

join.get("/invitations/:id", async (c) => {
  const [row] = await c.var.db
    .select({
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      householdName: organization.name,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, c.req.param("id")));
  if (!row) throw new HTTPException(404, { message: "This invitation doesn't exist — ask for a new link" });
  const expired = row.status === "pending" && row.expiresAt < new Date();
  const preview: InvitationPreview = {
    email: row.email,
    role: row.role ?? "member",
    status: expired ? "expired" : (row.status as InvitationPreview["status"]),
    householdName: row.householdName,
    inviterName: row.inviterName,
  };
  return c.json(preview);
});
