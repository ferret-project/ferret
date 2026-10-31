/**
 * Plans and usage. Every server counts what each person uses, per period — AI actions by kind,
 * online barcode lookups — in `plan_usage`, and when the household was last used (`household_setting.lastActiveOn`).
 * Limits come only from a plan (Deps.entitlements): without one, everything is
 * allowed and the counts are just for Settings → Plan & usage.
 *
 * One gate, called before anything costly happens: `allow` / `requireAllowed` for AI and lookups, `requireRoom` for
 * things, files and (through Better Auth's membershipLimit) people, `requireFeature` for what's simply on or off (API
 * keys and MCP, share links, calendar feeds). The AI ports themselves stay as they are.
 */
import type { PlanReport } from "@ferret/shared";
import { PLAN_FEATURE_NAMES, type PlanFeature } from "@ferret/shared/utils";
import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, householdSetting, item, member, planUsage, user } from "../db/schema";
import type { Db, Deps, HouseholdPlan } from "../ports";
import { inList } from "./sql";

export type UsageKind = "ai.photo" | "ai.document" | "ai.ask" | "barcode.lookup";

/** AI actions each kind costs — roughly what each costs to run (a photo about twice a question or a document). */
export const AI_WEIGHT: Partial<Record<UsageKind, number>> = { "ai.photo": 2, "ai.document": 1, "ai.ask": 1 };
const AI_KINDS = Object.keys(AI_WEIGHT) as UsageKind[];

/** Who's doing it: a household, and the person (null: the household's own background work). */
export interface Who {
  db: Db;
  deps: Pick<Deps, "entitlements" | "products">;
  householdId: string;
  userId?: string | null;
}

/** The household's plan, or null for none (no limits). */
export const planOf = async (w: Pick<Who, "deps" | "householdId">) => (w.deps.entitlements ? await w.deps.entitlements.plan(w.householdId) : null);

/** The period usage is counted in: the plan's, or the calendar month (UTC). */
export const periodOf = (plan: HouseholdPlan | null, now = new Date()) => plan?.period?.start ?? now.toISOString().slice(0, 7);

/** Counts `units` of `kind` for the person (one atomic upsert — no transaction, so it's safe on SQLite services without them). */
export async function recordUsage(w: Who, kind: UsageKind, units = 1, plan?: HouseholdPlan | null) {
  const period = periodOf(plan === undefined ? await planOf(w) : plan);
  await w.db
    .insert(planUsage)
    .values({ householdId: w.householdId, period, userId: w.userId ?? "", kind, units })
    .onConflictDoUpdate({
      target: [planUsage.householdId, planUsage.period, planUsage.userId, planUsage.kind],
      set: { units: sql`${planUsage.units} + ${units}` },
    });
}

/** This period's units by kind, for the whole household. */
async function usedByKind(w: Pick<Who, "db" | "householdId">, period: string) {
  const rows = await w.db
    .select({ kind: planUsage.kind, units: sql<number>`sum(${planUsage.units})` })
    .from(planUsage)
    .where(and(eq(planUsage.householdId, w.householdId), eq(planUsage.period, period)))
    .groupBy(planUsage.kind);
  return new Map(rows.map((r) => [r.kind as UsageKind, Number(r.units)]));
}

const aiActionsIn = (used: Map<UsageKind, number>) => AI_KINDS.reduce((n, k) => n + (used.get(k) ?? 0) * AI_WEIGHT[k]!, 0);

export type Allowance = { ok: true; plan: HouseholdPlan | null } | { ok: false; reason: string };

