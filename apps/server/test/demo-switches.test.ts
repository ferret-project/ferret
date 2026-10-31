import { describe, expect, it } from "vitest";
import { AiPartOff, budgeted, demoNotifier, ensureDemo } from "../src/lib/demo";
import { forgetPartsOff } from "../src/lib/demo-switches";
import { FakeNotifier, config, photo, setup } from "./helpers";

const json = (body: unknown, cookie?: string, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL, ...(cookie && { Cookie: cookie }) },
  body: JSON.stringify(body),
});

async function demo() {
  forgetPartsOff();
  const t = await setup({ demo: {}, notifier: new FakeNotifier(), mailUrl: "mailtos://_?from=demo@example.com" });
  await ensureDemo({ deps: t.deps as never, auth: t.auth, config: t.config, files: t.files });
  const res = await t.app.request("/api/auth/sign-in/email", json({ email: "admin@demo.test", password: "demo-admin-password" }));
  const admin = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const switchOff = async (...off: string[]) => {
    const put = await t.app.request("/api/v1/server/demo/switches", json({ off }, admin, "PUT"));
    expect(put.status).toBe(200);
    forgetPartsOff();
  };
  return { ...t, admin, switchOff };
}

// Planting the sample house is slow on some test databases (test/db.ts).
describe("switching parts of the demo off", { timeout: 30_000 }, () => {
  it("only the server admin, only on the demo", async () => {
    const t = await demo();
    const visitor = await t.user("visitor");
    expect((await visitor.as("/api/v1/server/demo/switches", { method: "PUT", body: JSON.stringify({ off: ["email"] }) })).status).toBe(403);
    expect((await t.app.request("/api/v1/server/demo/switches", json({ off: ["nonsense"] }, t.admin, "PUT"))).status).toBe(422);
    await t.switchOff("email", "uploads");
    expect(await (await t.app.request("/api/v1/server/demo/switches", { headers: { Cookie: t.admin } })).json()).toEqual({ off: ["email", "uploads"] });

    const home = await setup();
    const owner = await home.user("owner");
    expect((await owner.as("/api/v1/server/demo/switches")).status).toBe(404);
  });

  it("stops uploads, sign-ups, email and each AI part on its own", async () => {
    const t = await demo();
    const visitor = await t.user("visitor");
    const thing = await visitor.addItem({ name: "Guitar" });
    await t.switchOff("uploads", "signups", "email", "photos");

    const form = new FormData();
    form.set("file", new File([await photo()], "guitar.jpg"));
    form.set("kind", "photo");
    expect((await visitor.as(`/api/v1/items/${thing.id}/attachments`, { method: "POST", body: form })).status).toBe(503);
    expect((await visitor.as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Still works" }) })).status).toBe(201);

    expect((await t.app.request("/api/auth/sign-up/email", json({ email: "new@example.com", password: "correct-horse-battery", name: "N" }))).status).toBe(403);
    expect(((await (await t.app.request("/api/v1/auth-options")).json()) as { signUp: boolean; demo: { off: string[] } })).toMatchObject({ signUp: false, demo: { off: ["uploads", "signups", "email", "photos"] } });

    const sent = new FakeNotifier();
    await demoNotifier(t.db, t.config, sent)!.send("mailtos://_?to=admin%40demo.test", { title: "a", body: "b" });
    expect(sent.sent).toEqual([]);

    // Photos off: the vision call is refused; embeddings (search by meaning) still go.
    const ai = budgeted(t.db, t.config, { json: async () => "seen", embed: async () => [[1]] }, (m) => (m === "embed" ? "meaning" : "photos"))!;
    await expect(ai.json()).rejects.toBeInstanceOf(AiPartOff);
    expect(await ai.embed()).toEqual([[1]]);
  });

  it("rests everything but the sign-in screen — except for its admin, who can wake it", async () => {
    const t = await demo();
    const visitor = await t.user("visitor");
    await t.switchOff("everything");
    expect((await visitor.as("/api/v1/items")).status).toBe(503);
    expect(((await (await t.app.request("/api/v1/auth-options")).json()) as { demo: { paused: boolean } }).demo.paused).toBe(true);
    // Signing in still works (so the admin can), and the admin can use the app and switch it back on.
    const again = await t.app.request("/api/auth/sign-in/email", json({ email: "admin@demo.test", password: "demo-admin-password" }));
    expect(again.status).toBe(200);
    expect((await t.app.request("/api/v1/server/demo", { headers: { Cookie: t.admin } })).status).toBe(200);
    await t.switchOff();
    expect((await visitor.as("/api/v1/items")).status).toBe(200);
  });
});
