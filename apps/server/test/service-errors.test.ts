/** The service error log: failed calls to the services Ferret uses, for the server admin — listed, in the bell, alerted. */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { job } from "../src/db/schema";
import { NEW_ACCOUNT_JOB, newAccountAlert } from "../src/jobs/new-account";
import { aboutServer, alertServiceErrors, listServiceErrors, watched } from "../src/lib/service-errors";
import { ServiceFailure, type Reranker, type TextModel } from "../src/ports";
import { jobSchedule } from "../src/jobs/schedule";
import { FakeNotifier, config, setup } from "./helpers";

const about = aboutServer(config, {});

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

describe("service errors", () => {
  it("records each failure, counted, without changing what the caller sees", async () => {
    const { db } = await setup();
    let calls = 0;
    const reranker = watched<Reranker>(db, "reranker", {
      rerank: async () => {
        calls++;
        throw new Error("connect ECONNREFUSED 10.0.0.9:8002 (token=s3cret)");
      },
    })!;
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow("ECONNREFUSED");
    await expect(reranker.rerank("q", ["b"])).rejects.toThrow("ECONNREFUSED");
    await new Promise((r) => setTimeout(r, 20)); // recorded in the background
    expect(calls).toBe(2);
    expect(await listServiceErrors(db, about)).toEqual([
      expect.objectContaining({ service: "reranker", serviceName: "Reranker", operation: "rerank", message: "connect ECONNREFUSED 10.0.0.9:8002 (token=…)", count: 2 }),
    ]);
  });

  it("keep the latest one's details for triage: how long, called from where, what the adapter knew", async () => {
    const { db } = await setup();
    const chat = watched<TextModel>(db, "chat", {
      json: async () => {
        await new Promise((r) => setTimeout(r, 15));
        throw new ServiceFailure("gpt reply wasn't JSON, twice (finished: length, length)", { model: "gpt", finishReason: "length, length", replyStart: "{" });
      },
    })!;
    async function judgeSomething() {
      return chat.json({ prompt: "secret prompt", schema: {} });
    }
    await judgeSomething().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    const [entry] = await listServiceErrors(db, about);
    expect(entry!.detail).toMatchObject({ kind: "ServiceFailure", detail: { model: "gpt", finishReason: "length, length" } });
    expect((entry!.detail as { ms: number }).ms).toBeGreaterThanOrEqual(10);
    expect((entry!.detail as { calledFrom: string[] }).calledFrom[0]).toMatch(/^judgeSomething \(service-errors\.test\.ts:\d+\)$/);
    expect(entry!.triage).toContain("Chat model (chat.json) — ");
    expect(entry!.triage).toContain("  finishReason: length, length");
    expect(entry!.triage).toMatch(/called from: judgeSomething \(service-errors\.test\.ts:\d+\)/);
    expect(entry!.triage).toContain(`server: localhost:8787 (self-hosted, ${navigator.userAgent}) · Ferret dev`);
    expect(entry!.triage).not.toContain("secret prompt");
  });

  it("email the triage notes (only the email: push and chat apps get the short version)", async () => {
    const notifier = new FakeNotifier();
    const MAIL = "mailtos://x:y@mail.example.com";
    const { db, files, user } = await setup({ notifier, mailUrl: MAIL });
    await user("ann");
    const chat = watched<TextModel>(db, "chat", { json: async () => Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.9:8000") })) })!;
    await chat.json({ prompt: "x", schema: {} }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(await alertServiceErrors({ db, push: undefined, notifier, files, appUrl: config.PUBLIC_URL, about, mailUrl: MAIL })).toBe(1);
    const [mail] = notifier.sent as { title: string; body: string }[];
    expect(mail!.title).toBe("Ferret can't reach Chat model (localhost:8787)");
    expect(mail!.body).toContain("── For triage ──");
    expect(mail!.body).toContain("error: TypeError");
    expect(mail!.body).toContain("cause: Error: connect ECONNREFUSED 10.0.0.9:8000");
  });

  it("include background jobs that gave up for good (not the tries before)", async () => {
    const env = await setup();
    const fail = async () => {
      throw new Error("docling: 502");
    };
    const schedule = jobSchedule({
      deps: env.deps,
      files: env.files,
      auth: env.auth,
      config,
      jobs: { enqueue: async () => {} },
      extensions: { jobs: () => ({ handlers: { "test.fail": fail } }) },
    });
    await expect(schedule.handlers["test.fail"]!({}, { lastAttempt: false })).rejects.toThrow("docling: 502");
    expect(await listServiceErrors(env.db, about)).toEqual([]);
    await expect(schedule.handlers["test.fail"]!({}, { lastAttempt: true })).rejects.toThrow("docling: 502");
    expect(await listServiceErrors(env.db, about)).toEqual([expect.objectContaining({ service: "jobs", serviceName: "Background jobs (gave up)", operation: "test.fail", message: "docling: 502" })]);
  });

  it("shows the server admin, in Settings → Server and the bell, and tells them once", async () => {
    const notifier = new FakeNotifier();
    const MAIL = "mailtos://x:y@mail.example.com";
    const { app, db, files, user } = await setup({ notifier, mailUrl: MAIL });
    const ann = await user("ann"); // the first account: the server admin
    const bob = await user("bob");
    const chat = watched<TextModel>(db, "chat", { json: async () => Promise.reject(new Error("vLLM: 503 Service Unavailable")) })!;
    await chat.json({ prompt: "x", schema: {} }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(await json(ann.as("/api/v1/server/errors"))).toMatchObject({ data: [{ service: "chat", message: "vLLM: 503 Service Unavailable", count: 1 }] });
    expect((await bob.as("/api/v1/server/errors")).status).toBe(403);
    const bell = await json<{ data: { kind: string; severity: string; title: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data).toContainEqual(expect.objectContaining({ kind: "service", severity: "urgent", title: "Chat model is failing" }));
    expect((await json<{ data: { kind: string }[] }>(bob.as("/api/v1/attention"))).data.some((a) => a.kind === "service")).toBe(false);

    const alert = (now: Date) => alertServiceErrors({ db, push: undefined, notifier, files, appUrl: config.PUBLIC_URL, about, mailUrl: MAIL, now });
    expect(await alert(new Date())).toBe(1);
    expect(notifier.sent).toEqual([expect.objectContaining({ title: "Ferret can't reach Chat model (localhost:8787)", url: expect.stringContaining("to=ann%40example.com") })]);
    expect(await alert(new Date())).toBe(0); // told already
    await chat.json({ prompt: "x", schema: {} }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(await alert(new Date())).toBe(0); // new failures, but within 6 hours of the last alert
    expect(await alert(new Date(Date.now() + 7 * 60 * 60 * 1000))).toBe(1);

    expect((await ann.as("/api/v1/server/errors", { method: "DELETE" })).status).toBe(204);
    expect(await json(ann.as("/api/v1/server/errors"))).toEqual({ data: [] });
    void app;
  });

  it("also go to the admins' Discord channel (ADMIN_WEBHOOK_URL), once per 6 hours like the rest", async () => {
    const { db, files, user } = await setup();
    await user("ann");
    const chat = watched(db, "chat", { json: async () => Promise.reject(new Error("vLLM: 503")) } as unknown as TextModel) as unknown as { json: () => Promise<unknown> };
    await chat.json().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const hook = "https://discord.com/api/webhooks/123/abc";
    expect(await alertServiceErrors({ db, push: undefined, notifier: new FakeNotifier(), files, appUrl: config.PUBLIC_URL, about, adminWebhook: hook })).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(hook);
    const body = JSON.parse(String((init as RequestInit).body)) as { content: string; allowed_mentions: unknown; username: string; avatar_url: string };
    expect(body.content).toContain("Ferret can't reach Chat model");
    expect(body.content).toContain("vLLM: 503");
    expect(body.allowed_mentions).toEqual({ parse: [] }); // no @everyone from an error message
    expect(body).toMatchObject({ username: "Ferret", avatar_url: `${config.PUBLIC_URL}/icon-192.png` }); // the paw
    fetch.mockRestore();
  });

  it("include Ferret's own unexpected errors (a 500), by route", async () => {
    const env = await setup({
      extensions: {
        routes: (app) => {
          app.get("/api/v1/boom/:id", () => {
            throw new Error("kaboom");
          });
        },
      },
    });
    const ann = await env.user("ann");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await env.app.request("/api/v1/boom/1")).status).toBe(500);
    expect((await env.app.request("/api/v1/boom/2")).status).toBe(500);
    quiet.mockRestore();
    expect(await json(ann.as("/api/v1/server/errors"))).toMatchObject({
      data: [{ service: "ferret", serviceName: "Ferret itself (unexpected errors)", operation: "GET /api/v1/boom/:id", message: "kaboom", count: 2 }],
    });
  });

  it("say when someone signs up (ADMIN_WEBHOOK_URL) — the totals, never who", async () => {
    const hook = "https://discord.com/api/webhooks/123/abc";
    const { db, user } = await setup({ adminWebhook: hook });
    await user("ann");
    await user("bob");
    expect((await db.select().from(job).where(eq(job.type, NEW_ACCOUNT_JOB))).length).toBeGreaterThan(0);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await newAccountAlert({ db, appUrl: config.PUBLIC_URL, adminWebhook: hook })({}, { lastAttempt: false });
    const body = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body)) as { content: string };
    expect(body.content).toContain("Someone signed up");
    expect(body.content).toMatch(/has 2 accounts now \(2 with a confirmed email\)/);
    expect(body.content).not.toMatch(/ann|bob|@/);
    fetch.mockRestore();

    const quiet = await setup();
    await quiet.user("cy");
    expect(await quiet.db.select().from(job).where(eq(job.type, NEW_ACCOUNT_JOB))).toEqual([]);
  });
});