/** Whether the household may do one `kind` now: in its plan, and within this period's allowance. */
export async function allow(w: Who, kind: UsageKind): Promise<Allowance> {
  const plan = await planOf(w);
  if (!plan) return { ok: true, plan };
  const { limits } = plan;
  if (kind.startsWith("ai.")) {
    if (!limits.ai) return { ok: false, reason: `AI isn't part of the ${plan.name} plan.` };
    if (limits.aiActions === null) return { ok: true, plan };
    const used = aiActionsIn(await usedByKind(w, periodOf(plan)));
    if (used + AI_WEIGHT[kind]! > limits.aiActions) {
      return { ok: false, reason: `This period's ${limits.aiActions.toLocaleString("en-US")} AI actions are used up${renews(plan)}.` };
    }
  }
  if (kind === "barcode.lookup" && limits.barcodeLookups !== null) {
    const used = (await usedByKind(w, periodOf(plan))).get("barcode.lookup") ?? 0;
    if (used >= limits.barcodeLookups) return { ok: false, reason: `This period's ${limits.barcodeLookups} online barcode lookups are used up${renews(plan)}.` };
  }
  return { ok: true, plan };
}

const renews = (plan: HouseholdPlan) => (plan.period?.end ? ` — they come back on ${plan.period.end}` : "");

/** `allow`, as a 402 for the person waiting (Ask Ferret). Returns the plan, for `recordUsage`. */
export async function requireAllowed(w: Who, kind: UsageKind) {
  const allowed = await allow(w, kind);
  if (!allowed.ok) throw new HTTPException(402, { message: allowed.reason });
  return allowed.plan;
}

// ── Features: on or off ─────────────────────────────────────────────────────

/**
 * Whether the household's plan has `feature`. What was made with it before is kept, not deleted, when it doesn't: keys,
 * links and feeds pause (every use checks this) and work again once the plan has it.
 */
export const featureOn = async (w: Pick<Who, "deps" | "householdId">, feature: PlanFeature) => {
  const plan = await planOf(w);
  return !plan || plan.limits[feature];
};

/** `featureOn`, as a 402 saying which plan leaves it out (for the household's own people). */
export async function requireFeature(w: Pick<Who, "deps" | "householdId">, feature: PlanFeature) {
  const plan = await planOf(w);
  if (plan && !plan.limits[feature]) {
    throw new HTTPException(402, { message: `${PLAN_FEATURE_NAMES[feature]} aren't part of the ${plan.name} plan — upgrade to use them.` });
  }
}

/** Search by meaning is AI: off when the plan has none (words still find things). */
export async function meaningSearchAllowed(w: Pick<Who, "deps" | "householdId">) {
  const plan = await planOf(w);
  return !plan || plan.limits.ai;
}

// ── Room: things and files ──────────────────────────────────────────────────

/** Things in the household (gone ones count — they're still there; Recently deleted doesn't). */
async function itemCount(w: Pick<Who, "db" | "householdId">) {
  const [row] = await w.db
    .select({ n: sql<number>`count(*)` })
    .from(item)
    .where(and(eq(item.householdId, w.householdId), isNull(item.deletedAt)));
  return Number(row?.n ?? 0);
}

/** Bytes of the household's uploads (not removed ones). */
async function fileBytes(w: Pick<Who, "db" | "householdId">) {
  const [row] = await w.db
    .select({ n: sql<number>`coalesce(sum(${attachment.size}), 0)` })
    .from(attachment)
    .where(and(eq(attachment.householdId, w.householdId), isNull(attachment.deletedAt), isNull(attachment.originalRemovedAt)));
  return Number(row?.n ?? 0);
}

/** How many more things fit (null: no limit) — for imports, which stop there. */
export async function itemsRoom(w: Pick<Who, "db" | "deps" | "householdId">) {
  const plan = await planOf(w);
  if (plan?.limits.items == null) return null;
  return Math.max(0, plan.limits.items - (await itemCount(w)));
}

/** A 402 when adding `count` things, or a file of `bytes`, would go past the plan. */
export async function requireRoom(w: Pick<Who, "db" | "deps" | "householdId">, what: { items: number } | { bytes: number }) {
  const plan = await planOf(w);
  if (!plan) return;
  if ("items" in what && plan.limits.items !== null && (await itemCount(w)) + what.items > plan.limits.items) {
    throw new HTTPException(402, { message: `The ${plan.name} plan holds ${plan.limits.items} things — remove some, or upgrade to add more.` });
  }
  if ("bytes" in what && plan.limits.fileBytes !== null && (await fileBytes(w)) + what.bytes > plan.limits.fileBytes) {
    throw new HTTPException(402, { message: `The ${plan.name} plan holds ${formatBytes(plan.limits.fileBytes)} of photos and files — remove some, or upgrade to add more.` });
  }
}

