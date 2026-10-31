/** Plans and usage (lib/plan.ts): counted on every server, limited only by a plan (Deps.entitlements). */
import type { PlanReport } from "@ferret/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Extensions } from "../src/app";
import { householdSetting, member } from "../src/db/schema";
import { jobSchedule } from "../src/jobs/schedule";
import { type AppEnv, requireUser } from "../src/lib/context";
import type { Entitlements, HouseholdPlan } from "../src/ports";
import { FakeAi, FakeDocuments, FakeProducts, MemoryVectors, pdf, photo, setup } from "./helpers";

const describePhoto = { description: "A yellow drill.", text: "", name: "Drill", brand: null, model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null };
const answer = { answer: "In the garage.", found: true, sources: [1] };

/** A plan per household that the test can change as it goes. */
function plans(limits: Partial<HouseholdPlan["limits"]> = {}, name = "Plus") {
  const plan: HouseholdPlan = {
    name,
    limits: { items: null, fileBytes: null, members: null, ai: true, aiActions: null, barcodeLookups: null, apiKeys: true, shareLinks: true, calendarFeeds: true, ...limits },
    period: { start: "2026-10-03", end: "2026-11-03" },
    upgradeUrl: "https://billing.example/upgrade",
    manageUrl: "https://billing.example/manage",
    status: "Cancelled — Plus stays on until November 3, 2026",
    links: [{ label: "Link Discord", url: "https://billing.example/discord" }],
  };
  const entitlements: Entitlements = { plan: async () => plan };
  return { plan, entitlements };
}

const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });

async function report(as: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const res = await as("/api/v1/plan");
  expect(res.status).toBe(200);
  return (await res.json()) as PlanReport;
}

describe("usage without a plan (a home Ferret)", () => {
  it("counts each person's AI and limits nothing", async () => {
    const ai = new FakeAi([describePhoto, answer]);
    const env = await setup({ ai, vectors: new MemoryVectors() });
    const pat = await env.user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await pat.upload(drill.id, await photo(), "drill.jpg");
    await env.jobs.drain();
    expect((await pat.as("/api/v1/ask", post({ question: "where is the drill?" }))).status).toBe(200);

    const r = await report(pat.as);
    expect(r.plan).toBeNull();
    expect(r.period).toEqual({ start: new Date().toISOString().slice(0, 7), end: null });
    // A photo is 2 AI actions, a question 1.
    expect(r.aiActions).toEqual({ used: 3, limit: null });
    expect(r.items).toEqual({ used: 1, limit: null });
    expect(r.fileBytes.used).toBeGreaterThan(0);
    expect(r.members).toEqual({ used: 1, limit: null });
    expect(r.people).toEqual([{ userId: expect.any(String), name: "pat", aiActions: 3, asks: 1, photos: 1, documents: 0, barcodeLookups: 0 }]);
  });

  it("doesn't count a question the model was never asked", async () => {
    const env = await setup({ ai: new FakeAi([answer]), vectors: new MemoryVectors() });
    const pat = await env.user("pat");
    await pat.as("/api/v1/ask", post({ question: "where is the zxqv?" }));
    expect((await report(pat.as)).aiActions.used).toBe(0);
  });

  it("notes the day the household was last used, once a day", async () => {
    const env = await setup();
    const pat = await env.user("pat");
    await pat.as("/api/v1/items");
    const read = async () => (await env.db.select().from(householdSetting).where(eq(householdSetting.householdId, pat.householdId)))[0];
    const today = new Date().toISOString().slice(0, 10);
    const first = await read();
    expect(first?.lastActiveOn).toBe(today);
    await pat.as("/api/v1/items");
    expect((await read())?.updatedAt).toEqual(first?.updatedAt); // no second write today
  });

  it("is only for the household's own members", async () => {
    const env = await setup();
    expect((await env.app.request("/api/v1/plan")).status).toBe(401);
  });
});

