/**
 * Maintenance by use ("change the oil every 5,000 miles"): an item counts something (`item.usageUnit`: miles, km,
 * hours, cycles), people (or Claude) log readings, and a task on it can repeat every so much use (`usageEvery`), as well
 * as — or instead of — by time.
 *
 * A task's `dueOn` stays the one date everything reads (lists, the bell, reminders, calendars): the earlier of its
 * time-based date (`timeDueOn`) and when the item is expected to reach `usageDueAt` (`effectiveDue` in
 * @ferret/shared/utils). It's worked out again whenever a reading is added or removed, and when the task changes.
 */
import { effectiveDue, type UsageReadingInput, type UsageSummary, usagePerDay } from "@ferret/shared";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, maintenanceTask, usageReading, user } from "../db/schema";
import { type Caller, itemScope, logActivity, notFound } from "./inventory";
import { todayFor } from "./household-time";

/** An item's readings, oldest first (just value and date — for working out due dates). */
export async function readingsOf(v: Caller, itemId: string) {
  return v.db
    .select({ value: usageReading.value, readOn: usageReading.readOn })
    .from(usageReading)
    .where(and(eq(usageReading.householdId, v.householdId), eq(usageReading.itemId, itemId)))
    .orderBy(usageReading.readOn, usageReading.createdAt);
}

export async function usageSummary(v: Caller, itemId: string): Promise<UsageSummary> {
  const [row] = await v.db.select({ unit: item.usageUnit }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!row) throw notFound("Item");
  const readings = await v.db
    .select({ id: usageReading.id, value: usageReading.value, readOn: usageReading.readOn, note: usageReading.note, by: user.name })
    .from(usageReading)
    .leftJoin(user, eq(user.id, usageReading.userId))
    .where(and(eq(usageReading.householdId, v.householdId), eq(usageReading.itemId, itemId)))
    .orderBy(desc(usageReading.readOn), desc(usageReading.createdAt))
    .limit(50);
  return { unit: row.unit ?? null, readings, now: readings[0]?.value ?? null, perDay: usagePerDay(readings) };
}

/** Log what the item's count says (the odometer…): its usage tasks' due dates follow. */
export async function addReading(v: Caller, itemId: string, input: UsageReadingInput) {
  const [row] = await v.db.select({ name: item.name, unit: item.usageUnit }).from(item).where(and(eq(item.id, itemId), itemScope(v)));
  if (!row) throw notFound("Item");
  if (!row.unit) throw new HTTPException(422, { message: "Say what it counts first (miles, hours…)" });
  const readOn = input.readOn ?? todayFor(v);
  if (readOn > todayFor(v)) throw new HTTPException(422, { message: "That's in the future" });
  const [reading] = await v.db
    .insert(usageReading)
    .values({ householdId: v.householdId, itemId, value: input.value, readOn, note: input.note ?? null, userId: v.userId })
    .returning();
  await logActivity(v, "item.usage", itemId, `${row.name}: ${input.value.toLocaleString("en-US")} ${row.unit} on ${readOn}`, itemId);
  await refreshUsageTasks(v, itemId);
  return reading!;
}

export async function deleteReading(v: Caller, id: string) {
  const [gone] = await v.db
    .delete(usageReading)
    .where(and(eq(usageReading.id, id), eq(usageReading.householdId, v.householdId)))
    .returning({ itemId: usageReading.itemId });
  if (!gone) throw notFound("Reading");
  await refreshUsageTasks(v, gone.itemId);
}

/** Work out again when this item's usage tasks are due. */
export async function refreshUsageTasks(v: Caller, itemId: string) {
  const tasks = await v.db
    .select({ id: maintenanceTask.id, timeDueOn: maintenanceTask.timeDueOn, usageDueAt: maintenanceTask.usageDueAt, dueOn: maintenanceTask.dueOn })
    .from(maintenanceTask)
    .where(
      and(
        eq(maintenanceTask.householdId, v.householdId),
        eq(maintenanceTask.itemId, itemId),
        isNotNull(maintenanceTask.usageDueAt),
        isNull(maintenanceTask.deletedAt),
      ),
    );
  if (!tasks.length) return;
  const readings = await readingsOf(v, itemId);
  for (const t of tasks) {
    const { dueOn } = effectiveDue(t, readings);
    if (dueOn !== t.dueOn) await v.db.update(maintenanceTask).set({ dueOn }).where(eq(maintenanceTask.id, t.id));
  }
}

/** The item's latest reading, or null. */
export async function currentReading(v: Caller, itemId: string) {
  const [last] = await v.db
    .select({ value: usageReading.value })
    .from(usageReading)
    .where(and(eq(usageReading.householdId, v.householdId), eq(usageReading.itemId, itemId)))
    .orderBy(desc(usageReading.readOn), desc(usageReading.createdAt))
    .limit(1);
  return last?.value ?? null;
}
