/** Confirming email: the first account is trusted, every later one opens a link before it can sign in. */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job, user as userTable } from "../src/db/schema";
import { VERIFY_EMAIL_JOB, purgeUnverified, sendVerificationJob } from "../src/lib/email-verification";
import { FakeNotifier, PASSWORD, config, setup } from "./helpers";

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
  const run = sendVerificationJob({ notifier, mailUrl: MAIL });
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
    const bad = await env.app.request("/api/auth/verify-email?token=nope&callbackURL=/%23/verified");
    expect(bad.headers.get("location")).toBe("/?error=INVALID_TOKEN#/verified"); // the page reads ?error before the hash
    expect((await signIn(env, "sam")).status).toBe(403);

    const opened = await env.app.request(linkIn(notifier)!);
    expect([opened.status, opened.headers.get("location")]).toEqual([302, "/#/verified"]);
    expect((await signIn(env, "sam")).status).toBe(200);
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
    expect((await env.app.request(linkIn(notifier)!)).status).toBe(302);
    expect((await signIn(env, "sam")).status).toBe(200);
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
