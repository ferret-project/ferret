/** Households: inviting people by link, roles, and invite-only sign-up. */
import type { InvitationEmails, InvitationPreview } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { INVITATION_HEADER } from "../src/auth";
import { job } from "../src/db/schema";
import { VERIFY_EMAIL_JOB, sendVerificationJob } from "../src/lib/email-verification";
import { INVITE_EMAIL_JOB, INVITES_A_DAY, RESEND_AFTER_MS, sendInvitationJob } from "../src/lib/invitation-email";
import { FakeNotifier, PASSWORD, config, setup, verifiedAccount } from "./helpers";

type Env = Awaited<ReturnType<typeof setup>>;
const MAIL = "mailtos://ferret:pw@mail.example";

/** Signs up through the app (from an invitation link when given its id): the response's status. */
async function signUp(env: Env, name: string, invitationId?: string) {
  const res = await env.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: config.PUBLIC_URL,
      ...(invitationId ? { [INVITATION_HEADER]: invitationId } : {}),
    },
    // As the app asks: back to the invitation (or the app), marked as confirmed.
    body: JSON.stringify({ name, email: `${name}@example.com`, password: PASSWORD, callbackURL: `/?verified=1#/${invitationId ? `invite/${invitationId}` : ""}` }),
  });
  return res.status;
}

/** Opens the verification link emailed to this person (the job's email), then signs in: a session fetch. */
async function confirmAndSignIn(env: Env, notifier: FakeNotifier, name: string) {
  await sendQueuedEmails(env, notifier);
  const email = notifier.sent.findLast((m) => m.url.endsWith(`to=${name}%40example.com`) && m.title === "Confirm your email for Ferret");
  const link = /https?:\/\/\S+verify-email\S+/.exec(email?.body ?? "")?.[0];
  expect(link).toBeTruthy();
  const opened = await env.app.request(link!);
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toMatch(/^\/\?verified=1#\//);
  const signIn = await env.app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL },
    body: JSON.stringify({ email: `${name}@example.com`, password: PASSWORD }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return (url: string, init: RequestInit = {}) =>
    env.app.request(url, {
      ...init,
      headers: {
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        Origin: config.PUBLIC_URL,
        Cookie: cookie,
        ...init.headers,
      },
    });
}

/** Runs the queued verification emails through the job, as the job runner would. */
async function sendQueuedEmails(env: Env, notifier: FakeNotifier) {
  const run = sendVerificationJob({ notifier, mailUrl: MAIL });
  for (const j of await env.db.select().from(job).where(and(eq(job.type, VERIFY_EMAIL_JOB), eq(job.status, "pending")))) {
    await run(JSON.parse(j.payload), { lastAttempt: false });
    await env.db.update(job).set({ status: "done" }).where(eq(job.id, j.id));
  }
}

const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });

describe("invitations", () => {
  it("let an invited person sign up from the link, confirm their email and join, even when sign-up is closed", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ signUp: false, notifier, mailUrl: MAIL });
    const { app, user } = env;
    // The very first user sets Ferret up, closed or not.
    const owner = await user("owner");
    expect((await (await app.request("/api/v1/auth-options")).json()) as object).toEqual({ signUp: false, passwordReset: true, signInLink: true, sso: null, trustedHeader: false });

    // Strangers can't sign up.
    expect(await signUp(env, "stranger")).toBe(403);

    const invite = await owner.as("/api/auth/organization/invite-member", post({ email: "Sam@example.com", role: "viewer" }));
    expect(invite.status).toBe(200);
    const { id } = (await invite.json()) as { id: string };

    // The link says what it's for, without signing in.
    const preview = (await (await app.request(`/api/v1/invitations/${id}`)).json()) as InvitationPreview;
    expect(preview).toEqual({
      email: "sam@example.com",
      role: "viewer",
      status: "pending",
      householdName: "owner home",
      inviterName: "owner",
    });

    // Knowing who was invited isn't enough: signing up as them takes the link (its id), or a wrong one won't do.
    expect(await signUp(env, "sam")).toBe(403);
    expect(await signUp(env, "sam", "not-the-invitation")).toBe(403);
    expect(await signUp(env, "sam", id)).toBe(200);
    // Not signed in yet: the email must be confirmed first.
    const early = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL },
      body: JSON.stringify({ email: "sam@example.com", password: PASSWORD }),
    });
    expect(early.status).toBe(403);
    expect(((await early.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");

    const sam = await confirmAndSignIn(env, notifier, "sam");
    expect((await sam("/api/auth/organization/accept-invitation", post({ invitationId: id }))).status).toBe(200);
    expect(((await (await app.request(`/api/v1/invitations/${id}`)).json()) as InvitationPreview).status).toBe("accepted");

    // A viewer sees the household's things but can't change them.
    await owner.addItem({ name: "Stand mixer" });
    const headers = { "X-Household-Id": owner.householdId };
    const items = (await (await sam("/api/v1/items", { headers })).json()) as { data: { name: string }[] };
    expect(items.data.map((i) => i.name)).toEqual(["Stand mixer"]);
    expect((await sam("/api/v1/items", { ...post({ name: "Nope" }), headers })).status).toBe(403);

    // The invitation is used up: it doesn't open sign-up for anyone else.
    expect(await signUp(env, "sam2", id)).toBe(403);
  });

  it("only owners and admins invite, and only to known roles", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    const { app, user } = env;
    const owner = await user("owner");
    expect((await owner.as("/api/auth/organization/invite-member", post({ email: "x@example.com", role: "boss" }))).status).toBe(400);

    const invite = await owner.as("/api/auth/organization/invite-member", post({ email: "mo@example.com", role: "member" }));
    const { id } = (await invite.json()) as { id: string };
    expect(await signUp(env, "mo", id)).toBe(200);
    const mo = await confirmAndSignIn(env, notifier, "mo");
    await mo("/api/auth/organization/accept-invitation", post({ invitationId: id }));
    await mo("/api/auth/organization/set-active", post({ organizationId: owner.householdId }));
    // A member can add things…
    expect((await mo("/api/v1/items", post({ name: "Ladder" }))).status).toBe(201);
    // …but not invite people.
    expect((await mo("/api/auth/organization/invite-member", post({ email: "y@example.com", role: "member" }))).status).toBe(403);
  });

  it("don't let someone else accept an invitation sent to another address", async () => {
    const env = await setup();
    const { app, auth, user } = env;
    const owner = await user("owner");
    const { id } = (await (await owner.as("/api/auth/organization/invite-member", post({ email: "kim@example.com", role: "member" }))).json()) as {
      id: string;
    };
    const { cookie } = await verifiedAccount(app, auth, "lee");
    const accept = await app.request("/api/auth/organization/accept-invitation", {
      ...post({ invitationId: id }),
      headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL, Cookie: cookie },
    });
    expect(accept.status).toBe(403);
    expect((await app.request("/api/v1/invitations/nope")).status).toBe(404);
  });

  it("email the invitation's link when Ferret can send email, and say when it went", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    const owner = await env.user("owner");
    let now = Date.now();
    const run = sendInvitationJob({ db: env.db, notifier, appUrl: config.PUBLIC_URL, mailUrl: MAIL, now: () => now });
    const sendQueued = async () => {
      for (const j of await env.db.select().from(job).where(and(eq(job.type, INVITE_EMAIL_JOB), eq(job.status, "pending")))) {
        await run(JSON.parse(j.payload), { lastAttempt: false });
        await env.db.update(job).set({ status: "done" }).where(eq(job.id, j.id));
      }
    };
    const emails = async () => (await (await owner.as("/api/v1/household/invitations")).json()) as InvitationEmails;

    const { id } = (await (await owner.as("/api/auth/organization/invite-member", post({ email: "pat@example.com", role: "member" }))).json()) as { id: string };
    // Queued, not sent yet: the request doesn't wait for email.
    expect(notifier.sent.filter((m) => m.title.includes("invited you"))).toHaveLength(0);
    expect(await emails()).toMatchObject({ email: true, data: [{ id, sentAt: null, error: null }] });

    await sendQueued();
    const mail = notifier.sent.find((m) => m.title === "owner invited you to owner home on Ferret");
    expect(mail?.url).toBe(`${MAIL}?to=pat%40example.com`);
    expect(mail?.body).toContain(`${config.PUBLIC_URL}/#/invite/${id}`);
    expect((await emails()).data[0]!.sentAt).toBeTruthy();

    // Send again (resend): the same invitation, emailed again — but not twice within a few minutes.
    const again = async () => {
      const res = await owner.as("/api/auth/organization/invite-member", post({ email: "pat@example.com", role: "member", resend: true }));
      expect(((await res.json()) as { id: string }).id).toBe(id);
      await sendQueued();
      return notifier.sent.filter((m) => m.title.includes("invited you")).length;
    };
    expect(await again()).toBe(1);
    now += RESEND_AFTER_MS + 1000;
    expect(await again()).toBe(2);

    // Cancelled: nothing goes out, and it's no longer listed.
    await owner.as("/api/auth/organization/cancel-invitation", post({ invitationId: id }));
    now += RESEND_AFTER_MS + 1000;
    await run({ invitationId: id }, { lastAttempt: false });
    expect(notifier.sent.filter((m) => m.title.includes("invited you"))).toHaveLength(2);
    expect((await emails()).data).toEqual([]);
  });

  it("send a household at most a day's worth of invitation emails", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    const owner = await env.user("owner");
    const run = sendInvitationJob({ db: env.db, notifier, appUrl: config.PUBLIC_URL, mailUrl: MAIL });
    for (let i = 0; i <= INVITES_A_DAY; i++) {
      const { id } = (await (await owner.as("/api/auth/organization/invite-member", post({ email: `p${i}@example.com`, role: "member" }))).json()) as { id: string };
      await run({ invitationId: id }, { lastAttempt: false });
    }
    expect(notifier.sent.filter((m) => m.title.includes("invited you"))).toHaveLength(INVITES_A_DAY);
    const { data } = (await (await owner.as("/api/v1/household/invitations")).json()) as InvitationEmails;
    expect(data.filter((d) => d.error)).toHaveLength(1);
  });

  it("say when this server can't email invitations", async () => {
    const env = await setup();
    const owner = await env.user("owner");
    await owner.as("/api/auth/organization/invite-member", post({ email: "kim@example.com", role: "member" }));
    expect((await (await owner.as("/api/v1/household/invitations")).json()) as InvitationEmails).toEqual({ email: false, data: [] });
  });
});