describe("a plan's limits", () => {
  it("stops adding things past the plan, including imports and restores", async () => {
    const { entitlements } = plans({ items: 2 }, "Free");
    const env = await setup({ entitlements });
    const pat = await env.user("pat");
    await pat.addItem({ name: "Drill" });
    const saw = await pat.addItem({ name: "Saw" });
    const third = await pat.as("/api/v1/items", post({ name: "Ladder" }));
    expect(third.status).toBe(402);
    expect(((await third.json()) as { error: { message: string } }).error.message).toContain("The Free plan holds 2 things");

    // Deleting one makes room; an import fills it and skips the rest, saying why.
    expect((await pat.as(`/api/v1/items/${saw.id}`, { method: "DELETE" })).status).toBe(204);
    const imported = (await (await pat.as("/api/v1/import", post({ source: "csv", name: "stuff.csv", rows: [{ name: "Hammer" }, { name: "Level" }] }))).json()) as {
      created: number;
      skipped: { index: number; reason: string }[];
    };
    expect(imported.created).toBe(1);
    expect(imported.skipped).toEqual([{ index: 1, reason: expect.stringContaining("room for things is full") }]);
    // Full again: the deleted saw can't come back until there's room.
    expect((await pat.as(`/api/v1/trash/items/${saw.id}/restore`, { method: "POST" })).status).toBe(402);
    expect((await report(pat.as)).items).toEqual({ used: 2, limit: 2 });
  });

  it("stops uploads past the plan's room for files", async () => {
    const { entitlements } = plans({ fileBytes: 2_000 });
    const env = await setup({ entitlements });
    const pat = await env.user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await pat.upload(drill.id, pdf("receipt"), "receipt.pdf", "document");
    const form = new FormData();
    form.set("file", new File([await photo()], "big.jpg"));
    form.set("kind", "photo");
    const res = await pat.as(`/api/v1/items/${drill.id}/attachments`, { method: "POST", body: form });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("holds 2 KB of photos and files");
  });

  it("without AI: no Ask, no photo suggestions, and search by words only", async () => {
    const { entitlements } = plans({ ai: false }, "Basic");
    const ai = new FakeAi([describePhoto]);
    const env = await setup({ ai, vectors: new MemoryVectors(), entitlements });
    const pat = await env.user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    const up = await pat.upload(drill.id, await photo(), "drill.jpg");
    expect(up.analysisStatus).toBeNull(); // kept, not analysed
    await env.jobs.drain();
    expect(ai.calls).toHaveLength(0);

    const asked = await pat.as("/api/v1/ask", post({ question: "where is the drill?" }));
    expect(asked.status).toBe(402);
    expect(((await asked.json()) as { error: { message: string } }).error.message).toBe("AI isn't part of the Basic plan.");

    ai.embedCalls.length = 0;
    expect((await pat.search("drill")).data.map((i) => i.name)).toEqual(["Drill"]);
    expect(ai.embedCalls.filter((c) => c.purpose === "query")).toHaveLength(0); // no meaning search
    expect((await report(pat.as)).aiActions).toEqual({ used: 0, limit: 0 });
  });

  it("stops AI at the period's allowance, and the report says who used it", async () => {
    const { plan, entitlements } = plans({ aiActions: 3 });
    const ai = new FakeAi([describePhoto, answer, answer]);
    const env = await setup({ ai, vectors: new MemoryVectors(), documents: new FakeDocuments(["Receipt"]), entitlements });
    const pat = await env.user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    await pat.upload(drill.id, await photo(), "drill.jpg"); // 2
    await env.jobs.drain();
    expect((await pat.as("/api/v1/ask", post({ question: "where is the drill?" }))).status).toBe(200); // 3
    const over = await pat.as("/api/v1/ask", post({ question: "where is the drill?" }));
    expect(over.status).toBe(402);
    expect(((await over.json()) as { error: { message: string } }).error.message).toBe(
      "This period's 3 AI actions are used up — they come back on 2026-11-03.",
    );
    // Another photo is kept without suggestions.
    expect((await pat.upload(drill.id, await photo(), "drill-2.jpg")).analysisStatus).toBeNull();

    const r = await report(pat.as);
    expect(r.plan).toEqual({ name: "Plus", limits: plan.limits, upgradeUrl: "https://billing.example/upgrade", manageUrl: "https://billing.example/manage", links: [{ label: "Link Discord", url: "https://billing.example/discord" }], status: "Cancelled — Plus stays on until November 3, 2026" });
    expect(r.period).toEqual({ start: "2026-10-03", end: "2026-11-03" });
    expect(r.aiActions).toEqual({ used: 3, limit: 3 });
    expect(r.people[0]).toMatchObject({ name: "pat", aiActions: 3, asks: 1, photos: 1 });

    // A new period starts from nothing.
    plan.period = { start: "2026-11-03", end: "2026-12-03" };
    expect((await pat.as("/api/v1/ask", post({ question: "where is the drill?" }))).status).toBe(200);
  });

  it("limits online barcode lookups, not the household's own barcode book", async () => {
    const { entitlements } = plans({ barcodeLookups: 1 });
    const products = new FakeProducts({ "0012345678905": { title: "Cordless drill", brand: "DeWalt" } as never, "0098765432109": { title: "Saw" } as never });
    const env = await setup({ products, entitlements });
    const pat = await env.user("pat");
    await pat.as("/api/v1/barcodes/012345678905");
    await pat.as("/api/v1/barcodes/098765432109");
    expect(products.calls).toEqual(["0012345678905"]);
    expect((await report(pat.as)).barcodeLookups).toEqual({ used: 1, limit: 1 });
  });

  it("has no barcode lookup meter on a server without an online barcode database", async () => {
    const env = await setup({ entitlements: plans({ barcodeLookups: 50 }).entitlements });
    const pat = await env.user("pat");
    expect((await report(pat.as)).barcodeLookups).toBeNull();
  });

  it("limits the people in a household", async () => {
    const { entitlements } = plans({ members: 1 }, "Free");
    const env = await setup({ entitlements });
    const owner = await env.user("owner");
    const invite = await owner.as("/api/auth/organization/invite-member", post({ email: "sam@example.com", role: "member" }));
    expect(invite.status).toBe(403);
    expect(((await invite.json()) as { message: string }).message).toBe("This household's plan has room for 1 person — upgrade to invite more.");
    expect((await report(owner.as)).members).toEqual({ used: 1, limit: 1 });
  });
});

