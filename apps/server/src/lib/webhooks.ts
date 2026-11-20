/**
 * Webhooks: a household's events POSTed as JSON to another app (n8n, Home Assistant, a script) — Settings → Claude &
 * API, for the household's owner and admins with a real sign-in.
 *
 * - Changes are sent as they happen (`emitEvent` from the service layer: items added, changed, gone, deleted, imported,
 *   running low); what needs attention (a task due or overdue, a warranty ending, a return window closing, a recall, a
 *   loan due back) is sent once, when it first does (`webhookStatesJob`, hourly: `webhook_sent` remembers what was).
 * - Each event has an `id` (the same in every delivery of it — receivers dedupe on it) and a `version`. The body never
 *   holds notes, only ids, names and a few plain details; links point into the app.
 * - Signed like Stripe's: `Ferret-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, so an old delivery
 *   can't be replayed later. After a rotation the old secret signs too (a second v1) for a day.
 * - Delivered by a job (retried with backoff); every try is in the delivery log (30 days). Deliveries that keep
 *   failing switch the webhook off (FAILURES_TO_DISABLE in a row) and the bell says so.
 * - Where it may post: the public internet — or, set up by whoever runs this Ferret (the server admin), the server's
 *   own network too (`allowLocal`). The WebhookSender port enforces it when connecting.
 */
import { WEBHOOK_EVENTS, type WebhookDelivery, type WebhookEvent, type WebhookInput, type WebhookPatch, type WebhookSummary } from "@ferret/shared";
import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, member, organization, webhook, webhookDelivery, webhookSent } from "../db/schema";
import { type Db, type Deps, type JobHandler, WebhookError } from "../ports";
import type { FileStore } from "./files";
import { type Caller, itemScope, locationPaths, notFound } from "./inventory";
import { needsAttention } from "./attention";
import { listLoans } from "./loans";
import { householdLocale, todayFor } from "./household-time";
import { localHostName } from "./notifications";
import { isServerAdmin } from "./server-admin";
import { inList } from "./sql";
import { addDays } from "@ferret/shared/utils";

export const WEBHOOK_JOB = "webhook.deliver";
export const WEBHOOK_STATES_JOB = "webhook.states";

/** The body's format: bumped only for a change a receiver would notice. */
const VERSION = 1;
const MAX_WEBHOOKS = 10;
/** Deliveries in a row that gave up (every retry failed) before the webhook is switched off. */
export const FAILURES_TO_DISABLE = 5;
/** After a rotation, the old secret keeps signing this long. */
const ROTATE_GRACE_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const LOG_SHOWN = 50;

/** The events that come from the hourly check rather than as they happen. */
const STATE_EVENTS: readonly WebhookEvent[] = ["task.due", "task.overdue", "warranty.ending", "return.closing", "recall.found", "loan.due"];

type Row = typeof webhook.$inferSelect;
type Manager = Caller & { files: FileStore };

const urlLabel = (id: string) => `webhook:${id}:url`;
const secretLabel = (id: string) => `webhook:${id}:secret`;

function summary(row: Row): WebhookSummary {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    events: row.events.filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e)),
    paused: Boolean(row.pausedAt),
    disabledAt: row.disabledAt?.toISOString() ?? null,
    failures: row.failures,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    previousSecretUntil: row.previousSecretUntil && row.previousSecretUntil > new Date() ? row.previousSecretUntil.toISOString() : null,
    local: row.allowLocal,
    createdAt: row.createdAt.toISOString(),
  };
}

const newSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

/** Whether this person may point a webhook at the server's own network (whoever runs it), and refuses it otherwise. */
async function localAllowed(v: Manager, url: string) {
  const admin = await isServerAdmin(v.db, v.userId);
  if (!admin && localHostName(new URL(url).host)) {
    throw new HTTPException(403, { message: "Only whoever runs this Ferret can send webhooks to an address on its own network" });
  }
  return admin;
}

