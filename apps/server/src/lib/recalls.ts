/**
 * Recall alerts, from the CPSC's recalls (`deps.recalls`), when the server admin has switched them on (Settings ->
 * Server; `server_setting` "recalls.enabled" — they send each brand you own to the CPSC). Nothing is downloaded in
 * bulk: each brand a household owns is asked about (`forBrand`), the recalls that come back are kept in `recall`, and
 * the brand isn't asked again for a week (`recall_brand`). Then the household's things are matched against what's kept:
 *
 * — **barcode**: the item's barcode is one of the recall's UPCs;
 * — **model**: its model number (4+ letters and digits, with a digit) is in the recall's text, and so is its brand
 *   (or the model is long enough — 7+ — to be unmistakable);
 * — **possible**: its brand is in the recall's title or companies, and so is a word of what it is ("drill") — "check
 *   the model".
 *
 * A match is an `item_recall` row until someone says "not mine" (dismissed) or "dealt with it" (done); either way it
 * isn't offered again. Open ones are in the bell (urgent for barcode/model matches) and on the item's page.
 */
import type { ItemRecall, RecallStatus } from "@ferret/shared";
import { barcodeVariants } from "@ferret/shared";
import { and, count, desc, eq, gt, isNotNull, isNull, max, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, itemRecall, recall, recallBrand, serverSetting } from "../db/schema";
import type { Db, Deps, RawRecall } from "../ports";
import { type Caller, logActivity, notFound } from "./inventory";

const ENABLED_KEY = "recalls.enabled";
/** A brand's answer is kept this long. */
const BRAND_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many brands asked about per check (the rest next time): a big import doesn't hammer the CPSC. */
const BRANDS_PER_CHECK = 150;
const LEGAL = new Set(["inc", "co", "llc", "ltd", "corp", "company", "the"]);

export async function recallsEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  return row?.value === "true";
}

export async function setRecallsEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

/** For Settings → Server. */
export async function recallStatus(deps: Pick<Deps, "db" | "recalls">): Promise<RecallStatus> {
  const [[brands], [kept]] = await Promise.all([
    deps.db.select({ n: count(), last: max(recallBrand.checkedAt) }).from(recallBrand),
    deps.db.select({ n: count() }).from(recall),
  ]);
  return { available: Boolean(deps.recalls), enabled: await recallsEnabled(deps.db), brands: brands?.n ?? 0, recalls: kept?.n ?? 0, lastCheckedAt: brands?.last?.toISOString() ?? null };
}

/** Lower case, letters and digits, single spaces: "Scotch™ TL-1302Z" → "scotch tl1302z"-ish words. */
export const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** "TL-1302Z" / "tl 1302 z" → "tl1302z" — models are written every which way. */
const squash = (s: string) => normalise(s).replace(/ /g, "");
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const STOP = new Set(["with", "from", "and", "the", "for", "kit", "set", "new", "pack", "inch", "black", "white", "gray", "grey", "small", "large", "model"]);

const names = (xs: { Name?: string }[] | undefined) => (xs ?? []).map((x) => x.Name?.trim() ?? "").filter(Boolean);

export function toRow(r: RawRecall): typeof recall.$inferInsert {
  const products = (r.Products ?? []).map((p) => ({ name: p.Name?.trim() ?? "", model: p.Model?.trim() ?? "" })).filter((p) => p.name || p.model);
  // "3M Company Recalls Scotch™ Thermal Laminators…": the company before "Recalls" is one too.
  const firm = /^(.*?)\s+(?:Recalls|Recall|Announces)\b/i.exec(r.Title)?.[1];
  const companies = [...new Set([...(firm ? [firm] : []), ...names(r.Manufacturers), ...names(r.Importers), ...names(r.Distributors)])];
  const upcs = (r.ProductUPCs ?? []).map((u) => (typeof u === "string" ? u : (u.UPC ?? ""))).map((u) => u.replace(/\D/g, "")).filter((u) => u.length >= 8);
  return {
    id: String(r.RecallID),
    number: r.RecallNumber ?? null,
    recalledOn: r.RecallDate.slice(0, 10),
    title: r.Title.trim(),
    url: r.URL ?? null,
    description: r.Description?.slice(0, 4000) ?? null,
    hazard: names(r.Hazards).join("\n").slice(0, 2000) || null,
    remedy: names(r.Remedies).join("\n").slice(0, 2000) || null,
    contact: r.ConsumerContact?.slice(0, 1000) ?? null,
    products,
    companies,
    upcs,
    imageUrl: r.Images?.find((i) => i.URL)?.URL ?? null,
    searchText: normalise([r.Title, r.Description ?? "", ...products.flatMap((p) => [p.name, p.model]), ...companies].join(" ")),
  };
}

/** The brand as asked about and kept: "Black & Decker, Inc." → "black decker". Too short or generic → "". */
export function brandKey(brand: string | null | undefined) {
  const words = normalise(brand ?? "").split(" ").filter((w) => w && !LEGAL.has(w));
  return words.join("").length >= 3 ? words.join(" ") : "";
}

