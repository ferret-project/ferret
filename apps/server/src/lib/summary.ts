/**
 * A household at a glance, for home dashboards (Heimdall, Homepage, Homarr…): `GET /api/v1/summary` with an API key
 * (a read-only one is enough). Only counts and the total — never what anything is or where it is.
 */
import type { HouseholdSummary } from "@ferret/shared";
import { count, eq, sql } from "drizzle-orm";
import { item, organization } from "../db/schema";
import { needsAttention } from "./attention";
import { type Caller, itemScope } from "./inventory";
import { shoppingList } from "./stock";

export async function householdSummary(v: Caller): Promise<HouseholdSummary> {
  const [[totals], [household], attention, shopping] = await Promise.all([
    v.db
      .select({
        things: count(),
        // As the insurance report counts it: the current value, else what was paid, times the quantity.
        valueCents: sql<number>`coalesce(sum(coalesce(${item.valueCents}, ${item.purchasePriceCents}) * max(1, ${item.quantity})), 0)`,
      })
      .from(item)
      .where(itemScope(v, { owned: true })),
    v.db.select({ name: organization.name }).from(organization).where(eq(organization.id, v.householdId)),
    needsAttention(v),
    shoppingList(v),
  ]);
  return {
    household: household?.name ?? "",
    things: totals?.things ?? 0,
    valueCents: Number(totals?.valueCents ?? 0),
    currency: v.currency,
    needsAttention: attention.length,
    urgent: attention.filter((a) => a.severity === "urgent").length,
    toBuy: shopping.items.length,
  };
}