async function find(v: Caller, id: string) {
  const [row] = await v.db.select().from(webhook).where(and(eq(webhook.id, id), eq(webhook.householdId, v.householdId)));
  if (!row) throw notFound("Webhook");
  return row;
}

export async function listWebhooks(v: Caller) {
  const rows = await v.db.select().from(webhook).where(eq(webhook.householdId, v.householdId)).orderBy(webhook.createdAt);
  return rows.map(summary);
}

/** A new webhook, with its secret (shown again by Show secret). */
export async function createWebhook(v: Manager, input: WebhookInput) {
  if ((await listWebhooks(v)).length >= MAX_WEBHOOKS) throw new HTTPException(409, { message: `A household can have up to ${MAX_WEBHOOKS} webhooks — remove one first` });
  const allowLocal = await localAllowed(v, input.url);
  const id = crypto.randomUUID();
  const secret = newSecret();
  const [row] = await v.db
    .insert(webhook)
    .values({
      id,
      householdId: v.householdId,
      name: input.name,
      urlSealed: await v.files.seal(v.householdId, urlLabel(id), input.url),
      host: new URL(input.url).host,
      events: [...new Set(input.events)],
      secretSealed: await v.files.seal(v.householdId, secretLabel(id), secret),
      allowLocal,
      createdBy: v.userId,
    })
    .returning();
  return { ...summary(row!), secret };
}

export async function updateWebhook(v: Manager, id: string, input: WebhookPatch) {
  const current = await find(v, id);
  const set: Partial<typeof webhook.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.events !== undefined) set.events = [...new Set(input.events)];
  if (input.url !== undefined) {
    set.urlSealed = await v.files.seal(v.householdId, urlLabel(id), input.url);
    set.host = new URL(input.url).host;
    // A new address is judged by whoever gave it.
    set.allowLocal = await localAllowed(v, input.url);
  }
  if (input.paused === true) set.pausedAt = current.pausedAt ?? new Date();
  // Turning it on again: also after Ferret switched it off for failing.
  if (input.paused === false) Object.assign(set, { pausedAt: null, disabledAt: null, failures: 0 });
  if (!Object.keys(set).length) return summary(current);
  const [row] = await v.db.update(webhook).set(set).where(and(eq(webhook.id, id), eq(webhook.householdId, v.householdId))).returning();
  return summary(row!);
}

export async function removeWebhook(v: Caller, id: string) {
  const gone = await v.db.delete(webhook).where(and(eq(webhook.id, id), eq(webhook.householdId, v.householdId))).returning({ id: webhook.id });
  if (!gone.length) throw notFound("Webhook");
}

export async function webhookSecret(v: Manager, id: string) {
  const row = await find(v, id);
  return { secret: await v.files.open(v.householdId, secretLabel(id), row.secretSealed) };
}

/** A new secret; the old one keeps signing (a second v1) for a day, so the receiver can switch over. */
export async function rotateSecret(v: Manager, id: string) {
  const row = await find(v, id);
  const secret = newSecret();
  await v.db
    .update(webhook)
    .set({
      secretSealed: await v.files.seal(v.householdId, secretLabel(id), secret),
      previousSecretSealed: row.secretSealed,
      previousSecretUntil: new Date(Date.now() + ROTATE_GRACE_MS),
    })
    .where(eq(webhook.id, id));
  return { secret };
}

function deliveryView(d: typeof webhookDelivery.$inferSelect): WebhookDelivery {
  return {
    id: d.id,
    eventId: d.eventId,
    event: d.event as WebhookDelivery["event"],
    status: d.status,
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
  };
}

export async function listDeliveries(v: Caller, id: string) {
  await find(v, id);
  const rows = await v.db
    .select()
    .from(webhookDelivery)
    .where(and(eq(webhookDelivery.webhookId, id), eq(webhookDelivery.householdId, v.householdId)))
    .orderBy(desc(webhookDelivery.createdAt))
    .limit(LOG_SHOWN);
  return rows.map(deliveryView);
}

