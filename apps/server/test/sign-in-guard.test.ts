/** Wrong passwords: the proof-of-work check, backoff per address, the owner's alerts, and nothing ever locking you out. */
import type { SignInEntry } from "@ferret/shared";
import { solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/web/pbkdf2";
import type { Challenge } from "altcha-lib/types";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job, signIn, signInFailure } from "../src/db/schema";
import { SECURITY_ALERT_JOB } from "../src/jobs/security-alert";
import { UNLOCK_JOB, sendUnlockLink } from "../src/jobs/unlock";
import { FakeNotifier, config, setup } from "./helpers";

type App = Awaited<ReturnType<typeof setup>>["app"];
type Answer = { code?: string; message?: string; challenge?: Challenge; retryAfter?: number };

const PASSWORD = "correct-horse-battery";

function attempt(app: App, opts: { email?: string; password?: string; ip?: string; altcha?: string }) {
  return app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: config.PUBLIC_URL,
      "X-Forwarded-For": opts.ip ?? "203.0.113.66",
      "User-Agent": "curl/8.7.1",
      ...(opts.altcha ? { "X-Altcha": opts.altcha } : {}),
    },
    body: JSON.stringify({ email: opts.email ?? "ann@example.com", password: opts.password ?? "wrong-password-1" }),
  });
}

async function solve(challenge: Challenge) {
  const solution = await solveChallenge({ challenge, deriveKey });
  return btoa(JSON.stringify({ challenge, solution }));
}

/** Signs in like the web app does: if asked for the check, solve it and go again. */
async function attemptSolving(app: App, opts: Parameters<typeof attempt>[1]) {
  const first = await attempt(app, opts);
  if (first.status !== 403) return first;
  const answer = (await first.json()) as Answer;
  expect(answer.code).toBe("CHALLENGE_REQUIRED");
  return attempt(app, { ...opts, altcha: await solve(answer.challenge!) });
}

/** "Some time later": moves every recorded sign-in and wrong password this many seconds into the past. */
async function later(db: Awaited<ReturnType<typeof setup>>["db"], seconds: number) {
  await db.update(signInFailure).set({ createdAt: sql`${signInFailure.createdAt} - ${seconds * 1000}` });
  await db.update(signIn).set({ createdAt: sql`${signIn.createdAt} - ${seconds * 1000}` });
}

describe("sign-in guard", () => {
  it("waits 1 minute after the 5th wrong password, 5 after the 6th, then asks for the check", async () => {
    const { app, db, user } = await setup();
    const ann = await user("ann");
    for (let i = 0; i < 5; i++) expect((await attempt(app, {})).status).toBe(401);
    expect(await (await attempt(app, {})).json()).toMatchObject({ code: "SIGN_IN_BACKOFF", retryAfter: 60 });

    await later(db, 61);
    expect((await attempt(app, {})).status).toBe(401);
    expect(await (await attempt(app, {})).json()).toMatchObject({ code: "SIGN_IN_BACKOFF", retryAfter: 300 });

    // After the long wait: no more waiting, but every try needs a solved check.
    await later(db, 301);
    const asked = await attempt(app, {});
    expect(asked.status).toBe(403);
    const answer = (await asked.json()) as Answer;
    expect(answer).toMatchObject({ code: "CHALLENGE_REQUIRED", challenge: { parameters: { algorithm: "PBKDF2/SHA-256" } } });
    expect((await attempt(app, { altcha: btoa("{}") })).status).toBe(403); // made up
    const solved = await solve(answer.challenge!);
    expect((await attempt(app, { altcha: solved })).status).toBe(401);
    expect((await attempt(app, { altcha: solved })).status).toBe(403); // spent
    expect((await attemptSolving(app, {})).status).toBe(401);

    // Ann, at home, isn't held up at all; signing in starts the count again for everyone.
    expect((await attempt(app, { ip: "192.168.1.20", password: PASSWORD })).status).toBe(200);
    expect((await attempt(app, {})).status).toBe(401);

    // She sees the wrong passwords in Settings → Security, and was told at the 5th.
    const list = (await (await ann.as("/api/v1/security/sign-ins")).json()) as { data: SignInEntry[] };
    expect(list.data.filter((e) => e.method === "failed")).toHaveLength(9);
    expect(list.data.find((e) => e.method === "failed")).toMatchObject({ ipAddress: "203.0.113.66", userAgent: "curl/8.7.1" });
    const alerts = await db.select().from(job).where(eq(job.type, SECURITY_ALERT_JOB));
    expect(alerts.map((a) => JSON.parse(a.payload))).toEqual([expect.objectContaining({ failures: 5, ipAddress: "203.0.113.66" })]);
  }, 60_000);

  it("asks every address for the check once an email has 10 wrong passwords, and one address after 20", async () => {
    const { app, db } = await setup();
    for (let i = 0; i < 10; i++) expect((await attempt(app, { ip: `198.51.100.${i}` })).status).toBe(401);
    expect(await (await attempt(app, { ip: "198.51.100.99" })).json()).toMatchObject({ code: "CHALLENGE_REQUIRED" });

    // Emails with no account count the same (no hint which exist). Spraying from one address:
    for (let i = 0; i < 20; i++) expect((await attempt(app, { email: `user${i}@example.com`, ip: "203.0.113.9" })).status).toBe(401);
    expect(await (await attempt(app, { email: "fresh@example.com", ip: "203.0.113.9" })).json()).toMatchObject({ code: "CHALLENGE_REQUIRED" });
    expect((await attempt(app, { email: "fresh@example.com", ip: "203.0.113.10" })).status).toBe(401);
    expect((await db.select().from(signInFailure).where(eq(signInFailure.email, "user0@example.com")))[0]!.userId).toBeNull();
  }, 30_000);

  it("sends a one-time link that clears the count — by email and to your devices — without saying who has an account", async () => {
    const notifier = new FakeNotifier();
    const { app, db, files, user, deps } = await setup({ notifier });
    await user("ann");
    for (let i = 0; i < 5; i++) await attempt(app, {});
    expect((await attempt(app, {})).status).toBe(429);

    const ask = (email: string) =>
      app.request("/api/v1/sign-in/unlock-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    expect((await ask("Ann@Example.com")).status).toBe(204);
    expect((await ask("nobody@example.com")).status).toBe(204);

    const send = sendUnlockLink({ ...deps, files, appUrl: "https://ferret.test", mailUrl: "mailtos://ferret:pw@mail.example" });
    for (const j of await db.select().from(job).where(eq(job.type, UNLOCK_JOB))) await send(JSON.parse(j.payload), { lastAttempt: false });
    expect(notifier.sent.map((m) => m.url)).toEqual(["mailtos://ferret:pw@mail.example?to=ann%40example.com"]);
    const link = /https:\/\/ferret\.test\/#\/unlock\/([\w-]+)/.exec(notifier.sent[0]!.body)![1]!;

    // Asking again straight away doesn't send another.
    await send({ email: "ann@example.com", ipAddress: null }, { lastAttempt: false });
    expect(notifier.sent).toHaveLength(1);

    const use = () =>
      app.request("/api/v1/sign-in/unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: link }) });
    expect((await use()).status).toBe(204);
    expect((await use()).status).toBe(410);
    expect((await attempt(app, { password: PASSWORD })).status).toBe(200);
  }, 30_000);
});