/** People a household may have (Better Auth's membershipLimit): the plan's, else Ferret's own ceiling. */
export async function memberLimit(deps: Pick<Deps, "entitlements">, householdId: string, ceiling: number) {
  const plan = await planOf({ deps, householdId });
  return plan?.limits.members ?? ceiling;
}

const formatBytes = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);

// ── Last used ───────────────────────────────────────────────────────────────

/**
 * Notes that the household was used today (UTC) — at most one write a day: `known` is what requireHousehold already
 * read.
 */
export async function markActive(db: Db, householdId: string, known: string | null | undefined, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (known === day) return;
  await db
    .insert(householdSetting)
    .values({ householdId, lastActiveOn: day })
    .onConflictDoUpdate({ target: householdSetting.householdId, set: { lastActiveOn: day } });
}

// ── Settings → Plan & usage ─────────────────────────────────────────────────

/** The household's plan (if any), this period's usage by person, and what it holds — GET /api/v1/plan. */
export async function planReport(w: Pick<Who, "db" | "deps" | "householdId">): Promise<PlanReport> {
  const plan = await planOf(w);
  const period = periodOf(plan);
  const rows = await w.db
    .select({ userId: planUsage.userId, kind: planUsage.kind, units: planUsage.units })
    .from(planUsage)
    .where(and(eq(planUsage.householdId, w.householdId), eq(planUsage.period, period)));
  const people = new Map<string, { asks: number; photos: number; documents: number; barcodeLookups: number }>();
  for (const r of rows) {
    const p = people.get(r.userId) ?? { asks: 0, photos: 0, documents: 0, barcodeLookups: 0 };
    if (r.kind === "ai.ask") p.asks += r.units;
    if (r.kind === "ai.photo") p.photos += r.units;
    if (r.kind === "ai.document") p.documents += r.units;
    if (r.kind === "barcode.lookup") p.barcodeLookups += r.units;
    people.set(r.userId, p);
  }
  const ids = [...people.keys()].filter(Boolean);
  const names = ids.length ? await w.db.select({ id: user.id, name: user.name }).from(user).where(inList(user.id, ids)) : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const actions = (p: { asks: number; photos: number; documents: number }) =>
    p.asks * AI_WEIGHT["ai.ask"]! + p.photos * AI_WEIGHT["ai.photo"]! + p.documents * AI_WEIGHT["ai.document"]!;
  const byPerson = [...people.entries()]
    .map(([userId, p]) => ({ userId: userId || null, name: userId ? (nameOf.get(userId) ?? "Someone who left") : "Ferret (in the background)", aiActions: actions(p), ...p }))
    .sort((a, b) => b.aiActions - a.aiActions || b.barcodeLookups - a.barcodeLookups);
  const [members] = await w.db.select({ n: sql<number>`count(*)` }).from(member).where(eq(member.organizationId, w.householdId));
  const limits = plan?.limits;
  return {
    plan: plan ? { name: plan.name, limits: plan.limits, upgradeUrl: plan.upgradeUrl ?? null, manageUrl: plan.manageUrl ?? null, links: plan.links ?? [], status: plan.status ?? null } : null,
    period: { start: plan?.period?.start ?? period, end: plan?.period?.end ?? null },
    aiActions: { used: byPerson.reduce((n, p) => n + p.aiActions, 0), limit: limits ? (limits.ai ? limits.aiActions : 0) : null },
    barcodeLookups: w.deps.products ? { used: byPerson.reduce((n, p) => n + p.barcodeLookups, 0), limit: limits?.barcodeLookups ?? null } : null,
    items: { used: await itemCount(w), limit: limits?.items ?? null },
    fileBytes: { used: await fileBytes(w), limit: limits?.fileBytes ?? null },
    members: { used: Number(members?.n ?? 0), limit: limits?.members ?? null },
    people: byPerson,
  };
}