/** Sends one delivery again (the same event and id), by hand. */
export async function retryDelivery(v: Caller, id: string, deliveryId: string) {
  const w = await find(v, id);
  if (w.pausedAt || w.disabledAt) throw new HTTPException(409, { message: "Turn the webhook on first" });
  const [d] = await v.db
    .update(webhookDelivery)
    .set({ status: "pending", error: null })
    .where(and(eq(webhookDelivery.id, deliveryId), eq(webhookDelivery.webhookId, id), eq(webhookDelivery.householdId, v.householdId)))
    .returning();
  if (!d) throw notFound("Delivery");
  await v.deps.jobs?.enqueue(WEBHOOK_JOB, { deliveryId: d.id });
  return deliveryView(d);
}

// ── Sending ─────────────────────────────────────────────────────────────────

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, text: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

/** The `Ferret-Signature` header: `t=…,v1=…` (and a second `v1` with the previous secret during a rotation). */
export async function signature(body: string, secrets: string[], at = new Date()) {
  const t = Math.floor(at.getTime() / 1000);
  const sigs = await Promise.all(secrets.map((s) => hmac(s, `${t}.${body}`)));
  return [`t=${t}`, ...sigs.map((s) => `v1=${s}`)].join(",");
}

/** Links in the body are written as app paths (`/#/items/…`) and made whole with the server's address when sent. */
function withServer(body: string, appUrl: string) {
  const event = JSON.parse(body) as Record<string, unknown>;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, k === "url" && typeof val === "string" && val.startsWith("/") ? `${appUrl}${val}` : walk(val)]));
    }
    return x;
  };
  return JSON.stringify(walk(event));
}

type SendDeps = Pick<Deps, "db" | "webhooks"> & { files: FileStore; appUrl: string };

/** Posts one delivery and records how it went. Returns whether the receiver took it (2xx). */
async function attempt(deps: SendDeps, w: Row, d: typeof webhookDelivery.$inferSelect) {
  let status: number | null = null;
  let error: string | null = null;
  try {
    const url = await deps.files.open(w.householdId, urlLabel(w.id), w.urlSealed);
    const secrets = [await deps.files.open(w.householdId, secretLabel(w.id), w.secretSealed)];
    if (w.previousSecretSealed && w.previousSecretUntil && w.previousSecretUntil > new Date()) {
      secrets.push(await deps.files.open(w.householdId, secretLabel(w.id), w.previousSecretSealed));
    }
    const body = withServer(d.body, deps.appUrl);
    const res = await deps.webhooks!.post(
      url,
      body,
      { "Ferret-Event": d.event, "Ferret-Event-Id": d.eventId, "Ferret-Delivery": d.id, "Ferret-Signature": await signature(body, secrets) },
      { allowLocal: w.allowLocal },
    );
    status = res.status;
    if (status < 200 || status >= 300) error = `It answered ${status}`;
  } catch (err) {
    error = err instanceof WebhookError ? err.message : `Couldn't send it (${err instanceof Error ? err.message : String(err)})`;
  }
  const now = new Date();
  await deps.db
    .update(webhookDelivery)
    .set({ attempts: d.attempts + 1, lastAttemptAt: now, responseStatus: status, error })
    .where(eq(webhookDelivery.id, d.id));
  await deps.db.update(webhook).set({ lastDeliveryAt: now, lastStatus: status, lastError: error }).where(eq(webhook.id, w.id));
  return { ok: error === null, status, error };
}

