/**
 * Lifespans and the replacement forecast: how long each thing should last and when it's likely due — always an
 * estimate ("typical life ~13 years, likely due around 2028"), never "replace it now". No AI.
 *
 * A thing's lifespan is, first that's set: its own (`item.lifespan_years`), its category's or the nearest parent
 * category's (`category.lifespan_years`), or the typical one for its kind (`TYPICAL_LIFESPANS` in @ferret/shared,
 * matched on its name, then its category's names). Its life starts when it was bought, or else when it was added.
 * What replacing it might cost: today's replacement cost if someone set it, else what was paid, else its value —
 * times how many there are. Gone and wanted things are left out (itemScope); so are boxes.
 */
import { type ForecastYear, type ItemLifespan, type ReplacementForecast } from "@ferret/shared";
import { today, typicalLifespanFor } from "@ferret/shared/utils";
import { and, eq, isNull } from "drizzle-orm";
import { category, item } from "../db/schema";
import { todayFor } from "./household-time";
import { asListing, type Caller, itemScope } from "./inventory";

type Row = Pick<typeof item.$inferSelect, "name" | "categoryId" | "partOfItemId" | "lifespanYears" | "purchaseDate" | "createdAt" | "replacementCents" | "purchasePriceCents" | "valueCents" | "quantity">;
type Cat = { id: string; name: string; parentId: string | null; lifespanYears: number | null };

/** The household's categories by id, to walk up from a thing's category. */
async function categoriesOf(v: Caller) {
  const rows = await v.db
    .select({ id: category.id, name: category.name, parentId: category.parentId, lifespanYears: category.lifespanYears })
    .from(category)
    .where(and(eq(category.householdId, v.householdId), isNull(category.deletedAt)));
  return new Map<string, Cat>(rows.map((c) => [c.id, c]));
}

/** A thing's category and its parents, nearest first. */
function chain(cats: Map<string, Cat>, id: string | null) {
  const out: Cat[] = [];
  for (let c = id ? cats.get(id) : undefined; c && out.length < 20; c = c.parentId ? cats.get(c.parentId) : undefined) out.push(c);
  return out;
}

/** How long this thing should last, from where, and when it's likely due — or null if Ferret can't tell. */
export function lifespanOf(row: Row, cats: Map<string, Cat>, timeZone: string, thisYear: number): ItemLifespan | null {
  const up = chain(cats, row.categoryId);
  let years: number;
  let source: ItemLifespan["source"];
  let from: string | null = null;
  let kind: string | undefined;
  const own = up.find((c) => c.lifespanYears);
  if (row.lifespanYears) {
    years = row.lifespanYears;
    source = "item";
  } else if (own) {
    years = own.lifespanYears!;
    source = "category";
    from = own.name;
  } else {
    // A part or supply (bags, filters) wears out on its own schedule — the shopping list's, not this one.
    const typical = row.partOfItemId ? null : typicalLifespanFor(row.name, ...up.map((c) => c.name));
    if (!typical) return null;
    years = typical.years;
    source = "typical";
    from = typical.name;
    kind = typical.key;
  }
  const since = row.purchaseDate ?? today(row.createdAt, timeZone);
  const dueYear = Number(since.slice(0, 4)) + years;
  const each = row.replacementCents ?? row.purchasePriceCents ?? row.valueCents;
  return {
    years,
    source,
    from,
    ...(kind ? { kind } : {}),
    since,
    sinceFrom: row.purchaseDate ? "bought" : "added",
    dueYear,
    past: dueYear < thisYear,
    costCents: each != null ? each * Math.max(1, row.quantity) : null,
    costFrom: row.replacementCents != null ? "replacement" : row.purchasePriceCents != null ? "price" : row.valueCents != null ? "value" : null,
  };
}

const thisYearOf = (v: Caller) => Number(todayFor(v).slice(0, 4));

/** One thing's lifespan (its page). */
export async function itemLifespan(v: Caller, row: typeof item.$inferSelect) {
  if (row.isContainer || row.disposition || row.wanted) return null;
  return lifespanOf(row, await categoriesOf(v), v.timeZone, thisYearOf(v));
}

const emptyYear = (year: number): ForecastYear => ({ year, items: 0, cents: 0, unpriced: 0 });
const add = (y: ForecastYear, l: ItemLifespan) => {
  y.items++;
  if (l.costCents == null) y.unpriced++;
  else y.cents += l.costCents;
};

/** Everything with a lifespan, by the year it's likely due: past its typical life, then this year and `years` more. */
export async function replacementForecast(v: Caller, opts: { years?: number; items?: boolean } = {}): Promise<ReplacementForecast> {
  const span = opts.years ?? 10;
  const thisYear = thisYearOf(v);
  const [rows, cats] = await Promise.all([v.db.select().from(item).where(and(itemScope(v), eq(item.isContainer, false))), categoriesOf(v)]);
  const past = emptyYear(thisYear - 1);
  const years = Array.from({ length: span }, (_, i) => emptyYear(thisYear + i));
  const dated: { row: typeof item.$inferSelect; lifespan: ItemLifespan }[] = [];
  let unknown = 0;
  for (const row of rows) {
    const lifespan = lifespanOf(row, cats, v.timeZone, thisYear);
    if (!lifespan) {
      unknown++;
      continue;
    }
    if (lifespan.past) add(past, lifespan);
    else if (lifespan.dueYear < thisYear + span) add(years[lifespan.dueYear - thisYear]!, lifespan);
    else continue;
    dated.push({ row, lifespan });
  }
  dated.sort((a, b) => a.lifespan.dueYear - b.lifespan.dueYear || (b.lifespan.costCents ?? 0) - (a.lifespan.costCents ?? 0));
  const listed = opts.items === false ? [] : await asListing(v, dated.map((d) => d.row));
  return {
    past,
    years,
    unknown,
    items: listed.map((r, i) => ({ id: r.id, name: r.name, place: r.place, photoId: r.photoId, quantity: r.quantity, lifespan: dated[i]!.lifespan })),
  };
}
