import { describe, expect, it } from "vitest";
import { TurnstileCheck } from "../src/lib/turnstile";
import type { HumanCheck } from "../src/ports";
import { config, setup } from "./helpers";

/** Passes "good" tokens for sign-up on localhost (PUBLIC_URL's hostname in tests); counts each redeemed. */
class FakeCheck implements HumanCheck {
  redeemed: string[] = [];
  async verify(token: string) {
    this.redeemed.push(token);
    if (token === "down") throw new Error("siteverify unreachable");
    const issuedAt = token === "stale" ? Date.now() - 6 * 60_000 : Date.now() - 1000;
    if (token === "elsewhere") return { success: true, action: "signup", hostname: "evil.example", issuedAt };
    if (token === "login") return { success: true, action: "login", hostname: "localhost", issuedAt };
    // Like siteverify in testing: a used token answers success again — Ferret's own record refuses it.
    return { success: token === "good" || token === "stale", action: "signup", hostname: "localhost", issuedAt };
  }
}

const signUp = (app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, email: string, token?: string) =>
  app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL, ...(token && { "X-Turnstile-Token": token }) },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Someone" }),
  });

describe("the person check on sign-up (Turnstile)", () => {
  it("lets a sign-up through only with a passed check, for sign-up, from our own hostname", async () => {
    const check = new FakeCheck();
    const { app } = await setup({ humanCheck: check });
    expect((await signUp(app, "a@example.com")).status).toBe(403);
    for (const token of ["bad", "down", "elsewhere", "login", "stale"]) expect((await signUp(app, "a@example.com", token)).status).toBe(403);
    expect((await signUp(app, "a@example.com", "good")).status).toBe(200);
    const replay = await signUp(app, "b@example.com", "good");
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ message: expect.stringMatching(/used already/) });
    expect(check.redeemed).toEqual(["bad", "down", "elsewhere", "login", "stale", "good", "good"]);

    const options = (await (await app.request("/api/v1/auth-options")).json()) as { humanCheck?: { siteKey: string } };
    expect(options.humanCheck?.siteKey).toBe("1x00000000000000000000AA");
    const csp = (await app.request("/")).headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
  });

  it("isn't there without one: a home Ferret signs up as before, and its CSP stays closed", async () => {
    const { app } = await setup();
    expect((await signUp(app, "a@example.com")).status).toBe(200);
    expect(((await (await app.request("/api/v1/auth-options")).json()) as { humanCheck?: unknown }).humanCheck).toBeUndefined();
    expect((await app.request("/")).headers.get("content-security-policy")).not.toContain("challenges.cloudflare.com");
  });

  it("redeems the token at siteverify with the secret", async () => {
    let sent: URLSearchParams | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent = init?.body as URLSearchParams;
      return Response.json({ success: true, action: "signup", hostname: "ferret.example.com", challenge_ts: "2026-10-21T01:06:38.000Z" });
    }) as typeof fetch;
    const out = await new TurnstileCheck("the-secret", fetcher).verify("tok", "203.0.113.9");
    expect(out).toEqual({ success: true, action: "signup", hostname: "ferret.example.com", issuedAt: Date.parse("2026-10-21T01:06:38.000Z") });
    expect(Object.fromEntries(sent!)).toEqual({ secret: "the-secret", response: "tok", remoteip: "203.0.113.9" });
  });

  it("gives each page a fresh CSP nonce behind a proxy that injects a bot check, and none at home", async () => {
    const nonce = async (app: { request: (url: string) => Response | Promise<Response> }) =>
      ((await app.request("/")).headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];
    const { app } = await setup({ cspNonce: true });
    const [a, b] = [await nonce(app), await nonce(app)];
    expect(a).toMatch(/^[A-Za-z0-9+/=_-]{16,}$/);
    expect(b).not.toBe(a);
    expect(await nonce((await setup()).app)).toBeUndefined();
  });
});