/** The delivery job: throws to be tried again; on its last try, counts the failure (and switches off a failing webhook). */
export function deliverWebhookJob(deps: SendDeps): JobHandler {
  return async (payload, { lastAttempt }) => {
    const { deliveryId } = payload as { deliveryId: string };
    const [d] = await deps.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, deliveryId));
    if (!d || d.status !== "pending" || !deps.webhooks) return;
    const [w] = await deps.db.select().from(webhook).where(eq(webhook.id, d.webhookId));
    if (!w) return;
    if (w.pausedAt || w.disabledAt) {
      await deps.db.update(webhookDelivery).set({ status: "failed", error: w.pausedAt ? "Not sent: the webhook is paused" : "Not sent: the webhook was switched off" }).where(eq(webhookDelivery.id, d.id));
      return;
    }
    const { ok, error } = await attempt(deps, w, d);
    if (ok) {
      await deps.db.update(webhookDelivery).set({ status: "sent" }).where(eq(webhookDelivery.id, d.id));
      if (w.failures) await deps.db.update(webhook).set({ failures: 0 }).where(eq(webhook.id, w.id));
      return;
    }
    if (!lastAttempt) throw new Error(error ?? "Not delivered");
    await deps.db.update(webhookDelivery).set({ status: "failed" }).where(eq(webhookDelivery.id, d.id));
    const failures = w.failures + 1;
    await deps.db
      .update(webhook)
      .set({ failures, ...(failures >= FAILURES_TO_DISABLE ? { disabledAt: new Date() } : {}) })
      .where(eq(webhook.id, w.id));
  };
}

/** "Send a test": a `ping` event, posted now (not retried), its answer returned. Works while paused or switched off. */
export async function testWebhook(v: Manager, id: string, appUrl: string) {
  if (!v.deps.webhooks) throw new HTTPException(409, { message: "Webhooks aren't available on this server" });
  const w = await find(v, id);
  const eventId = crypto.randomUUID();
  const body = JSON.stringify({ id: eventId, type: "ping", version: VERSION, createdAt: new Date().toISOString(), household: await householdOf(v), data: { webhook: { id: w.id, name: w.name } } });
  const [d] = await v.db.insert(webhookDelivery).values({ householdId: v.householdId, webhookId: w.id, eventId, event: "ping", body }).returning();
  const result = await attempt({ db: v.db, webhooks: v.deps.webhooks, files: v.files, appUrl }, w, d!);
  await v.db.update(webhookDelivery).set({ status: result.ok ? "sent" : "failed" }).where(eq(webhookDelivery.id, d!.id));
  return { delivered: result.ok, status: result.status, error: result.error };
}

// ── Events ──────────────────────────────────────────────────────────────────

async function householdOf(v: Pick<Caller, "db" | "householdId">) {
  const [h] = await v.db.select({ name: organization.name }).from(organization).where(eq(organization.id, v.householdId));
  return { id: v.householdId, name: h?.name ?? null };
}

/** The household's webhooks that want this event now (not paused, not switched off). */
async function listeners(v: Pick<Caller, "db" | "householdId">, type: WebhookEvent) {
  const rows = await v.db
    .select({ id: webhook.id, events: webhook.events })
    .from(webhook)
    .where(and(eq(webhook.householdId, v.householdId), isNull(webhook.pausedAt), isNull(webhook.disabledAt)));
  return rows.filter((r) => r.events.includes(type)).map((r) => r.id);
}

/**
 * Queues an event for every webhook of the household that wants it. `data` is only worked out when one does (null:
 * nothing to send after all). Never throws: a webhook's trouble mustn't stop the change that caused it.
 */
export async function emitEvent(v: Pick<Caller, "db" | "deps" | "householdId">, type: WebhookEvent, data: () => Promise<object | null> | object | null) {
  if (!v.deps.webhooks || !v.deps.jobs) return;
  try {
    const targets = await listeners(v, type);
    if (!targets.length) return;
    const payload = await data();
    if (!payload) return;
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({ id: eventId, type, version: VERSION, createdAt: new Date().toISOString(), household: await householdOf(v), data: payload });
    const rows = await v.db
      .insert(webhookDelivery)
      .values(targets.map((webhookId) => ({ householdId: v.householdId, webhookId, eventId, event: type, body })))
      .returning({ id: webhookDelivery.id });
    for (const r of rows) await v.deps.jobs.enqueue(WEBHOOK_JOB, { deliveryId: r.id });
  } catch (err) {
    console.warn(`Couldn't queue the ${type} webhook: ${String(err)}`);
  }
}