/** Ask about the brands whose answer is missing or a week old; keep what comes back. Returns how many were asked. */
export async function refreshBrands(deps: Pick<Deps, "db" | "recalls">, brands: string[], now = Date.now()) {
  if (!deps.recalls) return 0;
  const fresh = new Set(
    (await deps.db.select({ brand: recallBrand.brand }).from(recallBrand).where(gt(recallBrand.checkedAt, new Date(now - BRAND_FRESH_MS)))).map((r) => r.brand),
  );
  const stale = [...new Set(brands)].filter((b) => b && !fresh.has(b)).slice(0, BRANDS_PER_CHECK);
  for (const brand of stale) {
    const found = await deps.recalls.forBrand(brand);
    for (const raw of found) {
      if (!raw?.RecallID || !raw.Title || !raw.RecallDate) continue;
      const row = toRow(raw);
      await deps.db.insert(recall).values(row).onConflictDoUpdate({ target: recall.id, set: row });
    }
    const values = { checkedAt: new Date(now), found: found.length };
    await deps.db.insert(recallBrand).values({ brand, ...values }).onConflictDoUpdate({ target: recallBrand.brand, set: values });
  }
  return stale.length;
}

type RecallRow = Pick<typeof recall.$inferSelect, "id" | "title" | "companies" | "upcs" | "searchText" | "products" | "recalledOn">;

/** Indexes over the recalls, built once per check: by UPC, by brand word, by model-like token. */
function indexRecalls(rows: RecallRow[]) {
  const byUpc = new Map<string, RecallRow[]>();
  const byWord = new Map<string, RecallRow[]>();
  const add = (m: Map<string, RecallRow[]>, k: string, r: RecallRow) => {
    const list = m.get(k);
    if (!list) m.set(k, [r]);
    else if (list.at(-1) !== r) list.push(r);
  };
  for (const r of rows) {
    for (const u of r.upcs) add(byUpc, u.padStart(13, "0"), r);
    for (const w of new Set(r.searchText.split(" "))) if (w.length >= 2) add(byWord, w, r);
  }
  return { byUpc, byWord };
}

type Thing = Pick<typeof item.$inferSelect, "id" | "name" | "brand" | "model" | "barcode" | "purchaseDate">;

/** The recalls that look like this thing, best match first. */
export function matchItem(thing: Thing, idx: ReturnType<typeof indexRecalls>): { recall: RecallRow; match: "barcode" | "model" | "possible" }[] {
  const found = new Map<string, { recall: RecallRow; match: "barcode" | "model" | "possible" }>();
  const put = (r: RecallRow, match: "barcode" | "model" | "possible") => {
    const rank = { barcode: 3, model: 2, possible: 1 };
    const had = found.get(r.id);
    if (!had || rank[match] > rank[had.match]) found.set(r.id, { recall: r, match });
  };
  if (thing.barcode) {
    for (const code of [thing.barcode, ...barcodeVariants(thing.barcode)]) {
      for (const r of idx.byUpc.get(code.replace(/\D/g, "").padStart(13, "0")) ?? []) put(r, "barcode");
    }
  }
  // The brand's words must all be there ("black decker" → both); short or generic brands are too loose to go on.
  const key = brandKey(thing.brand);
  const brandWords = key ? key.split(" ") : [];
  const brandOk = brandWords.length > 0;
  const withBrand = brandOk ? (idx.byWord.get(brandWords[0]!) ?? []).filter((r) => brandWords.every((w) => ` ${r.searchText} `.includes(` ${w} `))) : [];

  const model = thing.model ? squash(thing.model) : "";
  if (model.length >= 4 && /\d/.test(model) && /[a-z]/.test(model)) {
    const candidates = model.length >= 7 ? [...(idx.byWord.get(normalise(thing.model!).split(" ")[0]!) ?? []), ...withBrand] : withBrand;
    for (const r of new Set(candidates)) if (r.searchText.replace(/ /g, "").includes(model)) put(r, "model");
  }
  if (withBrand.length) {
    // What it is: the last real word of its name ("cordless *drill*", "snow *blower*") in the recall's title — not any
    // shared word (a DeWalt cordless *heater* isn't a cordless drill), and not deep in its product list.
    const words = normalise(thing.name)
      .split(" ")
      .filter((w) => w.length >= 3 && !STOP.has(w) && !brandWords.includes(w) && !/^\d+$/.test(w))
      .slice(-1)
      .map(stem);
    // Old recalls are unlikely to be about something bought long after (or, with no purchase date, about anything now).
    const oldest = thing.purchaseDate ? `${Number(thing.purchaseDate.slice(0, 4)) - 3}` : `${new Date().getFullYear() - 15}`;
    for (const r of withBrand) {
      if (found.has(r.id) || !words.length || r.recalledOn.slice(0, 4) < oldest) continue;
      const title = new Set(normalise(r.title).split(" ").map(stem));
      if (words.every((w) => title.has(w))) put(r, "possible");
    }
  }
  return [...found.values()];
}

