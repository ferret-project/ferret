/** Confirming email: the first account is trusted, every later one opens a link before it can sign in. */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job, user as userTable } from "../src/db/schema";
import { VERIFY_EMAIL_JOB, purgeUnverified, sendVerificationJob } from "../src/lib/email-verification";
import { FakeNotifier, PASSWORD, config, setup } from "./helpers";

/** Opens an emailed link: the sign-in screen's address, and the token it carries. */
async function open(env: Env, link: string) {
  const res = await env.app.request(link);
  const location = res.headers.get("location") ?? "";
  return { status: res.status, location, token: decodeURIComponent(/[?&]confirm=([^#&]*)/.exec(location)?.[1] ?? "") };
}
const confirm = (env: Env, token: string, password = PASSWORD) => post(env, "/confirm-email", { token, password });

type Env = Awaited<ReturnType<typeof setup>>;
const MAIL = "mailtos://ferret:pw@mail.example";

const post = (env: Env, path: string, body: object) =>
  env.app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL },
    body: JSON.stringify(body),
  });
const signUp = (env: Env, name: string) =>
  post(env, "/sign-up/email", { name, email: `${name}@example.com`, password: PASSWORD, callbackURL: "/#/verified" });
const signIn = (env: Env, name: string) => post(env, "/sign-in/email", { email: `${name}@example.com`, password: PASSWORD });

async function sendQueuedEmails(env: Env, notifier: FakeNotifier) {
  const run = sendVerificationJob({ notifier, db: env.db, mailUrl: MAIL });
  for (const j of await env.db.select().from(job).where(and(eq(job.type, VERIFY_EMAIL_JOB), eq(job.status, "pending")))) {
    await run(JSON.parse(j.payload), { lastAttempt: false });
    await env.db.update(job).set({ status: "done" }).where(eq(job.id, j.id));
  }
}
const linkIn = (notifier: FakeNotifier) => /https?:\/\/\S+verify-email\S+/.exec(notifier.sent.at(-1)?.body ?? "")?.[0];

describe("email verification", () => {
  it("trusts the first account, and makes every later one confirm its email before signing in", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });

    // Whoever sets Ferret up signs straight in.
    expect((await signUp(env, "owner")).status).toBe(200);
    expect((await signIn(env, "owner")).status).toBe(200);
    expect(notifier.sent).toHaveLength(0);

    // The next one gets an email, and can't sign in until they open its link.
    expect((await signUp(env, "sam")).status).toBe(200);
    const early = await signIn(env, "sam");
    expect([early.status, ((await early.json()) as { code: string }).code]).toEqual([403, "EMAIL_NOT_VERIFIED"]);
    await sendQueuedEmails(env, notifier);
    expect(notifier.sent[0]).toMatchObject({ url: `${MAIL}?to=sam%40example.com`, title: "Confirm your email for Ferret" });

    // A made-up token does nothing.
    const bad = await open(env, "/api/auth/verify-email?token=nope&callbackURL=/%23/verified");
    expect(bad.location).toBe("/?confirm=nope#/verified");
    const refused = await confirm(env, "nope");
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([400, "LINK_EXPIRED"]);
    expect((await signIn(env, "sam")).status).toBe(403);

    // The link opens the sign-in screen (never somewhere else); the account's own password confirms it.
    const opened = await open(env, linkIn(notifier)!);
    expect(opened.status).toBe(302);
    expect(opened.location).toMatch(/^\/\?confirm=[^#]+#\/verified$/);
    expect((await open(env, linkIn(notifier)!.replace("callbackURL=", "callbackURL=https%3A%2F%2Fevil.example%2F"))).location).toMatch(/#\/$/);
    expect((await signIn(env, "sam")).status).toBe(403);
    const wrong = await confirm(env, opened.token, "not-the-password");
    expect([wrong.status, ((await wrong.json()) as { code: string }).code]).toEqual([401, "WRONG_PASSWORD"]);
    expect((await signIn(env, "sam")).status).toBe(403);
    expect((await confirm(env, opened.token)).status).toBe(200);
    expect((await signIn(env, "sam")).status).toBe(200);
    // Better Auth's own link endpoint is off.
    expect((await env.app.request(`/api/auth/verify-email?token=${opened.token}`)).headers.get("location")).toMatch(/^\/\?confirm=/);
  });

  it("sends the link again on request, a few times a minute at most", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    await signUp(env, "owner");
    await signUp(env, "sam");
    await sendQueuedEmails(env, notifier);
    expect((await post(env, "/send-verification-email", { email: "sam@example.com", callbackURL: "/#/verified" })).status).toBe(200);
    await sendQueuedEmails(env, notifier);
    expect(notifier.sent).toHaveLength(2);
    expect((await confirm(env, (await open(env, linkIn(notifier)!)).token)).status).toBe(200);
    expect((await signIn(env, "sam")).status).toBe(200);
  });

  it("sends an account at most a few confirmation emails a day, however often it's asked", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    await signUp(env, "owner");
    await signUp(env, "sam");
    await sendQueuedEmails(env, notifier);
    for (let i = 0; i < 8; i++) {
      await post(env, "/send-verification-email", { email: "sam@example.com", callbackURL: "/#/verified" });
      await sendQueuedEmails(env, notifier);
    }
    expect(notifier.sent).toHaveLength(5);
  });

  it("never lets whoever signed up first with someone's address into it", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    await signUp(env, "owner");
    // A stranger signs up with Sam's address and a password of their own; the link goes to Sam's inbox.
    expect((await post(env, "/sign-up/email", { name: "X", email: "sam@example.com", password: "stranger-pass-1", callbackURL: "/#/" })).status).toBe(200);
    await sendQueuedEmails(env, notifier);
    const strangers = (await open(env, linkIn(notifier)!)).token;
    // Sam opens that link: their own password doesn't fit it, so nothing is confirmed.
    expect((await confirm(env, strangers)).status).toBe(401);
    // Sam signs up: the unconfirmed account is replaced by Sam's, with Sam's password.
    expect((await signUp(env, "sam")).status).toBe(200);
    expect((await confirm(env, strangers, "stranger-pass-1")).status).toBe(401);
    await sendQueuedEmails(env, notifier);
    expect((await confirm(env, (await open(env, linkIn(notifier)!)).token)).status).toBe(200);
    expect((await signIn(env, "sam")).status).toBe(200);
    expect((await post(env, "/sign-in/email", { email: "sam@example.com", password: "stranger-pass-1" })).status).toBe(401);
  });

  it("refuses new accounts while Ferret can't send email, saying why — but not the first", async () => {
    const env = await setup();
    expect(await (await env.app.request("/api/v1/auth-options")).json()).toEqual({ signUp: true, passwordReset: false, signInLink: false, sso: null, trustedHeader: false });
    expect((await signUp(env, "owner")).status).toBe(200);
    expect(await (await env.app.request("/api/v1/auth-options")).json()).toEqual({ signUp: false, passwordReset: false, signInLink: false, sso: null, trustedHeader: false });
    const refused = await signUp(env, "sam");
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([403, "EMAIL_NOT_SET_UP"]);
    expect(await env.db.select({ email: userTable.email }).from(userTable)).toEqual([{ email: "owner@example.com" }]);
  });

  it("removes accounts nobody confirmed within a week, freeing the address", async () => {
    const notifier = new FakeNotifier();
    const env = await setup({ notifier, mailUrl: MAIL });
    await signUp(env, "owner");
    await signUp(env, "squatter");
    const week = 7 * 24 * 60 * 60 * 1000;
    expect(await purgeUnverified(env.db, Date.now() + week - 60_000)).toBe(0); // not yet
    expect(await purgeUnverified(env.db, Date.now() + week + 60_000)).toBe(1);
    const left = await env.db.select({ email: userTable.email }).from(userTable);
    expect(left).toEqual([{ email: "owner@example.com" }]); // confirmed accounts stay, however old
    expect((await signUp(env, "squatter")).status).toBe(200);
  });
});