/** What an event says about a thing: ids, names and plain details — never notes. */
export async function itemData(v: Caller, row: typeof item.$inferSelect) {
  const place = row.locationId ? ((await locationPaths(v)).get(row.locationId) ?? null) : null;
  return {
    id: row.id,
    name: row.name,
    brand: row.brand ?? null,
    model: row.model ?? null,
    quantity: row.quantity,
    location: row.locationId ? { id: row.locationId, path: place } : null,
    containerItemId: row.containerItemId ?? null,
    categoryId: row.categoryId ?? null,
    valueCents: row.valueCents ?? null,
    currency: v.currency,
    disposition: row.disposition ?? null,
    url: `/#/items/${encodeURIComponent(row.id)}`,
  };
}

/** After a count went down: a thing that just went onto the shopping list (at or below its "keep at least", or out). */
export async function stockChanged(v: Caller, itemId: string, before: number, after: number) {
  if (after >= before) return;
  await emitEvent(v, "stock.low", async () => {
    const [row] = await v.db.select().from(item).where(and(eq(item.id, itemId), itemScope(v)));
    if (!row || !crossedLow(before, after, row.minQuantity ?? null)) return null;
    return { item: await itemData(v, row), quantity: after, minQuantity: row.minQuantity ?? null, out: after === 0 };
  });
}

/** Whether a count change put a thing on the shopping list just now (crossed its minimum, or ran out). */
export function crossedLow(before: number, after: number, min: number | null) {
  if (after >= before) return false;
  if (after === 0) return true;
  return min !== null && after <= min && before > min;
}

// ── What needs attention, once each ─────────────────────────────────────────

interface StateEvent {
  key: string;
  type: WebhookEvent;
  data: Record<string, unknown>;
}

/** Everything that needs attention now, as the events a webhook can hear about, each with a key for "sent already". */
async function currentStates(v: Caller): Promise<StateEvent[]> {
  const on = todayFor(v);
  const out: StateEvent[] = [];
  const entries = await needsAttention(v);
  for (const e of entries) {
    const base = { id: e.id, title: e.title, detail: e.detail, date: e.date, severity: e.severity, itemId: e.itemId };
    if (e.kind === "maintenance" && e.date) {
      const type = e.date < on ? "task.overdue" : "task.due";
      out.push({ key: `${type}:${e.id}:${e.date}`, type, data: { task: { ...base, url: "/#/maintenance" } } });
    } else if (e.kind === "warranty" && e.date) {
      out.push({ key: `warranty.ending:${e.id}:${e.date}`, type: "warranty.ending", data: { warranty: { ...base, url: "/#/warranties" } } });
    } else if (e.kind === "return" && e.date) {
      out.push({ key: `return.closing:${e.id}:${e.date}`, type: "return.closing", data: { return: { ...base, url: `/#/items/${encodeURIComponent(e.id)}` } } });
    } else if (e.kind === "support" && e.date) {
      out.push({ key: `support.ending:${e.id}:${e.date}`, type: "support.ending", data: { support: { ...base, url: e.itemId ? `/#/items/${encodeURIComponent(e.itemId)}` : null } } });
    } else if (e.kind === "recall") {
      out.push({ key: `recall.found:${e.id}`, type: "recall.found", data: { recall: { ...base, url: e.itemId ? `/#/items/${encodeURIComponent(e.itemId)}` : null } } });
    }
  }
  // Loans due back: borrowed things due within 3 days (or overdue), lent things past their day.
  for (const l of await listLoans(v)) {
    if (!l.dueOn || l.borrowerReturnedAt) continue;
    const due = l.direction === "borrowed" ? l.dueOn <= addDays(on, 3) : l.dueOn < on;
    if (!due) continue;
    out.push({
      key: `loan.due:${l.id}:${l.dueOn}`,
      type: "loan.due",
      data: { loan: { id: l.id, direction: l.direction, person: l.person, dueOn: l.dueOn, since: l.since, itemId: l.itemId, itemName: l.itemName, url: "/#/loans" } },
    });
  }
  return out;
}

