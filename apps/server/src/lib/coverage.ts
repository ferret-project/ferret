/**
 * The coverage check: insurance limits — the whole contents cover ("Coverage C"), or a policy's special limits on
 * jewelry, firearms, silverware… by category or tag, optionally for one property — next to what the inventory says
 * the things they cover are worth (value, else price paid, × quantity; things you no longer have left out). A limit
 * the things outgrow is in the bell ("Jewelry: worth $14,200, covered for $1,500").
 */
import type { CoverageCheck, CoverageInput } from "@ferret/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { category, coverageLimit, item, location, property } from "../db/schema";
import { categoryDescendants, categoryInfo, findTag } from "./catalog";
import { type Caller, type ItemFilter, descendants, itemScope, logActivity, notFound } from "./inventory";

type Row = typeof coverageLimit.$inferSelect;

async function checkTargets(v: Caller, input: CoverageInput) {
  if (input.propertyId) {
    const [p] = await v.db.select({ id: property.id }).from(property).where(and(eq(property.id, input.propertyId), eq(property.householdId, v.householdId), isNull(property.deletedAt)));
    if (!p) throw notFound("Property");
  }
  if (input.scope === "category") {
    const [c] = await v.db.select({ id: category.id }).from(category).where(and(eq(category.id, input.categoryId!), eq(category.householdId, v.householdId), isNull(category.deletedAt)));
    if (!c) throw notFound("Category");
  }
}

/** What a limit covers, as an item filter (null: nothing — its tag is gone). */
async function filterFor(v: Caller, r: Row): Promise<ItemFilter | null> {
  const f: ItemFilter = {};
  if (r.propertyId) {
    const rooms = await v.db
      .select({ id: location.id })
      .from(location)
      .where(and(eq(location.propertyId, r.propertyId), eq(location.householdId, v.householdId), isNull(location.deletedAt)));
    const ids = (await Promise.all(rooms.map((x) => descendants(v, x.id)))).flat();
    if (!ids.length) return null;
    f.locationIds = ids;
  }
  if (r.scope === "category") f.categoryIds = await categoryDescendants(v, r.categoryId!);
  if (r.scope === "tag") {
    const t = await findTag(v, r.tag!);
    if (!t) return null;
    f.tagId = t.id;
  }
  return f;
}

export async function coverageChecks(v: Caller): Promise<CoverageCheck[]> {
  const rows = await v.db.select().from(coverageLimit).where(eq(coverageLimit.householdId, v.householdId)).orderBy(asc(coverageLimit.createdAt));
  if (!rows.length) return [];
  const [cats, props] = await Promise.all([categoryInfo(v), v.db.select({ id: property.id, name: property.name }).from(property).where(eq(property.householdId, v.householdId))]);
  const propName = new Map(props.map((p) => [p.id, p.name]));
  const out: CoverageCheck[] = [];
  for (const r of rows) {
    const filter = await filterFor(v, r);
    const [sum] = filter
      ? await v.db
          .select({
            items: sql<number>`count(*)`,
            cents: sql<number>`coalesce(sum(coalesce(${item.valueCents}, ${item.purchasePriceCents}) * max(${item.quantity}, 1)), 0)`,
            unvalued: sql<number>`sum(case when ${item.valueCents} is null and ${item.purchasePriceCents} is null then 1 else 0 end)`,
          })
          .from(item)
          // Boxes are packaging, not belongings (as in the insurance report) — unless they're worth something.
          .where(and(itemScope(v, filter), sql`(${item.isContainer} = 0 or ${item.valueCents} is not null or ${item.purchasePriceCents} is not null)`))
      : [{ items: 0, cents: 0, unvalued: 0 }];
    const valueCents = Number(sum?.cents ?? 0);
    out.push({
      id: r.id,
      label: r.label,
      limitCents: r.limitCents,
      scope: r.scope,
      propertyId: r.propertyId,
      propertyName: r.propertyId ? (propName.get(r.propertyId) ?? null) : null,
      categoryId: r.categoryId,
      categoryName: r.categoryId ? (cats.get(r.categoryId)?.path ?? null) : null,
      tag: r.tag,
      note: r.note,
      valueCents,
      items: Number(sum?.items ?? 0),
      unvalued: Number(sum?.unvalued ?? 0),
      shortCents: Math.max(0, valueCents - r.limitCents),
    });
  }
  return out;
}

const fields = (input: CoverageInput) => ({
  label: input.label,
  limitCents: input.limitCents,
  scope: input.scope,
  propertyId: input.propertyId ?? null,
  categoryId: input.scope === "category" ? input.categoryId! : null,
  tag: input.scope === "tag" ? input.tag! : null,
  note: input.note ?? null,
});

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export async function addCoverage(v: Caller, input: CoverageInput) {
  await checkTargets(v, input);
  const [row] = await v.db.insert(coverageLimit).values({ householdId: v.householdId, ...fields(input) }).returning();
  await logActivity(v, "coverage.create", row!.id, `Added coverage: ${row!.label} (${dollars(row!.limitCents)})`);
  return (await coverageChecks(v)).find((c) => c.id === row!.id)!;
}

export async function updateCoverage(v: Caller, id: string, input: CoverageInput) {
  await checkTargets(v, input);
  const [row] = await v.db
    .update(coverageLimit)
    .set(fields(input))
    .where(and(eq(coverageLimit.id, id), eq(coverageLimit.householdId, v.householdId)))
    .returning();
  if (!row) throw notFound("Coverage");
  return (await coverageChecks(v)).find((c) => c.id === id)!;
}

export async function deleteCoverage(v: Caller, id: string) {
  const [row] = await v.db.delete(coverageLimit).where(and(eq(coverageLimit.id, id), eq(coverageLimit.householdId, v.householdId))).returning();
  if (!row) throw notFound("Coverage");
  await logActivity(v, "coverage.delete", id, `Removed coverage: ${row.label}`);
}
