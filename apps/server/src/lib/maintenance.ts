/**
 * Maintenance: recurring (or one-off) jobs on items, places or the whole
 * household. Shared by the REST API, the MCP tools, the calendar feed and the
 * push reminders. Like lib/inventory.ts, every function acts for one Caller
 * and filters by its householdId.
 */
import {
  type MaintenanceDone,
  type MaintenanceInput,
  type MaintenanceLogEntry,
  type MaintenancePatch,
  type MaintenanceStatus,
  type MaintenanceTask,
  describeInterval,
  describeUsage,
  effectiveDue,
  maintenanceStatus,
  nextDue,
  today,
  usagePerDay,
} from "@ferret/shared";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item, location, maintenanceLog, maintenanceTask, provider, usageReading, user } from "../db/schema";
import { type Caller, itemScope, locationIn, locationPaths, logActivity, notFound } from "./inventory";
import { checkProvider } from "./providers";
import { alias } from "drizzle-orm/sqlite-core";
import { adjustStock } from "./stock";
import { currentReading, readingsOf } from "./usage";
import { todayFor } from "./household-time";
import { inList } from "./sql";

const taskIn = (v: Pick<Caller, "householdId">, id: string) =>
  and(eq(maintenanceTask.id, id), eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt));

export interface MaintenanceFilter {
  itemId?: string;
  /** Tasks this provider usually does. */
  providerId?: string;
  /** "open" = everything not done (the default for lists); or one status. */
  status?: MaintenanceStatus | "open" | "all";
}

/** Tasks with their item and place, soonest due first (finished one-offs last). */
/** The item a task uses up (its part), joined alongside the item it's on. */
const part = alias(item, "part");

export async function listMaintenance(v: Caller, filter: MaintenanceFilter = {}): Promise<MaintenanceTask[]> {
  const where: SQL[] = [eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt)];
  if (filter.itemId) where.push(eq(maintenanceTask.itemId, filter.itemId));
  if (filter.providerId) where.push(eq(maintenanceTask.providerId, filter.providerId));
  const [rows, paths] = await Promise.all([
    v.db
      .select({
        task: maintenanceTask,
        itemName: item.name,
        itemUsageUnit: item.usageUnit,
        itemLocationId: item.locationId,
        itemDeletedAt: item.deletedAt,
        itemGone: item.disposition,
        providerName: provider.name,
        partName: part.name,
        partQuantity: part.quantity,
        partDeletedAt: part.deletedAt,
        partGone: part.disposition,
      })
      .from(maintenanceTask)
      .leftJoin(item, eq(item.id, maintenanceTask.itemId))
      .leftJoin(part, eq(part.id, maintenanceTask.partItemId))
      .leftJoin(provider, and(eq(provider.id, maintenanceTask.providerId), isNull(provider.deletedAt)))
      .where(and(...where)),
    locationPaths(v),
  ]);
  const on = todayFor(v);
  const status = filter.status ?? "open";
  // Readings of the items with tasks by use: their latest, their rate, and whether a due date is an estimate.
  const counted = [...new Set(rows.filter((r) => r.task.usageEvery && r.task.itemId).map((r) => r.task.itemId!))];
  const readings = counted.length
    ? await v.db
        .select({ itemId: usageReading.itemId, value: usageReading.value, readOn: usageReading.readOn })
        .from(usageReading)
        .where(and(eq(usageReading.householdId, v.householdId), inList(usageReading.itemId, counted)))
        .orderBy(usageReading.readOn, usageReading.createdAt)
    : [];
  const readingsFor = (itemId: string) => readings.filter((r) => r.itemId === itemId);
  return rows
    .filter((r) => !r.itemDeletedAt && !r.itemGone) // tasks on removed (or sold, lost…) items go with them
    .map(({ task: t, itemName, itemUsageUnit, itemLocationId, providerName, partName, partQuantity, partDeletedAt, partGone }) => {
      const placeId = t.locationId ?? itemLocationId;
      const own = t.usageEvery && t.itemId && t.usageDueAt != null && itemUsageUnit ? readingsFor(t.itemId) : null;
      return {
        id: t.id,
        title: t.title,
        notes: t.notes,
        itemId: t.itemId,
        itemName: itemName ?? null,
        locationId: t.locationId,
        place: placeId ? (paths.get(placeId) ?? null) : null,
        intervalCount: t.intervalCount,
        intervalUnit: t.intervalUnit,
        dueOn: t.dueOn,
        lastDoneOn: t.lastDoneOn,
        attachmentId: t.attachmentId,
        providerId: providerName ? t.providerId : null,
        providerName: providerName ?? null,
        part:
          t.partItemId && partName != null && !partDeletedAt && !partGone
            ? { itemId: t.partItemId, name: partName, uses: t.partQuantity, left: partQuantity ?? 0 }
            : null,
        status: maintenanceStatus(t.dueOn, on),
        timeDueOn: t.timeDueOn,
        usage: own
          ? { every: t.usageEvery!, dueAt: t.usageDueAt!, unit: itemUsageUnit!, now: own.at(-1)?.value ?? null, perDay: usagePerDay(own) }
          : null,
        dueEstimated: own ? effectiveDue(t, own, on).estimated : false,
      };
    })
    .filter((t) => status === "all" || (status === "open" ? t.status !== "done" : t.status === status))
    .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || a.title.localeCompare(b.title));
}

