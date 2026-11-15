/** Webhooks: a household's events POSTed elsewhere, signed, retried, logged — and switched off when they keep failing. */
import { createHmac } from "node:crypto";
import { addDays } from "@ferret/shared/utils";
import { describe, expect, it } from "vitest";
import { WEBHOOK_STATES_JOB } from "../src/lib/webhooks";
import { WebhookError, type WebhookSender } from "../src/ports";
import { config, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

interface Post {
  url: string;
  raw: string;
  body: { id: string; type: string; version: number; household: { id: string; name: string }; data: Record<string, any> };
  headers: Record<string, string>;
  allowLocal: boolean;
}

class FakeSender implements WebhookSender {
  posts: Post[] = [];
  status = 200;
  refuse: string | null = null;
  async post(url: string, raw: string, headers: Record<string, string>, opts: { allowLocal: boolean }) {
    this.posts.push({ url, raw, body: JSON.parse(raw), headers, allowLocal: opts.allowLocal });
    if (this.refuse) throw new WebhookError(this.refuse);
    return { status: this.status };
  }
  of(type: string) {
    return this.posts.filter((p) => p.body.type === type);
  }
}

/** The receiver's side: is `header` a fresh signature of `raw` by `secret`? */
function verify(raw: string, header: string, secret: string) {
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")![1];
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && parts.some(([k, v]) => k === "v1" && v === expected);
}

const hook = { name: "n8n", url: "https://hooks.example.com/ferret/abc123", events: ["item.created", "item.updated", "item.gone", "item.deleted", "stock.low"] };

describe("webhooks", () => {
  it("posts item changes as they happen, signed, with links into the app and never notes", async () => {
    const sender = new FakeSender();
    const { user, jobs } = await setup({ webhooks: sender });
    const ann = await user("ann");
    const made = await send(ann, "POST", "/api/v1/webhooks", hook);
    expect(made.status).toBe(201);
    const w = await json<{ id: string; secret: string; host: string; local: boolean }>(made);
    expect(w).toMatchObject({ host: "hooks.example.com", local: true });
    expect(w.secret).toMatch(/^whsec_[\w-]{40,}$/);
    expect(JSON.stringify(await json(ann.as("/api/v1/webhooks")))).not.toContain("abc123"); // the address may hold a token

    const drill = await ann.addItem({ name: "Drill", brand: "DeWalt", notes: "Spare key in the case", minQuantity: 1, quantity: 3 });
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { valueCents: 9500 });
    await send(ann, "POST", `/api/v1/items/${drill.id}/stock`, { delta: -1 }); // 3 → 2: not low yet
    await send(ann, "POST", `/api/v1/items/${drill.id}/stock`, { delta: -1 }); // 2 → 1: at its minimum
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { disposition: "sold" });
    await send(ann, "DELETE", `/api/v1/items/${drill.id}`);
    await jobs.drain();

    expect(sender.posts.map((p) => p.body.type)).toEqual(["item.created", "item.updated", "stock.low", "item.gone", "item.deleted"]);
    const created = sender.of("item.created")[0]!;
    expect(created.url).toBe(hook.url);
    expect(created.allowLocal).toBe(true); // ann runs this server
    expect(created.body).toMatchObject({ version: 1, household: { id: ann.householdId, name: "ann home" }, data: { item: { id: drill.id, name: "Drill", brand: "DeWalt", url: `${config.PUBLIC_URL}/#/items/${drill.id}` } } });
    expect(created.headers["Ferret-Event"]).toBe("item.created");
    expect(created.headers["Ferret-Event-Id"]).toBe(created.body.id);
    expect(verify(created.raw, created.headers["Ferret-Signature"]!, w.secret)).toBe(true);
    expect(verify(created.raw, created.headers["Ferret-Signature"]!, "whsec_other")).toBe(false);
    expect(sender.posts.some((p) => p.raw.includes("Spare key"))).toBe(false);
    expect(sender.of("item.updated")[0]!.body.data.summary).toMatch(/value/);
    expect(sender.of("stock.low")[0]!.body.data).toMatchObject({ quantity: 1, minQuantity: 1, out: false });
    expect(sender.of("item.deleted")[0]!.body.data).toEqual({ item: { id: drill.id, name: "Drill" } });

    // The log has each delivery, sent.
    const log = await json<{ data: { event: string; status: string; responseStatus: number }[] }>(ann.as(`/api/v1/webhooks/${w.id}/deliveries`));
    expect(log.data).toHaveLength(5);
    expect(log.data.every((d) => d.status === "sent" && d.responseStatus === 200)).toBe(true);
  });

  it("retries, then switches a webhook off after deliveries keep failing — the bell says so, and it can be turned on again", async () => {
    const sender = new FakeSender();
    const { user, jobs } = await setup({ webhooks: sender, maxAttempts: 1 });
    const ann = await user("ann");
    const w = await json<{ id: string }>(send(ann, "POST", "/api/v1/webhooks", { ...hook, events: ["item.created"] }));
    sender.status = 500;
    for (let i = 0; i < 5; i++) await ann.addItem({ name: `Thing ${i}` });
    await jobs.drain();
    const [listed] = (await json<{ data: { failures: number; disabledAt: string | null; lastError: string }[] }>(ann.as("/api/v1/webhooks"))).data;
    expect(listed).toMatchObject({ failures: 5, disabledAt: expect.any(String), lastError: "It answered 500" });
    const bell = await json<{ data: { title: string; href?: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data).toContainEqual(expect.objectContaining({ title: "Webhook “n8n” was switched off", href: "#/settings/api" }));

    // Switched off: nothing more is sent.
    const before = sender.posts.length;
    await ann.addItem({ name: "Quiet" });
    await jobs.drain();
    expect(sender.posts.length).toBe(before);

    // Fixed, and on again; a failed delivery sent again by hand keeps its event id.
    sender.status = 204;
    expect(await json(send(ann, "PATCH", `/api/v1/webhooks/${w.id}`, { paused: false }))).toMatchObject({ failures: 0, disabledAt: null });
    const failed = (await json<{ data: { id: string; eventId: string; status: string }[] }>(ann.as(`/api/v1/webhooks/${w.id}/deliveries`))).data.find((d) => d.status === "failed")!;
    expect((await send(ann, "POST", `/api/v1/webhooks/${w.id}/deliveries/${failed.id}/retry`)).status).toBe(200);
    await jobs.drain();
    expect(sender.posts.at(-1)!.body.id).toBe(failed.eventId);
    expect((await json<{ data: { id: string; status: string }[] }>(ann.as(`/api/v1/webhooks/${w.id}/deliveries`))).data.find((d) => d.id === failed.id)!.status).toBe("sent");
  });

  it("pauses, tests, shows and rotates the secret (the old one signs for a while)", async () => {
    const sender = new FakeSender();
    const { user, jobs } = await setup({ webhooks: sender });
    const ann = await user("ann");
    const w = await json<{ id: string; secret: string }>(send(ann, "POST", "/api/v1/webhooks", { ...hook, events: ["item.created"] }));
    expect(await json(send(ann, "POST", `/api/v1/webhooks/${w.id}/secret`))).toEqual({ secret: w.secret });

    await send(ann, "PATCH", `/api/v1/webhooks/${w.id}`, { paused: true });
    await ann.addItem({ name: "While paused" });
    await jobs.drain();
    expect(sender.posts).toHaveLength(0);

    // A test goes even while paused, and says how it was answered.
    sender.status = 404;
    expect(await json(send(ann, "POST", `/api/v1/webhooks/${w.id}/test`))).toEqual({ delivered: false, status: 404, error: "It answered 404" });
    sender.refuse = "Couldn't reach hooks.example.com (ECONNREFUSED)";
    expect(await json(send(ann, "POST", `/api/v1/webhooks/${w.id}/test`))).toMatchObject({ delivered: false, status: null, error: sender.refuse });
    sender.refuse = null;
    sender.status = 200;
    expect(await json(send(ann, "POST", `/api/v1/webhooks/${w.id}/test`))).toEqual({ delivered: true, status: 200, error: null });
    expect(sender.posts.at(-1)!.body).toMatchObject({ type: "ping", data: { webhook: { id: w.id, name: "n8n" } } });

    const { secret } = await json<{ secret: string }>(send(ann, "POST", `/api/v1/webhooks/${w.id}/rotate`));
    expect(secret).not.toBe(w.secret);
    await send(ann, "PATCH", `/api/v1/webhooks/${w.id}`, { paused: false });
    await ann.addItem({ name: "After rotating" });
    await jobs.drain();
    const last = sender.posts.at(-1)!;
    expect(verify(last.raw, last.headers["Ferret-Signature"]!, secret)).toBe(true);
    expect(verify(last.raw, last.headers["Ferret-Signature"]!, w.secret)).toBe(true);
    expect((await json<{ data: { previousSecretUntil: string | null }[] }>(ann.as("/api/v1/webhooks"))).data[0]!.previousSecretUntil).toEqual(expect.any(String));
  });

  it("sends what needs attention once, when it first does", async () => {
    const sender = new FakeSender();
    const { user, jobs } = await setup({ webhooks: sender });
    const ann = await user("ann");
    await send(ann, "POST", "/api/v1/webhooks", { ...hook, events: ["task.due", "task.overdue", "warranty.ending"] });
    const heater = await ann.addItem({ name: "Water heater" });
    const soon = addDays(new Date().toISOString().slice(0, 10), 3);
    const task = await json<{ id: string }>(send(ann, "POST", "/api/v1/maintenance", { title: "Flush it", itemId: heater.id, dueOn: soon, intervalCount: 1, intervalUnit: "year" }));
    await send(ann, "POST", `/api/v1/items/${heater.id}/warranties`, { endsOn: addDays(soon, 7) });

    await jobs.enqueue(WEBHOOK_STATES_JOB, {});
    await jobs.drain();
    const due = sender.of("task.due");
    expect(due).toHaveLength(1);
    expect(due[0]!.body.data.task).toMatchObject({ id: task.id, date: soon, item: { id: heater.id, name: "Water heater" } });
    expect(sender.of("warranty.ending")[0]!.body.data.warranty).toMatchObject({ itemId: heater.id, item: { name: "Water heater" } });

    // The next hour: nothing new.
    await jobs.enqueue(WEBHOOK_STATES_JOB, {});
    await jobs.drain();
    expect(sender.posts).toHaveLength(2);

    // Moved to another day: due again.
    await send(ann, "PATCH", `/api/v1/maintenance/${task.id}`, { dueOn: addDays(soon, 1) });
    await jobs.enqueue(WEBHOOK_STATES_JOB, {});
    await jobs.drain();
    expect(sender.of("task.due")).toHaveLength(2);
  });

  it("keeps the server's own network for whoever runs it, and webhooks for owners and admins", async () => {
    const sender = new FakeSender();
    const { user, jobs } = await setup({ webhooks: sender });
    await user("ann"); // the first account runs the server
    const bob = await user("bob");
    for (const url of ["http://10.0.0.5:5678/webhook/x", "http://homeassistant.local:8123/api/webhook/x", "http://n8n/webhook/x", "http://[fd00::1]/x"]) {
      const res = await send(bob, "POST", "/api/v1/webhooks", { ...hook, url });
      expect(res.status, url).toBe(403);
    }
    const w = await json<{ id: string; local: boolean }>(send(bob, "POST", "/api/v1/webhooks", { ...hook, events: ["item.created"] }));
    expect(w.local).toBe(false);
    expect((await send(bob, "PATCH", `/api/v1/webhooks/${w.id}`, { url: "http://192.168.1.10/x" })).status).toBe(403);
    await bob.addItem({ name: "Bike" });
    await jobs.drain();
    expect(sender.posts[0]!.allowLocal).toBe(false); // the sender checks resolved addresses too

    // Not with an API key, and not for someone else's household.
    const key = await json<{ key: string }>(send(bob, "POST", "/api/v1/api-keys", { name: "script" }));
    const { app } = await setup();
    expect((await app.request("/api/v1/webhooks", { headers: { Authorization: `Bearer ${key.key}` } })).status).toBeGreaterThanOrEqual(401);
    const carl = await user("carl");
    expect((await send(carl, "DELETE", `/api/v1/webhooks/${w.id}`)).status).toBe(404);
    expect((await send(carl, "POST", `/api/v1/webhooks/${w.id}/secret`)).status).toBe(404);
  });

  it("is off on a server that can't send them", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await json(ann.as("/api/v1/webhooks"))).toMatchObject({ enabled: false, data: [] });
    expect((await send(ann, "POST", "/api/v1/webhooks", hook)).status).toBe(409);
  });
});
