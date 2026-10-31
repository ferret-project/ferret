/**
 * The search evaluation itself (eval/search.ts is its command line): seeds the household in fixture.ts into a fresh
 * in-memory database and a Qdrant collection made for the run, using the models it's given, then scores every fixture
 * search — top-1 = right item ranked first; top-3 = a right item in the first three; false alarms = results for things
 * the household doesn't own. Scored on the checked answer; "first ms" is how soon the sure matches show, "checked ms"
 * when the judge's answer is in. Exported so other model setups can be scored on the same fixture.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FsBlobs } from "../src/adapters/local/blobs";
import { createLocalDb, runMigrations } from "../src/adapters/local/db";
import { DbJobs } from "../src/adapters/local/jobs";
import { QdrantVectors } from "../src/adapters/local/qdrant";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { attachment } from "../src/db/schema";
import { INDEX_JOB, indexItem } from "../src/jobs/index-item";
import { refreshFullText } from "../src/lib/fulltext";
import type { Ai, Reranker, SearchProfile, TextModel } from "../src/ports";
import { items, property, queries } from "./fixture";

export interface SearchEval {
  /** Needs QDRANT_URL (and QDRANT_API_KEY if set); PUBLIC_URL for the sign-in's Origin. */
  config: Config;
  /** A Qdrant collection for the eval only: it's emptied first. */
  collection: string;
  ai: Ai;
  reranker?: Reranker;
  /** The search judge; without it, unsure meaning matches aren't decided. */
  chat?: TextModel;
  searchProfile?: SearchProfile;
  /** For the report: the profile's name, and the models' names. */
  profileName: string;
  models: { embed: string; rerank?: string; chat?: string };
  /** Every query, not only the misses. */
  verbose?: boolean;
}