export async function getTask(v: Caller, id: string) {
  const [found] = (await listMaintenance(v, { status: "all" })).filter((t) => t.id === id);
  if (!found) throw notFound("Maintenance task");
  return found;
}

/** What a task points at (item, place, manual) must be in the same household. */
async function checkLinks(
  v: Caller,
  input: { itemId?: string | null; locationId?: string | null; attachmentId?: string | null; providerId?: string | null; partItemId?: string | null },
) {
  await checkProvider(v, input.providerId);
  if (input.partItemId) {
    const [found] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, input.partItemId), itemScope(v)));
    if (!found) throw notFound("Part");
  }
  if (input.itemId) {
    const [found] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, input.itemId), itemScope(v)));
    if (!found) throw notFound("Item");
  }
  if (input.locationId) {
    const [place] = await v.db.select({ id: location.id }).from(location).where(locationIn(v, input.locationId));
    if (!place) throw notFound("Location");
  }
  if (input.attachmentId) {
    const [doc] = await v.db
      .select({ id: attachment.id })
      .from(attachment)
      .where(and(eq(attachment.id, input.attachmentId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)));
    if (!doc) throw notFound("Attachment");
  }
}

/** A task by use needs its item to count something, and a reading to count from: the reading it's next due at. */
async function usageStart(v: Caller, itemId: string, every: number) {
  const [it] = await v.db.select({ name: item.name, unit: item.usageUnit }).from(item).where(and(eq(item.id, itemId), itemScope(v)));
  if (!it?.unit) throw new HTTPException(422, { message: `Say what ${it?.name ?? "it"} counts first (miles, hours…)` });
  const now = await currentReading(v, itemId);
  if (now == null) throw new HTTPException(422, { message: `Add a reading for ${it.name} first — what does it say now?` });
  return now + every;
}

