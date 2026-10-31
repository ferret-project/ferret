/** "Email me a sign-in link" and passkeys: only with email (links), never a way past two-step sign-in, always logged. */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job, signIn, user as userTable } from "../src/db/schema";
import { MAGIC_LINK_ANSWER, MAGIC_LINK_JOB, magicLinkJob } from "../src/lib/magic-link";
import { FakeNotifier, config, setup } from "./helpers";

type App = Awaited<ReturnType<typeof setup>>["app"];
const MAIL = "mailtos://ferret:pw@mail.example";

const post = (app: App, path: string, body: unknown) =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL, "X-Forwarded-For": "203.0.113.7" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const open = (app: App, url: string) => app.request(url.replace(config.PUBLIC_URL, ""), { headers: { "X-Forwarded-For": "203.0.113.7" } });

async function withEmail() {
  const notifier = new FakeNotifier();
  const ctx = await setup({ notifier, mailUrl: MAIL });
  const run = magicLinkJob({ db: ctx.db, auth: ctx.auth });
  const drain = async () => {
    for (const j of await ctx.db.select().from(job).where(and(eq(job.type, MAGIC_LINK_JOB), eq(job.status, "pending")))) {
      await run(JSON.parse(j.payload), { lastAttempt: false });
      await ctx.db.update(job).set({ status: "done" }).where(eq(job.id, j.id));
    }
  };
  const linkIn = (n: number) => /(https?:\/\/\S+magic-link\/verify\S+)/.exec(notifier.sent[n]!.body)![1]!;
  return { ...ctx, notifier, drain, linkIn };
}

describe("emailed sign-in links", () => {
  it("aren't there without email", async () => {
    const { app, user } = await setup({ notifier: new FakeNotifier() });
    await user("ann");
    expect(await (await app.request("/api/v1/auth-options")).json()).toMatchObject({ signInLink: false });
    expect((await post(app, "/sign-in/magic-link", { email: "ann@example.com" })).status).toBe(404);
  });

  it("answer every request the same, email only real accounts, work once, and are logged", async () => {
    const { app, db, user, notifier, drain, linkIn } = await withEmail();
    const ann = await user("ann");
    expect(await (await app.request("/api/v1/auth-options")).json()).toMatchObject({ signInLink: true });

    for (const body of [{ email: "ann@example.com" }, { email: "nobody@example.com" }, { email: "nope" }, {}, "not json"]) {
      const res = await post(app, "/sign-in/magic-link", body);
      expect([res.status, await res.json()]).toEqual([200, MAGIC_LINK_ANSWER]);
    }
    await drain();
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ url: `${MAIL}?to=ann%40example.com`, title: "Sign in to Ferret" });

    // Again straight away: nothing more.
    await post(app, "/sign-in/magic-link", { email: "Ann@Example.com" });
    await drain();
    expect(notifier.sent).toHaveLength(1);

    const signedIn = await open(app, linkIn(0));
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe(`${config.PUBLIC_URL}/`);
    const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await app.request("/api/v1/security/sessions", { headers: { Cookie: cookie } })).status).toBe(200);
    const annId = (await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, "ann@example.com")))[0]!.id;
    expect((await db.select().from(signIn).where(eq(signIn.userId, annId))).map((s) => s.method)).toContain("email-link");

    // Once only.
    const again = await open(app, linkIn(0));
    expect(again.headers.get("location")).toContain("signin-link=failed");
    expect(ann).toBeTruthy();
  });

  it("never skip two-step sign-in", async () => {
    const { app, db, user, notifier, drain, linkIn } = await withEmail();
    await user("ann");
    await user("bob");
    // Bob uses two-step sign-in: no link for him.
    await db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.email, "bob@example.com"));
    await post(app, "/sign-in/magic-link", { email: "bob@example.com" });
    await drain();
    expect(notifier.sent).toHaveLength(0);

    // Ann's link went out, then she turned two-step on: the link is refused (and used up).
    await post(app, "/sign-in/magic-link", { email: "ann@example.com" });
    await drain();
    await db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.email, "ann@example.com"));
    const refused = await open(app, linkIn(0));
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toContain("signin-link=two-step");
    expect(refused.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(false);
  });

  it("never make an account", async () => {
    const { app, db, drain, notifier } = await withEmail();
    await post(app, "/sign-in/magic-link", { email: "stranger@example.com" });
    await drain();
    expect(notifier.sent).toHaveLength(0);
    expect(await db.select().from(userTable).where(eq(userTable.email, "stranger@example.com"))).toEqual([]);
  });
});

describe("passkeys", () => {
  it("are added only when signed in, for this server's name", async () => {
    const { app, user } = await setup();
    const ann = await user("ann");
    expect((await app.request("/api/auth/passkey/generate-register-options")).status).toBe(401);
    const res = await ann.as("/api/auth/passkey/generate-register-options");
    expect(res.status).toBe(200);
    const options = (await res.json()) as { rp: { id: string; name: string }; user: { name: string } };
    expect(options.rp).toEqual({ id: new URL(config.PUBLIC_URL).hostname, name: "Ferret" });
    // Signing in with one starts without an account (the browser picks the passkey).
    expect((await app.request("/api/auth/passkey/generate-authenticate-options")).status).toBe(200);
  });
});
