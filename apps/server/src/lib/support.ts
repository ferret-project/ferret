/**
 * Software support for devices (endoflife.date, deps.support): when a phone, tablet, watch, e-reader or streaming
 * stick stops getting security updates. Switched on by the server admin (Settings → Server → Device support).
 *
 * - The device lists are public: downloaded once a day into support_product (SUPPORT_REFRESH_JOB). Nothing about a
 *   household leaves the server; things are matched here.
 * - endoflife.date knows product lines and models, not exact products, so a match is a suggestion a person confirms
 *   on the thing's page ("Is this a Google Pixel 6 Pro?") — then item.support holds it, kept up to date daily.
 * - The bell says so from 90 days before updates stop until 30 days after (lib/attention.ts).
 */
import type { ItemSupport, ItemSupportStatus, SupportInfo, SupportLookupStatus } from "@ferret/shared";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, serverSetting, supportProduct, type SupportRelease } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import { todayFor } from "./household-time";
import { type Caller, getItem, itemScope, logActivity } from "./inventory";

export const SUPPORT_REFRESH_JOB = "support.refresh";
const KEY = "support.enabled";
const FRESH_MS = 24 * 60 * 60 * 1000;
/** The bell: from this many days before updates stop… */
export const SUPPORT_WARN_DAYS = 90;
/** …until this many after. */
export const SUPPORT_AFTER_DAYS = 30;

export async function supportEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, KEY));
  return row?.value === "true";
}

export async function setSupportEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

export async function supportOn(deps: Pick<Deps, "db" | "support">) {
  return Boolean(deps.support) && (await supportEnabled(deps.db));
}

export async function supportStatus(deps: Pick<Deps, "db" | "support">): Promise<SupportLookupStatus> {
  const products = await deps.db.select({ releases: supportProduct.releases }).from(supportProduct);
  const [tracked] = await deps.db.select({ n: count() }).from(item).where(isNotNull(item.support));
  return { available: Boolean(deps.support), enabled: await supportEnabled(deps.db), devices: products.reduce((n, p) => n + p.releases.length, 0), tracked: tracked?.n ?? 0 };
}

// ── Matching a thing to a device model ────────────────────────────────────────────────────────────────────────

/** A name's words, lowercased; "(2nd generation)"-style asides left out. */
export const words = (s: string): string[] => s.toLowerCase().replace(/\([^)]*\)/g, " ").match(/[a-z0-9]+/g) ?? [];

type Product = { name: string; label: string; releases: SupportRelease[] };
type Match = { product: Product; release: SupportRelease };

/** Words in a product line's name that say nothing about which line it is. */
const GENERIC = new Set(["mobile", "mobility", "gpus", "processors", "hardware"]);

/**
 * The model a thing most likely is. Every word of the model's name must be in the thing's brand, name and model —
 * "Pixel 6 Pro"; for a line whose models are named without it ("18 Pro", "Series 12", "500") also the line's own word
 * ("iPhone", "Watch", "Pi") — and at least two words or one with a digit, so "Kindle" alone matches nothing. The
 * longest name wins ("Pixel 6 Pro" over "Pixel 6"); the line's other words ("Google") break ties.
 */
export function matchDevice(products: Product[], thing: { name: string; brand?: string | null; model?: string | null }): Match | null {
  const have = new Set(words([thing.brand, thing.name, thing.model].filter(Boolean).join(" ")));
  let best: { match: Match; score: number } | null = null;
  for (const product of products) {
    const line = words(product.label);
    const lineOwn = line.filter((w) => !GENERIC.has(w)).slice(line.length > 1 ? 1 : 0);
    for (const release of product.releases) {
      const need = words(release.label);
      if (!need.length || !need.every((w) => have.has(w))) continue;
      if (need.length < 2 && !need.some((w) => /\d/.test(w))) continue;
      if (!need.some((w) => line.includes(w)) && !lineOwn.every((w) => have.has(w))) continue;
      // "(5th generation)" isn't needed to match, but tells generations apart when it's there.
      const aside = (release.label.match(/\(([^)]*)\)/g) ?? []).flatMap((m) => words(m.slice(1, -1))).filter((w) => have.has(w)).length;
      const score = need.length * 10 + aside * 5 + line.filter((w) => have.has(w)).length;
      // A tie (generations with one name): the newest.
      const newer = best && score === best.score && (release.releaseDate ?? "") > (best.match.release.releaseDate ?? "");
      if (!best || score > best.score || newer) best = { match: { product, release }, score };
    }
  }
  return best?.match ?? null;
}

/** "Pixel 6 Pro" as is; "18 Pro" → "Apple iPhone 18 Pro"; "Galaxy S26 FE" → "Samsung Galaxy S26 FE". */
export function deviceLabel(productLabel: string, releaseLabel: string) {
  const line = words(productLabel);
  if (words(releaseLabel).some((w) => line.includes(w))) return releaseLabel;
  const prefix = productLabel.split(/\s+/).filter((w) => !GENERIC.has(w.toLowerCase())).join(" ");
  return `${prefix} ${releaseLabel}`.trim();
}

const keyOf = (m: { product: string; release: string }) => `${m.product}/${m.release}`;

