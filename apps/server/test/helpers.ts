/** Test app with in-memory fakes for the AI model, docling and the vector store. */
import { ROOM_SCAN_JOB, analyzeRoomScan } from "../src/lib/room-scans";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect } from "vitest";
import { FsBlobs } from "../src/adapters/local/blobs";
import { FolderBackupTarget, SqliteSnapshots } from "../src/adapters/local/backup";
import { SharpImages } from "../src/adapters/local/images";
import { DbJobs } from "../src/adapters/local/jobs";
import { type Extensions, createApp } from "../src/app";
import type { Auth } from "../src/auth";
import { type Config, loadConfig } from "../src/config";
import { DOCUMENT_JOB, PHOTO_JOB, analyzeAttachment } from "../src/jobs/analyze";
import { BACKFILL_JOB, INDEX_JOB, backfillIndex, indexItem } from "../src/jobs/index-item";
import { BACKUP_JOB, backupJob } from "../src/lib/backup";
import { refreshFullText } from "../src/lib/fulltext";
import { PRODUCT_JOB, productLookupJob } from "../src/lib/products";
import { DownloadError } from "../src/ports";
import type {
  BackupElsewhere, HostingUsage, PdfPages, ProductQuota } from "../src/ports";
import { PDF_BACKFILL_JOB, PDF_THUMB_JOB, pdfThumbnail, pdfThumbnailBackfill } from "../src/jobs/pdf-thumbnail";
import type { Ai, Analytics, AnalyticsCount, Db, Documents, Downloader, Entitlements, HomeAssistant, HumanCheck, Recalls, MapImages, Notifier, ProductInfo, ProductLookup, Push, PushTarget, Reranker, VectorPoint, Vectors } from "../src/ports";
import { testDb } from "./db";

export const config = loadConfig({
  NODE_ENV: "test",
  AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  FILES_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
});

export const PASSWORD = "correct-horse-battery";

/**
 * An account whose email is already confirmed (made server-side, as if its verification link had been opened),
 * signed in: returns its session cookie. Real sign-ups need email verification after the first account
 * (test/email-verification.test.ts covers that path).
 */