/** Checks one household's things (or just some) against every recall; adds new matches. Returns how many. */
export async function checkHousehold(v: Caller, itemIds?: string[]) {
  if (!v.deps.recalls || !(await recallsEnabled(v.db))) return 0;
  const owned = await v.db
    .selectDistinct({ brand: item.brand })
    .from(item)
    .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), isNull(item.disposition), isNotNull(item.brand)));
  await refreshBrands(v.deps, owned.map((b) => brandKey(b.brand)));
  const recalls = await v.db
    .select({ id: recall.id, title: recall.title, companies: recall.companies, upcs: recall.upcs, searchText: recall.searchText, products: recall.products, recalledOn: recall.recalledOn })
    .from(recall);
  if (!recalls.length) return 0;
  const idx = indexRecalls(recalls);
  const things = (
    await v.db
      .select({ id: item.id, name: item.name, brand: item.brand, model: item.model, barcode: item.barcode, purchaseDate: item.purchaseDate })
      .from(item)
      .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), isNull(item.disposition), or(isNotNull(item.brand), isNotNull(item.barcode))))
  ).filter((t) => !itemIds || itemIds.includes(t.id));
  const known = new Set(
    (await v.db.select({ itemId: itemRecall.itemId, recallId: itemRecall.recallId }).from(itemRecall).where(eq(itemRecall.householdId, v.householdId))).map(
      (r) => `${r.itemId}:${r.recallId}`,
    ),
  );
  let added = 0;
  for (const t of things) {
    for (const m of matchItem(t, idx)) {
      if (known.has(`${t.id}:${m.recall.id}`)) continue;
      await v.db.insert(itemRecall).values({ householdId: v.householdId, itemId: t.id, recallId: m.recall.id, match: m.match }).onConflictDoNothing();
      known.add(`${t.id}:${m.recall.id}`);
      added++;
      await logActivity(v, "recall.found", m.recall.id, `${m.match === "possible" ? "Possible recall" : "Recall"} for ${t.name}: ${m.recall.title}`, t.id);
    }
  }
  return added;
}

const view = (r: typeof recall.$inferSelect, ir: typeof itemRecall.$inferSelect, itemName: string): ItemRecall => ({
  id: ir.id,
  itemId: ir.itemId,
  itemName,
  match: ir.match,
  status: ir.status,
  foundAt: ir.foundAt.toISOString(),
  recall: {
    id: r.id,
    title: r.title,
    recalledOn: r.recalledOn,
    url: r.url,
    description: r.description,
    hazard: r.hazard,
    remedy: r.remedy,
    contact: r.contact,
    imageUrl: r.imageUrl,
  },
});

/** Open recalls (for the bell and the dashboard), or an item's, all of them. */
export async function listRecalls(v: Caller, opts: { itemId?: string } = {}) {
  const where = [eq(itemRecall.householdId, v.householdId), isNull(item.deletedAt)];
  if (opts.itemId) where.push(eq(itemRecall.itemId, opts.itemId));
  else where.push(eq(itemRecall.status, "open"), isNull(item.disposition));
  const rows = await v.db
    .select({ ir: itemRecall, r: recall, name: item.name })
    .from(itemRecall)
    .innerJoin(recall, eq(recall.id, itemRecall.recallId))
    .innerJoin(item, eq(item.id, itemRecall.itemId))
    .where(and(...where))
    .orderBy(desc(recall.recalledOn));
  const rank = { barcode: 0, model: 1, possible: 2 };
  return rows.map(({ ir, r, name }) => view(r, ir, name)).sort((a, b) => rank[a.match] - rank[b.match]);
}

/** "Not mine" (dismissed) or "dealt with it" (done) — or open again. */
export async function resolveRecall(v: Caller, id: string, status: "open" | "dismissed" | "done") {
  const [row] = await v.db
    .select({ ir: itemRecall, title: recall.title, name: item.name })
    .from(itemRecall)
    .innerJoin(recall, eq(recall.id, itemRecall.recallId))
    .innerJoin(item, eq(item.id, itemRecall.itemId))
    .where(and(eq(itemRecall.id, id), eq(itemRecall.householdId, v.householdId)));
  if (!row) throw notFound("Recall");
  if (row.ir.status === status) throw new HTTPException(409, { message: "It's already that way" });
  await v.db
    .update(itemRecall)
    .set({ status, resolvedAt: status === "open" ? null : new Date(), resolvedBy: status === "open" ? null : v.userId })
    .where(eq(itemRecall.id, id));
  const words = { open: "Reopened the recall for", dismissed: "Not affected by the recall:", done: "Dealt with the recall for" };
  await logActivity(v, "recall.resolve", row.ir.recallId, `${words[status]} ${row.name}`, row.ir.itemId);
}

