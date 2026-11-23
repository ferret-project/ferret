/**
 * Each person's dashboard (person_setting.dashboard): which sections they've hidden and the order of the rest. Theirs
 * alone, per household; null = Ferret's order with everything shown. New sections (not in a saved order) go after.
 */
import { DASHBOARD_SECTIONS, type DashboardLayout } from "@ferret/shared";
import { and, eq } from "drizzle-orm";
import { personSetting } from "../db/schema";
import type { Caller } from "./inventory";

const DEFAULT: DashboardLayout = { order: [...DASHBOARD_SECTIONS], hidden: [], arrange: "auto", sides: {} };

/** A saved layout made whole: every section once, unknown ones dropped, new ones appended. */
function complete(saved: DashboardLayout | null | undefined): DashboardLayout {
  if (!saved) return DEFAULT;
  const known = new Set<string>(DASHBOARD_SECTIONS);
  const order = [...new Set(saved.order.filter((s) => known.has(s)))];
  for (const s of DASHBOARD_SECTIONS) if (!order.includes(s)) order.push(s);
  const sides = Object.fromEntries(Object.entries(saved.sides ?? {}).filter(([s]) => known.has(s))) as DashboardLayout["sides"];
  return { order, hidden: [...new Set(saved.hidden.filter((s) => known.has(s)))], arrange: saved.arrange === "chosen" ? "chosen" : "auto", sides };
}

export async function getDashboardLayout(v: Caller): Promise<DashboardLayout> {
  const [row] = await v.db
    .select({ dashboard: personSetting.dashboard })
    .from(personSetting)
    .where(and(eq(personSetting.householdId, v.householdId), eq(personSetting.userId, v.userId)));
  return complete(row?.dashboard);
}

/** Saves it (null puts Ferret's back). */
export async function setDashboardLayout(v: Caller, layout: DashboardLayout | null): Promise<DashboardLayout> {
  const dashboard = layout ? complete(layout) : null;
  await v.db
    .insert(personSetting)
    .values({ householdId: v.householdId, userId: v.userId, dashboard })
    .onConflictDoUpdate({ target: [personSetting.householdId, personSetting.userId], set: { dashboard } });
  return complete(dashboard);
}