function infoOf(product: Product, release: SupportRelease, today: string): SupportInfo {
  const label = deviceLabel(product.label, release.label);
  return {
    product: product.name,
    release: release.name,
    label,
    eolFrom: release.eolFrom,
    releaseDate: release.releaseDate,
    ended: release.isEol || (release.eolFrom != null && release.eolFrom <= today),
    url: `https://endoflife.date/${product.name}`,
  };
}

async function products(db: Db): Promise<Product[]> {
  return db.select({ name: supportProduct.name, label: supportProduct.label, releases: supportProduct.releases }).from(supportProduct);
}

/** Download the device lists again when they're more than a day old (or missing), then bring tracked things' dates up to date. */
export function supportRefreshJob(deps: Deps): JobHandler {
  return async () => {
    if (!deps.support || !(await supportEnabled(deps.db))) return;
    const kept = await deps.db.select({ name: supportProduct.name, fetchedAt: supportProduct.fetchedAt }).from(supportProduct);
    const fresh = new Set(kept.filter((k) => Date.now() - k.fetchedAt.getTime() < FRESH_MS).map((k) => k.name));
    for (const device of await deps.support.devices()) {
      if (fresh.has(device.name)) continue;
      const got = await deps.support.releases(device.name);
      if (!got) continue;
      const row = { label: got.label, releases: got.releases, fetchedAt: new Date() };
      await deps.db.insert(supportProduct).values({ name: device.name, ...row }).onConflictDoUpdate({ target: supportProduct.name, set: row });
    }
    // An announced date can move (a maker extends support): every tracked thing follows its model.
    const lines = new Map((await products(deps.db)).map((p) => [p.name, p]));
    const tracked = await deps.db.select({ id: item.id, support: item.support }).from(item).where(isNotNull(item.support));
    for (const t of tracked) {
      const release = lines.get(t.support!.product)?.releases.find((r) => r.name === t.support!.release);
      if (release && release.eolFrom !== t.support!.eolFrom) await deps.db.update(item).set({ support: { ...t.support!, eolFrom: release.eolFrom } }).where(eq(item.id, t.id));
    }
  };
}

// ── A thing's support ────────────────────────────────────────────────────────────────────────────────────────

/** Tracked, a model to confirm, or nothing: for the thing's page. */
export async function itemSupport(v: Caller, itemId: string): Promise<ItemSupportStatus> {
  if (!(await supportOn(v.deps))) return { status: "off" };
  const it = await getItem(v, itemId);
  const lines = await products(v.db);
  if (!lines.length) {
    if (v.deps.jobs) await v.deps.jobs.enqueue(SUPPORT_REFRESH_JOB, {});
    return { status: "pending" };
  }
  const today = todayFor(v);
  if (it.support) {
    const product = lines.find((p) => p.name === it.support!.product);
    const release = product?.releases.find((r) => r.name === it.support!.release);
    if (product && release) return { status: "tracked", support: infoOf(product, release, today) };
    return { status: "tracked", support: { ...it.support, releaseDate: null, ended: it.support.eolFrom != null && it.support.eolFrom <= today, url: `https://endoflife.date/${it.support.product}` } };
  }
  const match = matchDevice(lines, it);
  if (!match || keyOf({ product: match.product.name, release: match.release.name }) === it.supportDismissed) return { status: "none" };
  return { status: "suggested", support: infoOf(match.product, match.release, today) };
}

/** "Yes, that's it": track this model's support on the thing. */
export async function trackSupport(v: Caller, itemId: string, pick: { product: string; release: string }) {
  const it = await getItem(v, itemId);
  const [product] = await v.db.select().from(supportProduct).where(eq(supportProduct.name, pick.product));
  const release = product?.releases.find((r) => r.name === pick.release);
  if (!product || !release) throw new HTTPException(422, { message: "That device isn't in endoflife.date's lists" });
  const info = infoOf(product, release, todayFor(v));
  const support: ItemSupport = { product: info.product, release: info.release, label: info.label, eolFrom: info.eolFrom };
  await v.db.update(item).set({ support, updatedAt: new Date() }).where(and(eq(item.id, it.id), itemScope(v, { gone: "include" })));
  await logActivity(v, "item.update", it.id, `Tracking software updates for ${it.name}: ${info.label}`);
  return itemSupport(v, it.id);
}

/** Stop tracking, or "it isn't that": that model isn't offered for this thing again. */
export async function untrackSupport(v: Caller, itemId: string) {
  const it = await getItem(v, itemId);
  const shown = it.support ?? (await itemSupport(v, it.id)).support;
  const dismissed = shown ? keyOf(shown) : it.supportDismissed;
  await v.db.update(item).set({ support: null, supportDismissed: dismissed ?? null, updatedAt: new Date() }).where(and(eq(item.id, it.id), itemScope(v, { gone: "include" })));
  if (it.support) await logActivity(v, "item.update", it.id, `Stopped tracking software updates for ${it.name}`);
  return itemSupport(v, it.id);
}

/** The household's tracked things whose updates stop soon or stopped lately (the bell). */
export async function supportEnding(v: Caller, today: string) {
  const rows = await v.db.select({ id: item.id, name: item.name, support: item.support }).from(item).where(and(itemScope(v), isNotNull(item.support)));
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  return rows.filter((r) => {
    const eol = r.support!.eolFrom;
    if (!eol) return false;
    const days = Math.round((day(eol) - day(today)) / 86_400_000);
    return days <= SUPPORT_WARN_DAYS && days >= -SUPPORT_AFTER_DAYS;
  });
}
