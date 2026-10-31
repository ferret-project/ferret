import { addDays, today } from "@ferret/shared";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { attachment, item, member, organization, user } from "../src/db/schema";
import { AiBudgetSpent, budgeted, demoNotifier, ensureDemo, resetDemo } from "../src/lib/demo";
import { serverAdmin } from "../src/lib/server-admin";
import { DEMO_HOUSEHOLD, DEMO_ITEMS } from "../src/demo/household";
import { receiptSample } from "../src/demo/receipts";
import { FakeNotifier, config, setup } from "./helpers";

async function demo(opts: Parameters<typeof setup>[0] = {}) {
  const t = await setup({ ...opts, demo: opts.demo ?? {} });
  const parts = { deps: t.deps as never, auth: t.auth, config: t.config, files: t.files };
  const planted = (await ensureDemo(parts))!;
  const made = { ...planted, householdId: planted.householdId! };
  const signIn = async (email: string, password: string) => {
    const res = await t.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return (url: string, init: RequestInit = {}) =>
      t.app.request(url, {
        ...init,
        headers: { ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), Origin: config.PUBLIC_URL, Cookie: cookie, "X-Household-Id": made.householdId, ...init.headers },
      });
  };
  // Paused, even signing in is refused.
  const asDemo = t.config.DEMO_PAUSED ? t.app.request : await signIn(t.config.DEMO_EMAIL, t.config.DEMO_PASSWORD);
  return { ...t, parts, made, asDemo };
}

