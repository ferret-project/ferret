/**
 * The service error log: every failed call to a service Ferret depends on, for the server admin. `watched()` wraps a
 * port (deps.ai, deps.vectors…) so any method that throws — or whose promise rejects — is recorded here before the
 * error goes on to its caller as usual (who may well fall back: search without embeddings, a retried job). One row per
 * service, method and message, counted; `serviceTrouble` puts recent ones in the admin's bell, and `alertServiceErrors`
 * (every 10 minutes) tells the admin when a service starts failing — at most once every 6 hours each.
 */
import type { ServiceErrorEntry } from "@ferret/shared";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Config } from "../config";
import { householdSetting, member, serviceError, user } from "../db/schema";
import { type Db, type Deps, type FailureDetail, ServiceFailure } from "../ports";
import type { FileStore } from "./files";
import { serverTimeZone } from "./household-time";
import { notifyPerson } from "./notifications";
import { serverAdmin } from "./server-admin";

/** What each port is called, for people. */
export const SERVICE_NAMES: Record<string, string> = {
  ai: "Vision & embeddings (Ollama)",
  chat: "Chat model",
  documents: "Document reader (docling)",
  vectors: "Vector store (Qdrant)",
  reranker: "Reranker",
  notifier: "Apprise",
  push: "Web Push",
  products: "Barcode lookup (UPCitemdb)",
  maps: "Apple Maps",
  recalls: "Recalls (CPSC)",
  turnstile: "Sign-up check (Turnstile)",
  jobs: "Background jobs (gave up)",
  ferret: "Ferret itself (unexpected errors)",
};

const NOTIFY_EVERY_MS = 6 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