export async function createTask(v: Caller, input: MaintenanceInput) {
  await checkLinks(v, input);
  const on = todayFor(v);
  const repeats = input.intervalCount && input.intervalUnit;
  // By time: the date given, else one interval from today; a one-off is due today — unless it's by use alone.
  const timeDueOn = input.dueOn ?? (repeats ? nextDue(on, input.intervalCount!, input.intervalUnit!) : input.usageEvery ? null : on);
  const usageDueAt = input.usageEvery ? await usageStart(v, input.itemId!, input.usageEvery) : null;
  const { dueOn } = effectiveDue({ timeDueOn, usageDueAt }, input.itemId && usageDueAt != null ? await readingsOf(v, input.itemId) : []);
  const [row] = await v.db
    .insert(maintenanceTask)
    .values({
      householdId: v.householdId,
      title: input.title,
      notes: input.notes ?? null,
      itemId: input.itemId ?? null,
      locationId: input.locationId ?? null,
      intervalCount: repeats ? input.intervalCount : null,
      intervalUnit: repeats ? input.intervalUnit : null,
      dueOn,
      timeDueOn,
      usageEvery: input.usageEvery ?? null,
      usageDueAt,
      attachmentId: input.attachmentId ?? null,
      providerId: input.providerId ?? null,
      partItemId: input.partItemId ?? null,
      partQuantity: input.partQuantity ?? 1,
      createdBy: v.userId,
    })
    .returning();
  await logActivity(v, "maintenance.create", row!.id, `Added maintenance: ${row!.title} (${await describeSchedule(v, row!)})`, row!.itemId);
  return getTask(v, row!.id);
}

export async function updateTask(v: Caller, id: string, input: MaintenancePatch) {
  await checkLinks(v, input);
  const [before] = await v.db.select().from(maintenanceTask).where(taskIn(v, id));
  if (!before) throw notFound("Maintenance task");
  const changes: Partial<typeof maintenanceTask.$inferInsert> = { ...input };
  // Clearing one half of the interval clears both: it's a one-off now.
  if (input.intervalCount === null || input.intervalUnit === null) Object.assign(changes, { intervalCount: null, intervalUnit: null });
  // Rescheduling sets the date by time; what it's due at by use stays.
  if (input.dueOn !== undefined) changes.timeDueOn = input.dueOn;
  // By use: off, a new amount (counted on from the same start), or now on another item (from its latest reading).
  const itemId = input.itemId !== undefined ? input.itemId : before.itemId;
  const every = input.usageEvery !== undefined ? input.usageEvery : before.usageEvery;
  if (!every) changes.usageDueAt = null;
  else if (!itemId) throw new HTTPException(422, { message: "Maintenance by use needs the thing it's on" });
  else if (itemId !== before.itemId || before.usageDueAt == null) changes.usageDueAt = await usageStart(v, itemId, every);
  else if (before.usageEvery && every !== before.usageEvery) changes.usageDueAt = before.usageDueAt - before.usageEvery + every;
  const [updated] = await v.db.update(maintenanceTask).set(changes).where(taskIn(v, id)).returning();
  if (!updated) throw notFound("Maintenance task");
  const { dueOn } = effectiveDue(updated, updated.itemId && updated.usageDueAt != null ? await readingsOf(v, updated.itemId) : []);
  const [row] = await v.db.update(maintenanceTask).set({ dueOn }).where(taskIn(v, id)).returning();
  if (!row) throw notFound("Maintenance task");
  await logActivity(v, "maintenance.update", row.id, `Updated maintenance: ${row.title}`, row.itemId);
  return getTask(v, row.id);
}

export async function deleteTask(v: Caller, id: string) {
  const [row] = await v.db
    .update(maintenanceTask)
    .set({ deletedAt: new Date() })
    .where(taskIn(v, id))
    .returning({ id: maintenanceTask.id, title: maintenanceTask.title, itemId: maintenanceTask.itemId });
  if (!row) throw notFound("Maintenance task");
  await logActivity(v, "maintenance.delete", row.id, `Removed maintenance: ${row.title}`, row.itemId);
  return row;
}