/** Item names for events that carry only the thing's id. */
async function addItemNames(v: Caller, states: StateEvent[]) {
  const ids = [...new Set(states.flatMap((s) => Object.values(s.data).map((d) => (d as { itemId?: string | null }).itemId).filter((x): x is string => Boolean(x))))];
  if (!ids.length) return;
  const names = new Map((await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.householdId, v.householdId), inList(item.id, ids)))).map((r) => [r.id, r.name]));
  for (const s of states) {
    for (const d of Object.values(s.data) as { itemId?: string | null; item?: unknown }[]) {
      if (d.itemId && !("itemName" in d)) d.item = { id: d.itemId, name: names.get(d.itemId) ?? null, url: `/#/items/${encodeURIComponent(d.itemId)}` };
    }
  }
}

/** One household: sends what newly needs attention, and forgets what no longer does (so it's sent again next time). */
export async function checkStates(v: Caller) {
  const states = await currentStates(v);
  const sent = new Set((await v.db.select({ key: webhookSent.key }).from(webhookSent).where(eq(webhookSent.householdId, v.householdId))).map((r) => r.key));
  const now = new Set(states.map((s) => s.key));
  const fresh = states.filter((s) => !sent.has(s.key));
  const stale = [...sent].filter((k) => !now.has(k));
  if (stale.length) await v.db.delete(webhookSent).where(and(eq(webhookSent.householdId, v.householdId), inList(webhookSent.key, stale)));
  await addItemNames(v, fresh);
  for (const s of fresh) {
    await emitEvent(v, s.type, () => s.data);
    await v.db.insert(webhookSent).values({ householdId: v.householdId, key: s.key }).onConflictDoNothing();
  }
  return fresh.length;
}

/** Hourly: every household with a webhook that listens for what needs attention. */
export function webhookStatesJob(deps: Deps): JobHandler {
  return async () => {
    if (!deps.webhooks) return;
    const rows = await deps.db.select({ householdId: webhook.householdId, events: webhook.events }).from(webhook).where(and(isNull(webhook.pausedAt), isNull(webhook.disabledAt)));
    const households = [...new Set(rows.filter((r) => r.events.some((e) => STATE_EVENTS.includes(e as WebhookEvent))).map((r) => r.householdId))];
    for (const householdId of households) {
      const v: Caller = { deps, db: deps.db, householdId, userId: "", ...(await householdLocale(deps.db, householdId)), via: "ferret" };
      await checkStates(v).catch((err) => console.warn(`Webhook check for a household failed: ${String(err)}`));
    }
  };
}

/** Deliveries older than 30 days (the log keeps a month). */
export async function pruneDeliveries(db: Db, now = Date.now()) {
  const gone = await db
    .delete(webhookDelivery)
    .where(lt(webhookDelivery.createdAt, new Date(now - KEEP_DAYS * 24 * 60 * 60 * 1000)))
    .returning({ id: webhookDelivery.id });
  return gone.length;
}

/** Webhooks Ferret switched off for failing — for the bell of the household's owner and admins. */
export async function switchedOff(v: Pick<Caller, "db" | "householdId" | "userId">) {
  const [role] = await v.db.select({ role: member.role }).from(member).where(and(eq(member.organizationId, v.householdId), eq(member.userId, v.userId)));
  if (!role || !["owner", "admin"].some((r) => role.role.split(",").includes(r))) return [];
  return v.db
    .select({ id: webhook.id, name: webhook.name, disabledAt: webhook.disabledAt, lastError: webhook.lastError })
    .from(webhook)
    .where(and(eq(webhook.householdId, v.householdId), isNotNull(webhook.disabledAt), isNull(webhook.pausedAt)));
}