describe("features a plan can leave out", () => {
  it("API keys, MCP, share links and calendar feeds: not on Free, and what was made before pauses until the plan has them again", async () => {
    const { plan, entitlements } = plans();
    const env = await setup({ entitlements });
    const pat = await env.user("pat");
    await pat.addItem({ name: "Drill" });
    const made = async (url: string, body: object = {}) => {
      const res = await pat.as(url, post(body));
      expect(res.status).toBe(201);
      return (await res.json()) as { key?: string; url: string };
    };
    const { key } = await made("/api/v1/api-keys", { name: "Claude" });
    const share = new URL((await made("/api/v1/shares", { kind: "report", days: 30 })).url).pathname.split("/s/")[1]!;
    const feed = new URL((await made("/api/v1/calendar")).url).pathname;
    const withKey = (url: string, init: RequestInit = {}) =>
      env.app.request(url, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" } });
    const mcpList = () => withKey("/mcp", post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    const working = async () => {
      expect((await withKey("/api/v1/items")).status).toBe(200);
      expect((await mcpList()).status).not.toBe(402);
      expect((await env.app.request(`/api/v1/shared/${share}`)).status).toBe(200);
      expect((await env.app.request(feed)).status).toBe(200);
    };
    await working();

    // The subscription lapses: back on Free, which has none of them.
    plan.name = "Free";
    Object.assign(plan.limits, { apiKeys: false, shareLinks: false, calendarFeeds: false });
    const keys = await withKey("/api/v1/items");
    expect(keys.status).toBe(402);
    expect(((await keys.json()) as { error: { message: string } }).error.message).toBe("API keys (scripts and Claude) aren't part of the Free plan — upgrade to use them.");
    const mcp = await mcpList();
    expect(mcp.status).toBe(402);
    expect(await mcp.json()).toMatchObject({ error: { message: "API keys (scripts and Claude) aren't part of the Free plan — upgrade to use them." } });
    // Someone opening a shared link has no account here: it says paused, not why.
    const opened = await env.app.request(`/api/v1/shared/${share}`);
    expect(opened.status).toBe(403);
    expect(((await opened.json()) as { error: { message: string } }).error.message).toBe("This link is paused — ask whoever shared it");
    expect((await env.app.request(`/api/v1/shared/${share}/items.csv`)).status).toBe(403);
    expect((await env.app.request(feed)).status).toBe(403);
    // Nothing new — but nothing is deleted either: the key and the link are still listed.
    expect((await pat.as("/api/v1/api-keys", post({ name: "another" }))).status).toBe(402);
    expect((await pat.as("/api/v1/shares", post({ kind: "report", days: 7 }))).status).toBe(402);
    expect((await pat.as("/api/v1/calendar", post({}))).status).toBe(402);
    expect(((await (await pat.as("/api/v1/api-keys")).json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(((await (await pat.as("/api/v1/shares")).json()) as { data: unknown[] }).data).toHaveLength(1);

    // Subscribed again: the same key, link and feed work.
    plan.name = "Basic";
    Object.assign(plan.limits, { apiKeys: true, shareLinks: true, calendarFeeds: true });
    await working();
  });
});

describe("starting households", () => {
  it("follows the plan's rule, with its reason", async () => {
    // A service's rule: one household an account (e.g. one *free* household).
    const entitlements: Entitlements = {
      plan: async () => null,
      mayCreateHousehold: async (userId) => {
        const owned = await env.db.select().from(member).where(and(eq(member.userId, userId), eq(member.role, "owner")));
        return owned.length ? "You already have a free household — upgrade it to start another." : null;
      },
    };
    const env = await setup({ entitlements });
    const pat = await env.user("pat"); // its first household: allowed
    const second = await pat.as("/api/auth/organization/create", post({ name: "Cabin", slug: "pat-cabin" }));
    expect(second.status).toBe(403);
    expect(((await second.json()) as { message: string }).message).toBe("You already have a free household — upgrade it to start another.");
  });

  it("is up to Ferret's own ceiling without a rule", async () => {
    const env = await setup({ entitlements: plans().entitlements });
    const pat = await env.user("pat");
    expect((await pat.as("/api/auth/organization/create", post({ name: "Cabin", slug: "pat-cabin" }))).status).toBe(200);
  });
});

describe("extensions", () => {
  it("add routes and background work alongside Ferret's own", async () => {
    let daily = 0;
    const extensions: Extensions = {
      routes: (app) => {
        const billing = new Hono<AppEnv>();
        billing.use("/*", requireUser);
        billing.get("/hello", (c) => c.json({ hi: c.var.user.name }));
        app.route("/api/v1/billing", billing);
      },
      jobs: () => ({ handlers: { "billing.sync": async () => {} }, daily: async () => void daily++ }),
    };
    const env = await setup({ extensions });
    expect((await env.app.request("/api/v1/billing/hello")).status).toBe(401);
    const pat = await env.user("pat");
    expect(await (await pat.as("/api/v1/billing/hello")).json()).toEqual({ hi: "pat" });

    const { auth, files, config, jobs, deps } = env;
    const schedule = jobSchedule({ deps, files, auth, config, jobs, extensions });
    expect(schedule.handlers["billing.sync"]).toBeTypeOf("function");
    await schedule.daily();
    expect(daily).toBe(1);
  });
});