/** Done: log it, and move the next due date on from the day it was done (a one-off is finished). */
export async function markDone(v: Caller, id: string, input: MaintenanceDone) {
  const [task] = await v.db.select().from(maintenanceTask).where(taskIn(v, id));
  if (!task) throw notFound("Maintenance task");
  const doneOn = input.doneOn ?? todayFor(v);
  // Who did it: as given (null = we did), else the task's usual provider.
  const providerId = input.providerId !== undefined ? input.providerId : task.providerId;
  await checkProvider(v, providerId);
  if (doneOn > todayFor(v)) throw new HTTPException(422, { message: "That's in the future — mark it done once it's done" });
  await v.db.insert(maintenanceLog).values({
    householdId: v.householdId,
    taskId: id,
    doneOn,
    doneBy: v.userId,
    providerId: providerId ?? null,
    note: input.note ?? null,
    costCents: input.costCents ?? null,
  });
  const repeats = task.intervalCount && task.intervalUnit;
  const lastDoneOn = !task.lastDoneOn || doneOn > task.lastDoneOn ? doneOn : task.lastDoneOn;
  const timeDueOn = repeats ? nextDue(lastDoneOn, task.intervalCount!, task.intervalUnit!) : null;
  const [owner] = task.itemId ? await v.db.select({ name: item.name, unit: item.usageUnit }).from(item).where(eq(item.id, task.itemId)) : [];
  // By use: the reading now (logged, when given) — the next is due one `usageEvery` on from it.
  let usageDueAt = task.usageDueAt;
  let at: number | null = null;
  if (task.usageEvery && task.itemId && owner?.unit) {
    if (input.reading != null) {
      await v.db.insert(usageReading).values({ householdId: v.householdId, itemId: task.itemId, value: input.reading, readOn: doneOn, note: `Done: ${task.title}`, userId: v.userId });
    }
    at = input.reading ?? (await currentReading(v, task.itemId));
    if (at != null) usageDueAt = at + task.usageEvery;
  }
  const { dueOn } = effectiveDue({ timeDueOn, usageDueAt }, task.itemId && usageDueAt != null ? await readingsOf(v, task.itemId) : []);
  await v.db.update(maintenanceTask).set({ lastDoneOn, timeDueOn, usageDueAt, dueOn }).where(taskIn(v, id));
  const atText = at != null && owner?.unit ? ` at ${describeUsage(at, owner.unit)}` : "";
  await logActivity(v, "maintenance.done", id, `Done: ${task.title}${owner ? ` (${owner.name})` : ""}${atText}`, task.itemId);
  // The part it uses comes out of stock (never below 0) — unless they say they didn't use one this time.
  if (task.partItemId && input.usePart !== false) {
    const [stillThere] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, task.partItemId), itemScope(v)));
    if (stillThere) await adjustStock(v, task.partItemId, -task.partQuantity, "maintenance", `For ${task.title}`);
  }
  return getTask(v, id);
}

/** When a task was done, newest first. */
export async function taskHistory(v: Caller, id: string): Promise<MaintenanceLogEntry[]> {
  await getTask(v, id);
  return v.db
    .select({
      id: maintenanceLog.id,
      doneOn: maintenanceLog.doneOn,
      doneByName: user.name,
      providerName: provider.name,
      note: maintenanceLog.note,
      costCents: maintenanceLog.costCents,
    })
    .from(maintenanceLog)
    .leftJoin(user, eq(user.id, maintenanceLog.doneBy))
    .leftJoin(provider, eq(provider.id, maintenanceLog.providerId))
    .where(and(eq(maintenanceLog.taskId, id), eq(maintenanceLog.householdId, v.householdId)))
    .orderBy(desc(maintenanceLog.doneOn), desc(maintenanceLog.createdAt));
}

/** "every 3 months", "every 5,000 miles", "every 5,000 miles or 6 months". */
async function describeSchedule(v: Caller, t: { intervalCount: number | null; intervalUnit: MaintenanceTask["intervalUnit"]; usageEvery: number | null; itemId: string | null }) {
  const byTime = describeInterval(t.intervalCount, t.intervalUnit);
  if (!t.usageEvery || !t.itemId) return byTime;
  const [it] = await v.db.select({ unit: item.usageUnit }).from(item).where(eq(item.id, t.itemId));
  if (!it?.unit) return byTime;
  const byUse = `every ${describeUsage(t.usageEvery, it.unit)}`;
  return t.intervalCount ? `${byUse} or ${t.intervalCount === 1 ? `a ${t.intervalUnit}` : byTime.replace(/^every /, "")}` : byUse;
}