// Planting the sample house (28 things) is slow on some test databases (test/db.ts): more than vitest's 5 s.
describe("the public demo", { timeout: 30_000 }, () => {
  it("won't start without its own server admin", () => {
    const base = { NODE_ENV: "test", AUTH_SECRET: config.AUTH_SECRET, FILES_KEY: config.FILES_KEY, DEMO: "true" };
    expect(() => loadConfig(base)).toThrow(/DEMO_ADMIN_EMAIL/);
    expect(loadConfig({ ...base, DEMO_ADMIN_EMAIL: "a@demo.test", DEMO_ADMIN_PASSWORD: "long-enough-password" }).DEMO).toBe(true);
  });

  it("makes its admin, the shared account and the sample household — once", async () => {
    const t = await demo();
    expect((await serverAdmin(t.db))?.email).toBe("admin@demo.test");
    const items = await t.db.select({ id: item.id }).from(item).where(eq(item.householdId, t.made.householdId));
    expect(items).toHaveLength(DEMO_ITEMS.length);
    expect(await ensureDemo(t.parts)).toEqual(t.made);

    // The shared house is the demo account's alone; the admin has a household of their own.
    const members = await t.db.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.organizationId, t.made.householdId));
    expect(members).toEqual([{ userId: t.made.demoId, role: "owner" }]);
    const [own] = await t.db.select({ role: member.role, slug: organization.slug }).from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(eq(member.userId, t.made.adminId));
    expect(own).toEqual({ role: "owner", slug: "demo-admin" });

    // Not planting (a Worker starting): accounts only.
    expect(await ensureDemo(t.parts, { plant: false })).toEqual({ demoId: t.made.demoId, adminId: t.made.adminId, householdId: null });

    // A planting cut short (the Worker stopped halfway) is cleared away.
    await t.db.insert(organization).values({ id: "half", name: "Maple Street House", slug: "demo-house-planting-half", createdAt: new Date(Date.now() - 3_600_000) });
    await ensureDemo(t.parts);
    expect(await t.db.select().from(organization).where(eq(organization.id, "half"))).toHaveLength(0);

    const list = (await (await t.asDemo("/api/v1/items")).json()) as { data: { name: string }[] };
    expect(list.data.map((i) => i.name)).toContain("Refrigerator");
    const attention = (await (await t.asDemo("/api/v1/attention")).json()) as { data: unknown[] };
    expect(attention.data.length).toBeGreaterThan(0); // overdue filter, warranty ending, toner run out…

    // No room scans on the demo (each is minutes of the model on the shared budget): hidden, and refused.
    expect(((await (await t.asDemo("/api/v1/me")).json()) as { features: { roomScan: boolean } }).features.roomScan).toBe(false);
    const form = new FormData();
    form.append("photo", new File([new Uint8Array([0xff, 0xd8, 0xff])], "room.jpg"));
    form.set("locationId", "anywhere");
    expect((await t.asDemo("/api/v1/room-scans", { method: "POST", body: form })).status).toBe(403);

    const options = (await (await t.app.request("/api/v1/auth-options")).json()) as { demo?: { email: string; password: string } };
    expect(options.demo).toMatchObject({ email: t.config.DEMO_EMAIL, password: t.config.DEMO_PASSWORD });
  });

  it("plants photos from the demo's sample files and receipts dated the day each thing was bought — each thing indexed once", async () => {
    const t = await setup({ demo: {} });
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#c33" } }).webp().toBuffer();
    const thumb = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#c33" } }).webp().toBuffer();
    await t.deps.blobs.put("demo-samples/photos/refrigerator.webp", new Uint8Array(photo), "image/webp");
    await t.deps.blobs.put("demo-samples/photos/refrigerator.thumb.webp", new Uint8Array(thumb), "image/webp");
    await t.deps.blobs.put(`demo-samples/${receiptSample({ name: "Refrigerator" })}`, new Uint8Array(thumb), "image/webp");
    const queued: string[] = [];
    const jobs = { enqueue: async (type: string, payload: unknown) => void queued.push(`${type} ${JSON.stringify(payload)}`) };
    const { householdId } = (await ensureDemo({ deps: { ...t.deps, jobs } as never, auth: t.auth, config: t.config, files: t.files }))!;

    const files = await t.db
      .select({ item: item.name, kind: attachment.kind, filename: attachment.filename, thumbnailKey: attachment.thumbnailKey, analysisStatus: attachment.analysisStatus })
      .from(attachment)
      .innerJoin(item, eq(item.id, attachment.itemId))
      .where(eq(attachment.householdId, householdId!));
    const fridge = files.filter((f) => f.item === "Refrigerator");
    expect(fridge.map((f) => f.kind).sort()).toEqual(["document", "photo"]);
    // Both with the thumbnails made ahead (a Worker can't draw a PDF), and neither sent to the vision model.
    expect(fridge.every((f) => f.thumbnailKey && f.analysisStatus === null)).toBe(true);
    const bought = addDays(today(new Date(), DEMO_HOUSEHOLD.timeZone), -DEMO_ITEMS.find((d) => d.name === "Refrigerator")!.boughtDaysAgo!);
    expect(fridge.find((f) => f.kind === "document")?.filename).toBe(`Receipt Front Range Appliance ${bought}.pdf`);
    // A photo that isn't in the sample files is left out; receipts are made anyway.
    expect(files.filter((f) => f.kind === "photo")).toHaveLength(1);
    expect(files.filter((f) => f.kind === "document")).toHaveLength(DEMO_ITEMS.filter((d) => d.receipt && d.boughtDaysAgo !== undefined).length);
    // However many times planting changed a thing, its re-index went once.
    expect(queued.length).toBe(new Set(queued).size);
  });

  it("locks what would let one visitor spoil the shared account, and hides the others' sign-ins", async () => {
    const t = await demo();
    const post = (url: string, body: unknown = {}) => t.asDemo(url, { method: "POST", body: JSON.stringify(body) });
    expect((await post("/api/auth/change-password", { currentPassword: t.config.DEMO_PASSWORD, newPassword: "mine-now-123456" })).status).toBe(403);
    expect((await post("/api/auth/two-factor/enable", { password: t.config.DEMO_PASSWORD })).status).toBe(403);
    expect((await post("/api/auth/organization/leave", { organizationId: t.made.householdId })).status).toBe(403);
    expect((await post("/api/v1/api-keys", { name: "mine" })).status).toBe(403);
    expect((await post("/api/v1/security/sessions/revoke-others")).status).toBe(403);
    expect(await (await t.asDemo("/api/v1/security/sign-ins")).json()).toEqual({ data: [] });
    expect(await (await t.asDemo("/api/auth/list-sessions")).json()).toEqual([]);
    // …but it can use the household.
    expect((await post("/api/v1/items", { name: "Visitor's guitar" })).status).toBe(201);
    // Nobody downloads everything in the demo.
    expect((await t.asDemo("/api/v1/export/everything.zip")).status).toBe(403);
    // Nobody signed in as the shared account deletes the sample house, or the account.
    const del = (url: string, body: unknown) => t.asDemo(url, { method: "DELETE", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    expect((await del("/api/v1/household", { confirm: "The Larkspur House", password: t.config.DEMO_PASSWORD })).status).toBe(403);
    expect((await del("/api/v1/security/account", { confirm: t.config.DEMO_EMAIL, password: t.config.DEMO_PASSWORD })).status).toBe(403);

    // Visitors' own accounts aren't locked.
    const visitor = await t.user("visitor");
    expect(((await (await visitor.as("/api/v1/security/sign-ins")).json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await visitor.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "mine" }) })).status).not.toBe(403);
  });

  it("plants the household afresh every night, and deletes visitors after DEMO_VISITOR_DAYS", async () => {
    const t = await demo();
    await t.asDemo("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Visitor's guitar" }) });
    const recent = await t.user("recent");
    const old = await t.user("old");
    const [oldUser] = await t.db.select({ id: user.id }).from(user).where(eq(user.email, "old@example.com"));
    await t.db.update(user).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(user.id, oldUser!.id));

    await resetDemo(t.parts);
    const [house] = await t.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, DEMO_HOUSEHOLD.slug));
    expect(house!.id).not.toBe(t.made.householdId);
    const items = await t.db.select({ name: item.name }).from(item).where(eq(item.householdId, house!.id));
    expect(items).toHaveLength(DEMO_ITEMS.length);
    expect(await t.db.select().from(item).where(eq(item.householdId, t.made.householdId))).toHaveLength(0);

    const emails = (await t.db.select({ email: user.email }).from(user)).map((u) => u.email);
    expect(emails).toContain("recent@example.com");
    expect(emails).not.toContain("old@example.com");
    expect(await t.db.select().from(organization).where(eq(organization.id, old.householdId))).toHaveLength(0);
    expect(await t.db.select().from(organization).where(eq(organization.id, recent.householdId))).toHaveLength(1);
  });

  it("emails accounts only, never the demo account or anyone typed in", async () => {
    const t = await demo();
    const sent = new FakeNotifier();
    const mail = demoNotifier(t.db, t.config, sent)!;
    const to = (email: string) => `mailtos://_?to=${encodeURIComponent(email)}`;
    await mail.send(to("admin@demo.test"), { title: "a", body: "b" });
    await mail.send(to(t.config.DEMO_EMAIL), { title: "a", body: "b" });
    await mail.send(to("stranger@example.com"), { title: "a", body: "b" });
    expect(sent.sent.map((s) => s.url)).toEqual([to("admin@demo.test")]);
  });

  it("stops AI calls once the day's budget is spent", async () => {
    const t = await demo({ demo: { DEMO_AI_PER_DAY: 2 } });
    const model = budgeted(t.db, t.config, { json: async () => ({ ok: true }) })!;
    await model.json();
    await model.json();
    await expect(model.json()).rejects.toBeInstanceOf(AiBudgetSpent);
  });

  it("rests when paused", async () => {
    const t = await demo({ demo: { DEMO_PAUSED: true } });
    expect((await t.asDemo("/api/v1/items")).status).toBe(503);
    expect((await t.app.request("/api/v1/auth-options")).status).toBe(200);
  });
});