export async function runSearchEval({ config, collection, ai, reranker, chat, searchProfile, profileName, models, verbose = false }: SearchEval) {
  if (!config.QDRANT_URL) throw new Error("The search eval needs QDRANT_URL");
  // A clean collection every run (only ever this one).
  await fetch(`${config.QDRANT_URL}/collections/${collection}`, {
    method: "DELETE",
    headers: config.QDRANT_API_KEY ? { "api-key": config.QDRANT_API_KEY } : {},
  });
  const { db } = createLocalDb(":memory:");
  await runMigrations(db, path.resolve(import.meta.dirname, "../migrations"));
  const vectors = new QdrantVectors(config.QDRANT_URL, config.QDRANT_API_KEY, collection);
  const jobs = new DbJobs(db);
  const blobs = new FsBlobs(mkdtempSync(path.join(tmpdir(), "ferret-eval-")));
  const { app, auth } = createApp({ db, blobs, jobs, ai, vectors, reranker, chat, searchProfile }, config);
  jobs.register({ [INDEX_JOB]: indexItem({ db, ai, vectors }) });

  // ── Seed ────────────────────────────────────────────────────────────────────
  const origin = { Origin: config.PUBLIC_URL };
  // An account whose email is already confirmed (as the tests make them), then signed in.
  const ctx = await auth.$context;
  const evalUser = await ctx.internalAdapter.createUser({ name: "Eval", email: "eval@example.com", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: evalUser.id, providerId: "credential", accountId: evalUser.id, password: await ctx.password.hash("correct-horse-battery") });
  const signIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...origin },
    body: JSON.stringify({ email: "eval@example.com", password: "correct-horse-battery" }),
  });
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const api = async <T>(url: string, body?: unknown): Promise<T> => {
    const res = await app.request(url, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...origin },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const household = await api<{ id: string }>("/api/auth/organization/create", { name: "Eval home", slug: "eval" });
  const { id: propertyId } = await api<{ id: string }>("/api/v1/properties", { name: property });

  const locations = new Map<string, string>();
  async function locationFor(pathNames: string[]) {
    let parentId: string | undefined;
    for (let i = 0; i < pathNames.length; i++) {
      const key = pathNames.slice(0, i + 1).join("/");
      if (!locations.has(key)) {
        const loc = await api<{ id: string }>("/api/v1/locations", { propertyId, parentId, name: pathNames[i] });
        locations.set(key, loc.id);
      }
      parentId = locations.get(key);
    }
    return parentId;
  }

  const nameOf = new Map<string, string>();
  const started = Date.now();
  for (const fixture of items) {
    const { documents, location, ...fields } = fixture;
    const created = await api<{ id: string }>("/api/v1/items", { ...fields, locationId: await locationFor(location) });
    nameOf.set(created.id, fixture.name);
    // Documents as if docling had already transcribed them (keeps the eval fast and repeatable).
    for (const d of documents ?? []) {
      await db.insert(attachment).values({
        householdId: household.id,
        itemId: created.id,
        kind: "document",
        filename: d.filename,
        contentType: d.filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
        size: d.text.length,
        blobKey: `eval/${d.filename}`,
        analysisStatus: "done",
        analysis: { description: d.description, text: d.text, suggestions: {} },
      });
      await refreshFullText(db, created.id);
      await jobs.enqueue(INDEX_JOB, { itemId: created.id });
    }
  }
  await jobs.drain();
  console.log(`Seeded ${items.length} items in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Models: ${models.embed}${models.rerank ? ` + ${models.rerank}` : " (no reranker)"}${chat ? ` + judge ${models.chat}` : " (no judge)"} — search profile "${profileName}"\n`);

  // ── Score ───────────────────────────────────────────────────────────────────
  type Result = {
    data: { id: string; name: string }[];
    hits: Record<string, { via: string; score?: number; relevance?: number }>;
  };
  const byKind = new Map<string, { n: number; top1: number; top3: number; alarms: number; ms: number; checked: number }>();
  const misses: string[] = [];

  for (const query of queries) {
    // As the app searches: the sure matches at once (judge=later), then — if some were held — the checked answer.
    const t = Date.now();
    const first = await api<Result & { checking?: number }>(`/api/v1/items?judge=later&q=${encodeURIComponent(query.q)}`);
    const ms = Date.now() - t;
    const result = first.checking ? await api<Result>(`/api/v1/items?judge=now&q=${encodeURIComponent(query.q)}`) : first;
    const checkedMs = Date.now() - t;
    const names = result.data.map((r) => r.name);
    const stats = byKind.get(query.kind) ?? { n: 0, top1: 0, top3: 0, alarms: 0, ms: 0, checked: 0 };
    stats.n++;
    stats.ms += ms;
    stats.checked += checkedMs;

    const describe = (r: Result["data"][number]) => {
      const h = result.hits[r.id];
      const scores = [h?.score !== undefined && `e=${h.score}`, h?.relevance !== undefined && `rr=${h.relevance}`].filter(Boolean);
      return `${r.name} (${h?.via}${scores.length ? `, ${scores.join(" ")}` : ""})`;
    };
    const shown = result.data.slice(0, 4).map(describe).join(" | ") || "(nothing)";

    let ok: boolean;
    if (query.kind === "none") {
      ok = names.length === 0;
      if (!ok) stats.alarms++;
    } else {
      const top1 = query.expect.includes(names[0] ?? "");
      const top3 = names.slice(0, 3).some((n) => query.expect.includes(n));
      stats.top1 += Number(top1);
      stats.top3 += Number(top3);
      ok = top1;
    }
    byKind.set(query.kind, stats);
    const line = `${ok ? "✓" : "✗"} [${query.kind}] "${query.q}" → ${shown}${query.expect.length ? `   want: ${query.expect.join(", ")}` : ""}`;
    if (verbose || !ok) (ok ? console.log : misses.push.bind(misses))(line);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%`.padStart(5) : "    –");
  console.log("kind       queries  top-1  top-3  false alarms  first ms  checked ms");
  let total = { n: 0, top1: 0, top3: 0, alarms: 0, ms: 0, checked: 0, scored: 0 };
  for (const [kind, s] of byKind) {
    const scored = kind === "none" ? 0 : s.n;
    console.log(
      `${kind.padEnd(10)} ${String(s.n).padStart(7)}  ${pct(s.top1, scored)}  ${pct(s.top3, scored)}  ${kind === "none" ? `${s.alarms}/${s.n}`.padStart(12) : "".padStart(12)}  ${String(Math.round(s.ms / s.n)).padStart(8)}  ${String(Math.round(s.checked / s.n)).padStart(10)}`,
    );
    total = { n: total.n + s.n, top1: total.top1 + s.top1, top3: total.top3 + s.top3, alarms: total.alarms + s.alarms, ms: total.ms + s.ms, checked: total.checked + s.checked, scored: total.scored + scored };
  }
  console.log(
    `${"all".padEnd(10)} ${String(total.n).padStart(7)}  ${pct(total.top1, total.scored)}  ${pct(total.top3, total.scored)}  ${String(total.alarms).padStart(12)}  ${String(Math.round(total.ms / total.n)).padStart(8)}  ${String(Math.round(total.checked / total.n)).padStart(10)}`,
  );
  if (misses.length) console.log(`\nMisses:\n${misses.join("\n")}`);
}