export async function verifiedAccount(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, auth: Auth, name: string, email = `${name}@example.com`) {
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser({ name, email, emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: "credential", accountId: created.id, password: await ctx.password.hash(PASSWORD) });
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return {
    id: created.id,
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}

/**
 * A fake embedding: one dimension per group of related words, so "make holes"
 * lands near "drill" and far from "mixer" — enough to test ranking for real.
 */
const groups = [
  ["drill", "hole", "holes", "driver", "screw", "dewalt"],
  ["mixer", "baking", "cake", "dough", "kitchenaid"],
  ["warranty", "guarantee", "repair", "coverage"],
  ["garage", "shelf", "workbench"],
];
export function fakeEmbed(text: string) {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const v = [...groups.map((g) => words.filter((w) => g.includes(w)).length), 0.05];
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** A model that replays canned JSON replies (or errors) and records what it was asked. */
export class FakeAi implements Ai {
  calls: { prompt: string; image?: string }[] = [];
  embedCalls: { texts: string[]; purpose: string }[] = [];
  embedError?: Error;
  constructor(private readonly replies: (unknown | Error)[] = []) {}
  async embed(texts: string[], purpose: "document" | "query") {
    this.embedCalls.push({ texts, purpose });
    if (this.embedError) throw this.embedError;
    return texts.map(fakeEmbed);
  }
  async json(req: Parameters<Ai["json"]>[0]) {
    this.calls.push({ prompt: req.prompt, image: req.image?.contentType });
    const next = this.replies.length > 1 ? this.replies.shift() : this.replies[0];
    if (next instanceof Error) throw next;
    return next;
  }
}

/** docling stand-in: returns canned Markdown (or throws). */
export class FakeDocuments implements Documents {
  calls: string[] = [];
  constructor(private readonly results: (string | Error)[]) {}
  async toMarkdown(_data: Uint8Array, filename: string) {
    this.calls.push(filename);
    const next = this.results.length > 1 ? this.results.shift()! : this.results[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}

/** Product database stand-in: knows the codes it's given, counts the calls. */
/** Map pictures: remembers which addresses were asked for; a tiny PNG back. */
export class FakeMaps implements MapImages {
  asked: { address: string; scheme: string }[] = [];
  async snapshot(address: string, opts: { scheme: "light" | "dark" }) {
    this.asked.push({ address, scheme: opts.scheme });
    return new Uint8Array(await sharp({ create: { width: 4, height: 2, channels: 3, background: "#cde" } }).png().toBuffer());
  }
}

export class FakeProducts implements ProductLookup {
  calls: string[] = [];
  /** What the next lookups say is left of the allowance (null: they don't say). */
  allowance: ProductQuota | null = null;
  quota() {
    return this.allowance;
  }
  constructor(private readonly known: Record<string, Omit<ProductInfo, "barcode" | "source">> = {}) {}
  async lookup(barcode: string) {
    this.calls.push(barcode);
    const p = this.known[barcode];
    return p ? { barcode, source: "Fake", ...p } : null;
  }
}

/** Web Push stand-in: records what was sent; endpoints in `gone` have unsubscribed. */
export class FakePush implements Push {
  publicKey = "BFakePublicKey";
  sent: { endpoint: string; title: string; body: string; url: string }[] = [];
  gone = new Set<string>();
  async send(target: PushTarget, message: { title: string; body: string; url: string }) {
    if (this.gone.has(target.endpoint)) return "gone" as const;
    this.sent.push({ endpoint: target.endpoint, ...message });
    return "sent" as const;
  }
}

/** Apprise stand-in: records what was sent; URLs in `failing` are refused with that message. */
/** Counts kept in memory, read back as today's. */
export class FakeAnalytics implements Analytics {
  events: { event: string; ref?: string }[] = [];
  count(event: string, ref?: string) {
    this.events.push(ref ? { event, ref } : { event });
  }
  async report(): Promise<AnalyticsCount[]> {
    const day = new Date().toISOString().slice(0, 10);
    const n = new Map<string, AnalyticsCount>();
    for (const e of this.events) {
      const key = `${e.event}|${e.ref ?? ""}`;
      const row = n.get(key) ?? { day, event: e.event, ref: e.ref ?? null, n: 0 };
      row.n++;
      n.set(key, row);
    }
    return [...n.values()];
  }
  names() {
    return this.events.map((e) => e.event);
  }
}

export class FakeNotifier implements Notifier {
  sent: { url: string; title: string; body: string }[] = [];
  failing = new Map<string, string>();
  async send(url: string, message: { title: string; body: string }) {
    const error = this.failing.get(url);
    if (error) throw new Error(error);
    this.sent.push({ url, ...message });
  }
}

/** The web, for "add from a web address": files by URL; anything else is a DownloadError (like a private address). */
export class FakeDownloader implements Downloader {
  files = new Map<string, Uint8Array>();
  async get(url: string, opts: Parameters<Downloader["get"]>[1]) {
    const bytes = this.files.get(url);
    if (!bytes) throw new DownloadError("That address is on a private network — Ferret only downloads from the internet");
    if (bytes.length > opts.maxBytes) throw new DownloadError("Too big");
    if (!opts.accepts(bytes)) throw new DownloadError("That isn't a photo or a PDF — it may be a web page rather than the file itself");
    return { bytes, filename: url.split("/").at(-1) || null, finalUrl: url };
  }
}

/** Reranker stand-in: the share of the query's words (3+ letters) that appear in the passage. */
export class FakeReranker implements Reranker {
  error?: Error;
  async rerank(query: string, documents: string[]) {
    if (this.error) throw this.error;
    const words = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    return documents.map((d) => words.filter((w) => d.toLowerCase().includes(w)).length / Math.max(1, words.length));
  }
}

/** Qdrant stand-in: brute-force cosine similarity over points in memory. */
export class MemoryVectors implements Vectors {
  points = new Map<string, VectorPoint>();
  async upsert(points: VectorPoint[]) {
    for (const p of points) this.points.set(p.id, p);
  }
  async query(vector: number[], opts: { limit: number; filter: Record<string, string> }) {
    return [...this.points.values()]
      .filter((p) => Object.entries(opts.filter).every(([k, v]) => p.payload[k] === v))
      .map((p) => ({ id: p.id, payload: p.payload, score: p.vector.reduce((s, x, i) => s + x * vector[i]!, 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
  }
  async deleteWhere(filter: Record<string, string>) {
    for (const [id, p] of this.points) {
      if (Object.entries(filter).every(([k, v]) => p.payload[k] === v)) this.points.delete(id);
    }
  }
}

export async function setup(
  opts: {
    ai?: Ai;
    documents?: Documents;
    vectors?: Vectors;
    reranker?: Reranker;
    chat?: Ai;
    push?: Push;
    notifier?: Notifier;
    downloader?: Downloader;
    products?: ProductLookup;
    maps?: MapImages;
    maxAttempts?: number;
    baseDelayMs?: number;
    /** ALLOW_SIGNUP (default on). */
    signUp?: boolean;
    /** MAIL_URL: Ferret can send email (password reset). */
    mailUrl?: string;
    /** BACKUP_DIR: backups to a temporary folder. */
    backups?: boolean;
    homeAssistant?: HomeAssistant;
    recalls?: Recalls;
    /** PDF thumbnails (their first page). */
    pdfPages?: PdfPages;
    /** A fresh nonce in each response's CSP (a proxy's injected script). */
    cspNonce?: boolean;
    /** Usage counts (the public demo's, lib/analytics.ts). */
    analytics?: Analytics;
    /** "Are you a person?" before sign-up (Turnstile): the check, with TURNSTILE_SITE_KEY set. */
    humanCheck?: HumanCheck;
    /** The public demo (DEMO=true, with its admin), and any other DEMO_* settings. */
    demo?: Partial<Pick<Config, "DEMO_AI_PER_DAY" | "DEMO_PAUSED" | "DEMO_VISITOR_DAYS">>;
    /** Any other settings (e.g. single sign-on's). */
    config?: Partial<Config>;
    /** Households' plans (lib/plan.ts) — without, no limits. A function gets the test's database. */
    entitlements?: Entitlements | ((db: Db) => Entitlements);
    /** What another codebase adds (createApp's extensions). */
    extensions?: Extensions;
    /** Backups made outside this server (Deps.backupElsewhere). */
    backupElsewhere?: BackupElsewhere;
    /** What a demo's hosting has used (Settings → Server → Demo). */
    hostingUsage?: HostingUsage;
    /** The admins' Discord channel (ADMIN_WEBHOOK_URL). */
    adminWebhook?: string;
  } = {},
) {
  const { db } = await testDb();
  const images = new SharpImages();
  const jobs = new DbJobs(db, { maxAttempts: opts.maxAttempts ?? 6, baseDelayMs: opts.baseDelayMs ?? 60_000 });
  const blobs = new FsBlobs(mkdtempSync(path.join(tmpdir(), "ferret-test-")));
  const { ai, documents, vectors, reranker, chat, push, notifier, downloader, products, maps, homeAssistant, recalls, pdfPages } = opts;
  const entitlements = typeof opts.entitlements === "function" ? opts.entitlements(db) : opts.entitlements;
  const backups = opts.backups
    ? { snapshots: new SqliteSnapshots(db), target: new FolderBackupTarget(mkdtempSync(path.join(tmpdir(), "ferret-backup-"))) }
    : undefined;
  const appConfig: Config = {
    ...config,
    ALLOW_SIGNUP: opts.signUp ?? true,
    MAIL_URL: opts.mailUrl,
    BACKUP_DIR: backups?.target.where,
    ADMIN_WEBHOOK_URL: opts.adminWebhook,
    ...(opts.humanCheck && { TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }),
    ...(opts.demo && { DEMO: true, DEMO_ADMIN_EMAIL: "admin@demo.test", DEMO_ADMIN_PASSWORD: "demo-admin-password", ...opts.demo }),
    ...opts.config,
  };
  const { app, files, auth } = createApp({ db, blobs, images, pdfPages, jobs, ai, chat, documents, vectors, reranker, push, notifier, downloader, products, maps, backups, homeAssistant, recalls, humanCheck: opts.humanCheck, analytics: opts.analytics, entitlements, backupElsewhere: opts.backupElsewhere, hostingUsage: opts.hostingUsage }, appConfig, { cspNonce: opts.cspNonce, extensions: opts.extensions });
  if (backups) jobs.register({ [BACKUP_JOB]: backupJob({ db, blobs, ...backups, filesKey: config.FILES_KEY, keep: appConfig.BACKUP_KEEP }) });
  const onItemChanged = async (itemId: string) => {
    await refreshFullText(db, itemId);
    if (vectors) await jobs.enqueue(INDEX_JOB, { itemId });
  };
  const analyze = analyzeAttachment({ db, files, ai, chat, images, documents, entitlements, onItemChanged });
  jobs.register({ [PHOTO_JOB]: analyze, [DOCUMENT_JOB]: analyze, [ROOM_SCAN_JOB]: analyzeRoomScan({ db, files, ai, entitlements }) });
  if (pdfPages) jobs.register({ [PDF_THUMB_JOB]: pdfThumbnail({ db, files, pdfPages, images }), [PDF_BACKFILL_JOB]: pdfThumbnailBackfill({ db, jobs }) });
  if (ai && vectors) {
    jobs.register({ [INDEX_JOB]: indexItem({ db, ai, vectors }), [BACKFILL_JOB]: backfillIndex({ db, jobs }) });
  }

  /** Signs up a user with their own household; returns a fetch helper carrying their session. */
  async function user(name: string) {
    const { cookie } = await verifiedAccount(app, auth, name);
    const as = (url: string, init: RequestInit = {}) =>
      app.request(url, {
        ...init,
        headers: {
          ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
          Origin: config.PUBLIC_URL,
          Cookie: cookie,
          ...init.headers,
        },
      });
    const org = await as("/api/auth/organization/create", {
      method: "POST",
      body: JSON.stringify({ name: `${name} home`, slug: `${name}-home` }),
    });
    const householdId = ((await org.json()) as { id: string }).id;

    const addItem = async (fields: Record<string, unknown>) => {
      const created = await as("/api/v1/items", { method: "POST", body: JSON.stringify(fields) });
      expect(created.status).toBe(201);
      return (await created.json()) as { id: string; updatedAt: string };
    };
    const upload = async (itemId: string, bytes: Uint8Array<ArrayBuffer>, name: string, kind = "photo") => {
      const form = new FormData();
      form.set("file", new File([bytes], name));
      form.set("kind", kind);
      const up = await as(`/api/v1/items/${itemId}/attachments`, { method: "POST", body: form });
      expect(up.status).toBe(201);
      return (await up.json()) as { id: string; analysisStatus: string | null };
    };
    const attachments = async (itemId: string) =>
      ((await (await as(`/api/v1/items/${itemId}/attachments`)).json()) as { data: Record<string, unknown>[] }).data;
    const search = async (q: string) =>
      (await (await as(`/api/v1/items?q=${encodeURIComponent(q)}`)).json()) as {
        data: { id: string; name: string }[];
        hits: Record<string, { via: string; filename?: string; snippet?: string; relevance?: number }>;
      };
    return { as, householdId, addItem, upload, attachments, search };
  }

  if (products) jobs.register({ [PRODUCT_JOB]: productLookupJob({ db, products }) });
  return { app, auth, db, jobs, files, user, config: appConfig, deps: { db, blobs, images, jobs, ai, chat, documents, vectors, reranker, push, notifier, downloader, products, backups, recalls } };
}

export const photo = async () =>
  new Uint8Array(await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f2c200" } }).jpeg().toBuffer());

export const pdf = (text = "receipt") => new TextEncoder().encode(`%PDF-1.7 ${text}`);

/** A real one-page PDF (text in Helvetica), for things that draw it. */
export function realPdf(text = "Receipt $129.00") {
  const stream = `BT /F1 36 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
