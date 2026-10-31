/** "Forgot password?": only with email, the same answer for any input, the link by email, and what a reset undoes. */
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job, signInFailure } from "../src/db/schema";
import { PASSWORD_CHANGED_JOB } from "../src/jobs/security-alert";
import { RESET_ANSWER, RESET_JOB, passwordResetJob } from "../src/lib/password-reset";
import { FakeNotifier, config, setup } from "./helpers";

type App = Awaited<ReturnType<typeof setup>>["app"];
const MAIL = "mailtos://ferret:pw@mail.example";

const post = (app: App, path: string, body: unknown, ip = "203.0.113.5") =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL, "X-Forwarded-For": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("password reset", () => {
  it("isn't there without email", async () => {
    const { app, user } = await setup({ notifier: new FakeNotifier() });
    await user("ann");
    // Without email a new account couldn't confirm its address, so no "Create an account" either.
    expect(await (await app.request("/api/v1/auth-options")).json()).toEqual({ signUp: false, passwordReset: false, signInLink: false, sso: null, trustedHeader: false });
    expect((await post(app, "/request-password-reset", { email: "ann@example.com" })).status).toBe(404);
    expect((await post(app, "/reset-password", { newPassword: "x".repeat(12), token: "abc" })).status).toBe(404);
  });

  it("answers every request the same — account, no account or junk — and emails only real accounts", async () => {
    const notifier = new FakeNotifier();
    const { app, auth, db, user } = await setup({ notifier, mailUrl: MAIL });
    await user("ann");
    expect(await (await app.request("/api/v1/auth-options")).json()).toEqual({ signUp: true, passwordReset: true, signInLink: true, sso: null, trustedHeader: false });

    const inputs = [{ email: "ann@example.com" }, { email: "nobody@example.com" }, { email: "not an email" }, { email: 42 }, {}, "not json"];
    for (const body of inputs) {
      const res = await post(app, "/request-password-reset", body);
      expect([res.status, await res.json()]).toEqual([200, RESET_ANSWER]);
    }

    const run = passwordResetJob({ db, auth });
    const drain = async () => {
      for (const j of await db.select().from(job).where(and(eq(job.type, RESET_JOB), eq(job.status, "pending")))) {
        await run(JSON.parse(j.payload), { lastAttempt: false });
        await db.update(job).set({ status: "done" }).where(eq(job.id, j.id));
      }
    };
    await drain();
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ url: `${MAIL}?to=ann%40example.com`, title: "Choose a new Ferret password" });
    expect(notifier.sent[0]!.body).toMatch(/#\/reset-password\/[\w-]{20,}/);

    // Asking again straight away sends nothing more (and still answers the same).
    expect((await post(app, "/request-password-reset", { email: "Ann@Example.com" })).status).toBe(200);
    await drain();
    expect(notifier.sent).toHaveLength(1);
  });

  it("sets the new password, signs out everywhere, clears the wrong-password count, and tells the person", async () => {
    const notifier = new FakeNotifier();
    const { app, auth, db, user } = await setup({ notifier, mailUrl: MAIL });
    const ann = await user("ann");
    for (let i = 0; i < 5; i++) await post(app, "/sign-in/email", { email: "ann@example.com", password: "wrong-password-1" });
    expect((await post(app, "/sign-in/email", { email: "ann@example.com", password: "wrong-password-1" })).status).toBe(429);

    await post(app, "/request-password-reset", { email: "ann@example.com" });
    const [pending] = await db.select().from(job).where(eq(job.type, RESET_JOB));
    await passwordResetJob({ db, auth })(JSON.parse(pending!.payload), { lastAttempt: false });
    const token = /#\/reset-password\/([\w-]+)/.exec(notifier.sent[0]!.body)![1]!;

    expect((await post(app, "/reset-password", { newPassword: "short", token })).status).toBe(400);
    expect((await post(app, "/reset-password", { newPassword: "a-brand-new-password", token })).status).toBe(200);
    expect((await post(app, "/reset-password", { newPassword: "another-new-password", token })).status).toBe(400); // used

    expect((await ann.as("/api/v1/security/sessions")).status).toBe(401); // signed out everywhere
    expect((await post(app, "/sign-in/email", { email: "ann@example.com", password: "correct-horse-battery" })).status).toBe(401);
    expect((await post(app, "/sign-in/email", { email: "ann@example.com", password: "a-brand-new-password" })).status).toBe(200);
    // The count started again (the attempt just above wasn't held up), and she's told.
    expect(await db.select({ n: sql<number>`count(*)` }).from(signInFailure)).toEqual([{ n: 6 }]);
    expect((await db.select().from(job).where(eq(job.type, PASSWORD_CHANGED_JOB))).map((j) => JSON.parse(j.payload))).toEqual([
      expect.objectContaining({ email: "ann@example.com" }),
    ]);
  });
});