/** Keep secrets out of the log: tokens in URLs, bearer keys. */
const redact = (text: string) =>
  text.replace(/(token|key|secret|password|apikey|api-key)=([^&\s)"']+)/gi, "$1=…").replace(/Bearer\s+\S+/gi, "Bearer …");

const clean = (err: unknown) => redact(err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * What's kept about the latest failure of an entry (`service_error.detail`), for triage: when, how long the call took,
 * where it was called from and where it failed (function names and files, never arguments), what kind of error and its
 * cause (a fetch's ECONNREFUSED), and what the adapter knew (ports.ts ServiceFailure).
 */
export type FailureRecord = {
  at: string;
  ms?: number;
  calledFrom?: string[];
  thrownAt?: string[];
  kind?: string;
  cause?: string;
  detail?: FailureDetail;
};

/** A stack's frames as "fn (file.ts:12)", without Ferret's dependencies' or Node's own. */
export function stackFrames(stack: string | undefined, skip = 0, max = 6) {
  return (stack ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(skip)
    .filter((l) => !/node_modules|node:internal|\(native\)/.test(l))
    .slice(0, max)
    .map((l) =>
      l
        .slice(3)
        .replace(/^async /, "")
        // a path down to its file name: file:///…/src/lib/search.ts:140:12 → search.ts:140
        .replace(/(?:file:\/\/)?[^\s()]*\/([^/\s()]+?):(\d+):\d+/g, "$1:$2"),
    );
}

function failureRecord(err: unknown, now: Date, call?: { ms?: number; site?: string }): FailureRecord {
  const e = err instanceof Error ? err : undefined;
  const cause = e?.cause instanceof Error ? `${e.cause.name}: ${e.cause.message}` : e?.cause !== undefined ? String(e.cause) : undefined;
  const record: FailureRecord = {
    at: now.toISOString(),
    ms: call?.ms,
    // The first frame is watched()'s own wrapper.
    calledFrom: call?.site ? stackFrames(call.site, 1) : undefined,
    thrownAt: e?.stack ? stackFrames(e.stack, 0, 4) : undefined,
    kind: e && e.name !== "Error" ? e.name : undefined,
    cause: cause ? redact(cause).slice(0, 300) : undefined,
    detail: err instanceof ServiceFailure ? err.detail : undefined,
  };
  return JSON.parse(redact(JSON.stringify(record))) as FailureRecord;
}

export async function recordServiceError(db: Db, service: string, operation: string, err: unknown, now = new Date(), call?: { ms?: number; site?: string }) {
  const message = clean(err);
  const detail = JSON.stringify(failureRecord(err, now, call)).slice(0, 8000);
  await db
    .insert(serviceError)
    .values({ service, operation, message, detail, firstAt: now, lastAt: now })
    .onConflictDoUpdate({ target: [serviceError.service, serviceError.operation, serviceError.message], set: { count: sql`${serviceError.count} + 1`, lastAt: now, detail } });
}

/** A port that records its failures (with how long the call took, and from where). The port behaves exactly as before otherwise. */
export function watched<T extends object>(db: Db, service: string, port: T | undefined): T | undefined {
  if (!port) return port;
  const record = (operation: string, err: unknown, started: number, site: string | undefined) =>
    void recordServiceError(db, service, operation, err, new Date(), { ms: Date.now() - started, site }).catch(() => {});
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const started = Date.now();
        // Where it was called from: taken now, while the caller is still on the stack.
        const site = new Error().stack;
        try {
          const out = value.apply(target, args);
          if (out instanceof Promise) return out.catch((err: unknown) => (record(String(prop), err, started, site), Promise.reject(err)));
          return out;
        } catch (err) {
          record(String(prop), err, started, site);
          throw err;
        }
      };
    },
  });
}

/** Which server this is, for triage: its address, version, where it runs. */
export interface ServerAbout {
  host: string;
  version: string;
  /** The platform, as it names itself (navigator.userAgent: "Node.js/22"…). */
  runtime: string;
  kind: "demo" | "hosted" | "self-hosted";
}

export function aboutServer(config: Pick<Config, "PUBLIC_URL" | "FERRET_VERSION" | "DEMO">, deps: Pick<Deps, "entitlements">): ServerAbout {
  return {
    host: new URL(config.PUBLIC_URL).host,
    version: config.FERRET_VERSION,
    runtime: typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "unknown",
    kind: config.DEMO ? "demo" : deps.entitlements ? "hosted" : "self-hosted",
  };
}

/** A moment in a zone, as people read it: 2026-10-25 09:46 MDT. */
export function localTime(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** The zone to tell the server admin times in: their household's, else the server's. */
export async function adminTimeZone(db: Db) {
  const admin = await serverAdmin(db);
  if (admin) {
    const [row] = await db
      .select({ timeZone: householdSetting.timeZone })
      .from(member)
      .innerJoin(householdSetting, eq(householdSetting.householdId, member.organizationId))
      .where(and(eq(member.userId, admin.id), isNotNull(householdSetting.timeZone)))
      .limit(1);
    if (row?.timeZone) return row.timeZone;
  }
  return serverTimeZone();
}

const parseRecord = (detail: string | null): FailureRecord | null => {
  if (!detail) return null;
  try {
    return JSON.parse(detail) as FailureRecord;
  } catch {
    return null;
  }
};

type Row = typeof serviceError.$inferSelect;

/**
 * An entry as plain text for triage — the email's "For triage" part, Settings → Server's Copy details and the operator
 * view: what failed, how often and when (in `timeZone`), the latest one's details, and which server.
 */
export function triageText(row: Row, about: ServerAbout, timeZone: string) {
  const r = parseRecord(row.detail);
  const when = row.count === 1 ? localTime(row.lastAt, timeZone) : `${row.count} times, ${localTime(row.firstAt, timeZone)} → ${localTime(row.lastAt, timeZone)}`;
  const lines = [`${SERVICE_NAMES[row.service] ?? row.service} (${row.service}.${row.operation}) — ${when}`, row.message];
  if (r) {
    const facts = [r.kind && `error: ${r.kind}`, r.ms !== undefined && `took ${r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`}`, r.cause && `cause: ${r.cause}`].filter(Boolean);
    if (facts.length) lines.push(facts.join(" · "));
    const detail = Object.entries(r.detail ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (detail.length) lines.push(...detail.map(([k, v]) => `  ${k}: ${String(v)}`));
    if (r.calledFrom?.length) lines.push(`called from: ${r.calledFrom.join(" ← ")}`);
    if (r.thrownAt?.length) lines.push(`thrown at: ${r.thrownAt.join(" ← ")}`);
  }
  lines.push(`server: ${about.host} (${about.kind}, ${about.runtime}) · Ferret ${about.version}`);
  return lines.join("\n");
}

export async function listServiceErrors(db: Db, about: ServerAbout, opts: { service?: string; sinceMs?: number; limit?: number } = {}): Promise<ServiceErrorEntry[]> {
  const where = and(opts.service ? eq(serviceError.service, opts.service) : undefined, opts.sinceMs ? gt(serviceError.lastAt, new Date(Date.now() - opts.sinceMs)) : undefined);
  const rows = await db.select().from(serviceError).where(where).orderBy(desc(serviceError.lastAt)).limit(opts.limit ?? 100);
  const timeZone = await adminTimeZone(db);
  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    serviceName: SERVICE_NAMES[r.service] ?? r.service,
    operation: r.operation,
    message: r.message,
    count: r.count,
    firstAt: r.firstAt.toISOString(),
    lastAt: r.lastAt.toISOString(),
    detail: parseRecord(r.detail),
    triage: triageText(r, about, timeZone),
  }));
}

export async function clearServiceErrors(db: Db, id?: string) {
  await (id ? db.delete(serviceError).where(eq(serviceError.id, id)) : db.delete(serviceError));
}

/** For the server admin's bell: each service with errors in the last day. */
export async function serviceTrouble(db: Db, now = Date.now()) {
  const rows = await db
    .select({ service: serviceError.service, n: sql<number>`sum(${serviceError.count})`, last: sql<number>`max(${serviceError.lastAt})` })
    .from(serviceError)
    .where(gt(serviceError.lastAt, new Date(now - RECENT_MS)))
    .groupBy(serviceError.service);
  return rows.map((r) => ({ service: r.service, name: SERVICE_NAMES[r.service] ?? r.service, count: Number(r.n), lastAt: new Date(Number(r.last)) }));
}

/** Tell the server admin about services that started failing (once every 6 hours each). Returns how many services. */
export async function alertServiceErrors(
  deps: Pick<Deps, "db" | "push" | "notifier"> & { files: FileStore; appUrl: string; about: ServerAbout; mailUrl?: string; adminWebhook?: string; now?: Date },
) {
  const now = deps.now ?? new Date();
  const fresh = await deps.db
    .select()
    .from(serviceError)
    .where(or(isNull(serviceError.notifiedAt), lt(serviceError.notifiedAt, serviceError.lastAt)));
  // Per service: anything new, and not told in the last 6 hours.
  const told = await deps.db
    .select({ service: serviceError.service, at: sql<number>`max(${serviceError.notifiedAt})` })
    .from(serviceError)
    .groupBy(serviceError.service);
  const lastTold = new Map(told.map((t) => [t.service, Number(t.at) || 0]));
  const services = [...new Set(fresh.map((r) => r.service))].filter((s) => now.getTime() - (lastTold.get(s) ?? 0) >= NOTIFY_EVERY_MS);
  if (!services.length) return 0;
  const admin = await serverAdmin(deps.db);
  if (!admin) return 0;
  const [who] = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, admin.id));
  const newest = (s: string) => fresh.filter((r) => r.service === s).sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  const lines = services.map((s) => `• ${SERVICE_NAMES[s] ?? s}: ${newest(s)[0]!.message}`);
  const name = (s: string) => SERVICE_NAMES[s] ?? s;
  const alert = {
    // Which server, in the title: several servers may write to the same inbox.
    title: `${services.length === 1 ? `Ferret can't reach ${name(services[0]!)}` : `${services.length} services Ferret uses are failing`} (${deps.about.host})`,
    body: `${lines.join("\n")}\n\nFerret carries on without them where it can. Details are in Settings → Server.`,
    url: `${deps.appUrl}/#/settings/server`,
  };
  // The email has room for the details: each service's newest few entries, as triage notes.
  const timeZone = await adminTimeZone(deps.db);
  const notes = services.flatMap((s) => newest(s).slice(0, 3)).map((r) => triageText(r, deps.about, timeZone));
  const details = `── For triage ──\n\n${notes.join("\n\n")}`;
  await notifyPerson(deps, admin.id, { ...alert, tag: "ferret-service-errors" }, { email: who?.email, details });
  if (deps.adminWebhook) await postToWebhook(deps.adminWebhook, alert, `${deps.appUrl}/icon-192.png`).catch((err) => console.error("admin webhook", err));
  for (const s of services) await deps.db.update(serviceError).set({ notifiedAt: now }).where(and(eq(serviceError.service, s)));
  return services.length;
}

/**
 * The admins' Discord channel (ADMIN_WEBHOOK_URL): the same alert, as one message from "Ferret" with the paw — Discord
 * fetches the picture itself, so on a server it can't reach it shows its default instead.
 */
export async function postToWebhook(url: string, alert: { title: string; body: string; url: string }, avatar?: string) {
  const content = `**${alert.title}**\n${alert.body}\n${alert.url}`.slice(0, 1900); // Discord's limit is 2,000
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Ferret", content, allowed_mentions: { parse: [] }, ...(avatar && { avatar_url: avatar }) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord webhook: ${res.status}`);
}
