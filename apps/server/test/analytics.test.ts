import { describe, expect, it } from "vitest";
import { ensureDemo } from "../src/lib/demo";
import { FakeAnalytics, FakeNotifier, config, setup } from "./helpers";

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL }, body: JSON.stringify(body) });

// Planting the sample house (28 things) is slow on some test databases (test/db.ts): more than vitest's 5 s.
describe("usage counts (the public demo)", { timeout: 30_000 }, () => {
  it("counts what the browser alone sees — only those, and refs tidied", async () => {
    const analytics = new FakeAnalytics();
    const { app } = await setup({ analytics });
    expect((await app.request("/api/v1/usage", json({ event: "visit", ref: "GitHub" }))).status).toBe(204);
    expect((await app.request("/api/v1/usage", json({ event: "visit", ref: "<script>hi" }))).status).toBe(204);
    expect((await app.request("/api/v1/usage", json({ event: "install", ref: "github" }))).status).toBe(204);
    expect((await app.request("/api/v1/usage", json({ event: "item.add" }))).status).toBe(422);
    expect(analytics.events).toEqual([{ event: "visit", ref: "github" }, { event: "visit", ref: "other" }, { event: "install" }]);
  });

  it("counts things added, searches (once per checked pair), questions, keys and MCP calls where they happen", async () => {
    const analytics = new FakeAnalytics();
    const t = await setup({ analytics });
    const sam = await t.user("sam");
    analytics.events = [];
    await sam.addItem({ name: "Cordless drill" });
    await sam.as("/api/v1/items?q=drill&judge=later");
    await sam.as("/api/v1/items?q=drill&judge=now");
    await sam.as("/api/v1/items?q=saw");
    const key = (await (await sam.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "claude" }) })).json()) as { key: string };
    await t.app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(analytics.names()).toEqual(["item.add", "search", "search", "api_key.create", "mcp.call"]);
  });

  it("tells the shared demo account's sign-ins from visitors' own, and counts sign-ups", async () => {
    const analytics = new FakeAnalytics();
    // With email, so a visitor can sign up (and confirm).
    const t = await setup({ analytics, demo: {}, notifier: new FakeNotifier(), mailUrl: "mailtos://_?from=demo@example.com" });
    await ensureDemo({ deps: t.deps as never, auth: t.auth, config: t.config, files: t.files });
    await t.app.request("/api/auth/sign-in/email", json({ email: t.config.DEMO_EMAIL, password: t.config.DEMO_PASSWORD }));
    await t.app.request("/api/auth/sign-in/email", json({ email: t.config.DEMO_EMAIL, password: "wrong-password-here" }));
    await t.app.request("/api/auth/sign-up/email", json({ email: "visitor@example.com", password: "correct-horse-battery", name: "V" }));
    await t.user("own"); // signs in with their own account
    expect(analytics.names()).toEqual(["demo.sign_in", "demo.sign_up", "sign_in"]);
  });

  it("shows the server admin the demo's use, on the demo only", async () => {
    const analytics = new FakeAnalytics();
    const t = await setup({ analytics, demo: {} });
    await ensureDemo({ deps: t.deps as never, auth: t.auth, config: t.config, files: t.files });
    const signIn = async (email: string, password: string) =>
      (await t.app.request("/api/auth/sign-in/email", json({ email, password }))).headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    const admin = await signIn("admin@demo.test", "demo-admin-password");
    const demo = await signIn(t.config.DEMO_EMAIL, t.config.DEMO_PASSWORD);
    await t.user("visitor");
    const report = await t.app.request("/api/v1/server/demo?days=7", { headers: { Cookie: admin } });
    expect(report.status).toBe(200);
    const body = (await report.json()) as { visitorAccounts: number; visitorHouseholds: number; counts: { event: string; n: number }[] };
    expect(body).toMatchObject({ visitorAccounts: 1, visitorHouseholds: 1 });
    expect(body.counts.find((c) => c.event === "demo.sign_in")?.n).toBe(1);
    expect((await t.app.request("/api/v1/server/demo", { headers: { Cookie: demo } })).status).toBe(403);

    const home = await setup();
    const owner = await home.user("owner");
    expect((await owner.as("/api/v1/server/demo")).status).toBe(404);
  });
});
