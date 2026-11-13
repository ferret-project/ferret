/**
 * Repairs and what owning a thing costs.
 *
 * A repair is a one-off record on an item — what went wrong, what was done, who did it (a provider), the parts, the
 * cost — not a schedule (that's maintenance; a repair can name the task it belongs to). Its photos and invoices are the
 * item's attachments with `repairId`, so storage, backups and Download everything need nothing new. A repair warranty
 * is an ordinary warranty of the item (from the repair day), linked by `warrantyId`. Soft-deleted, purged with the rest.
 *
 * Cost of ownership: what was paid + done maintenance's costs + repairs, less what it sold for (or insurance paid)
 * once it's gone — in total and per year owned.
 */
import type { OwnershipCost, Repair, RepairInput, RepairPatch } from "@ferret/shared";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item, maintenanceLog, maintenanceTask, provider, repair, user, warranty } from "../db/schema";
import { type Caller, itemChanged, itemScope, logActivity, notFound } from "./inventory";
import { moneyText, todayFor } from "./household-time";
import { createWarranty } from "./warranties";
import { inList } from "./sql";

const repairIn = (v: Caller, id: string) => and(eq(repair.id, id), eq(repair.householdId, v.householdId), isNull(repair.deletedAt));

async function itemOf(v: Caller, itemId: string) {
  const [row] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!row) throw notFound("Item");
  return row;
}

/** The provider and task named must be this household's (and the task this item's, or the house's). */
async function checkRefs(v: Caller, itemId: string, input: Pick<RepairPatch, "providerId" | "taskId">) {
  if (input.providerId) {
    const [p] = await v.db.select({ id: provider.id }).from(provider).where(and(eq(provider.id, input.providerId), eq(provider.householdId, v.householdId), isNull(provider.deletedAt)));
    if (!p) throw notFound("Provider");
  }
  if (input.taskId) {
    const [t] = await v.db
      .select({ id: maintenanceTask.id, itemId: maintenanceTask.itemId })
      .from(maintenanceTask)
      .where(and(eq(maintenanceTask.id, input.taskId), eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt)));
    if (!t) throw notFound("Maintenance task");
    if (t.itemId && t.itemId !== itemId) throw new HTTPException(422, { message: "That maintenance task is another thing's" });
  }
}

/** An item's repairs, newest first. */
export async function listRepairs(v: Caller, itemId: string): Promise<Repair[]> {
  await itemOf(v, itemId);
  return repairsWhere(v, eq(repair.itemId, itemId));
}

async function repairsWhere(v: Caller, where: SQL): Promise<Repair[]> {
  const rows = await v.db
    .select({
      r: repair,
      providerName: provider.name,
      taskTitle: maintenanceTask.title,
      warrantyEndsOn: warranty.endsOn,
      warrantyGone: warranty.deletedAt,
      by: user.name,
    })
    .from(repair)
    .leftJoin(provider, eq(provider.id, repair.providerId))
    .leftJoin(maintenanceTask, eq(maintenanceTask.id, repair.taskId))
    .leftJoin(warranty, eq(warranty.id, repair.warrantyId))
    .leftJoin(user, eq(user.id, repair.doneBy))
    .where(and(eq(repair.householdId, v.householdId), isNull(repair.deletedAt), where))
    .orderBy(desc(repair.repairedOn), desc(repair.createdAt));
  const ids = rows.map((x) => x.r.id);
  const files = ids.length
    ? await v.db
        .select({ id: attachment.id, repairId: attachment.repairId })
        .from(attachment)
        .where(and(eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt), inList(attachment.repairId, ids)))
    : [];
  return rows.map(({ r, providerName, taskTitle, warrantyEndsOn, warrantyGone, by }) => ({
    id: r.id,
    itemId: r.itemId,
    repairedOn: r.repairedOn,
    work: r.work,
    problem: r.problem,
    providerId: r.providerId,
    providerName: providerName ?? null,
    parts: r.parts,
    costCents: r.costCents,
    warrantyId: warrantyGone ? null : r.warrantyId,
    warrantyEndsOn: warrantyGone ? null : (warrantyEndsOn ?? null),
    taskId: r.taskId,
    taskTitle: taskTitle ?? null,
    by: by ?? null,
    attachmentIds: files.filter((f) => f.repairId === r.id).map((f) => f.id),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getRepair(v: Caller, id: string) {
  const [r] = await repairsWhere(v, eq(repair.id, id));
  if (!r) throw notFound("Repair");
  return r;
}

/** Logs a repair (and its warranty, as one of the item's): "Repaired the washer: replaced the drain pump" in its history. */
export async function createRepair(v: Caller, itemId: string, input: RepairInput) {
  const owner = await itemOf(v, itemId);
  await checkRefs(v, owner.id, input);
  if (input.repairedOn > todayFor(v)) throw new HTTPException(422, { message: "A repair can't be in the future" });
  const { warrantyEndsOn, ...fields } = input;
  if (warrantyEndsOn && warrantyEndsOn < input.repairedOn) throw new HTTPException(422, { message: "The repair's warranty can't end before the repair" });
  let warrantyId: string | null = null;
  if (warrantyEndsOn) {
    const [who] = input.providerId ? await v.db.select({ name: provider.name }).from(provider).where(eq(provider.id, input.providerId)) : [];
    const w = await createWarranty(v, owner.id, { provider: who?.name ?? null, startsOn: input.repairedOn, endsOn: warrantyEndsOn, coverage: `Repair: ${input.work}` });
    warrantyId = w.id;
  }
  const [row] = await v.db
    .insert(repair)
    .values({ ...fields, householdId: v.householdId, itemId: owner.id, warrantyId, doneBy: v.userId || null })
    .returning({ id: repair.id });
  const cost = input.costCents != null ? ` (${moneyText(v, input.costCents)})` : "";
  await logActivity(v, "repair.create", row!.id, `Repaired ${owner.name}: ${input.work}${cost}`, owner.id);
  await itemChanged(v, owner.id);
  return getRepair(v, row!.id);
}

export async function updateRepair(v: Caller, id: string, input: RepairPatch) {
  const [current] = await v.db.select().from(repair).where(repairIn(v, id));
  if (!current) throw notFound("Repair");
  await checkRefs(v, current.itemId, input);
  if (input.repairedOn && input.repairedOn > todayFor(v)) throw new HTTPException(422, { message: "A repair can't be in the future" });
  await v.db.update(repair).set(input).where(repairIn(v, id));
  await itemChanged(v, current.itemId);
  return getRepair(v, id);
}

/** Soft delete: its photos stay the item's; its warranty stays (remove that on its own). */
export async function deleteRepair(v: Caller, id: string) {
  const [row] = await v.db.update(repair).set({ deletedAt: new Date() }).where(repairIn(v, id)).returning({ itemId: repair.itemId, work: repair.work });
  if (!row) throw notFound("Repair");
  await logActivity(v, "repair.delete", id, `Removed a repair: ${row.work}`, row.itemId);
  await itemChanged(v, row.itemId);
}

/** An attachment being added to a repair: the repair must be this item's. */
export async function repairOfItem(v: Caller, itemId: string, repairId: string) {
  const [r] = await v.db.select({ id: repair.id }).from(repair).where(and(repairIn(v, repairId), eq(repair.itemId, itemId)));
  if (!r) throw notFound("Repair");
  return r.id;
}

/** What owning it has cost: paid + maintenance + repairs − what it sold for, in total and per year owned. */
export async function ownershipCost(v: Caller, itemId: string): Promise<OwnershipCost> {
  const [it] = await v.db.select().from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!it) throw notFound("Item");
  const [[upkeep], [fixes]] = await Promise.all([
    v.db
      .select({ cents: sql<number>`coalesce(sum(${maintenanceLog.costCents}), 0)`, n: sql<number>`count(${maintenanceLog.costCents})` })
      .from(maintenanceLog)
      .innerJoin(maintenanceTask, eq(maintenanceTask.id, maintenanceLog.taskId))
      .where(and(eq(maintenanceLog.householdId, v.householdId), eq(maintenanceTask.itemId, it.id), isNull(maintenanceTask.deletedAt))),
    v.db
      .select({ cents: sql<number>`coalesce(sum(${repair.costCents}), 0)`, n: sql<number>`count(*)` })
      .from(repair)
      .where(and(eq(repair.householdId, v.householdId), eq(repair.itemId, it.id), isNull(repair.deletedAt))),
  ]);
  const paidCents = it.purchasePriceCents != null ? it.purchasePriceCents * Math.max(1, it.quantity) : null;
  // Sold, or insurance paid out (lost, stolen): it comes off. A donation's "worth when given" isn't money back.
  const backCents = it.disposition && it.disposition !== "donated" && it.disposition !== "given" ? it.disposalCents : null;
  const since = it.purchaseDate ?? todayFor(v, it.createdAt);
  const until = it.disposition && it.disposedOn ? it.disposedOn : todayFor(v);
  const days = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000;
  const years = Math.max(1, Math.round((days / 365.25) * 10) / 10);
  const totalCents = (paidCents ?? 0) + Number(upkeep?.cents ?? 0) + Number(fixes?.cents ?? 0) - (backCents ?? 0);
  return {
    paidCents,
    maintenanceCents: Number(upkeep?.cents ?? 0),
    maintenanceTimes: Number(upkeep?.n ?? 0),
    repairCents: Number(fixes?.cents ?? 0),
    repairs: Number(fixes?.n ?? 0),
    backCents,
    totalCents,
    years,
    perYearCents: Math.round(totalCents / years),
    since,
  };
}

/** For GET /items/:id: what replaced it, and what it replaced. */
export async function replacementsOf(v: Caller, row: typeof item.$inferSelect) {
  const [by, replaces] = await Promise.all([
    row.replacedById
      ? v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, row.replacedById), itemScope(v, { gone: "include" })))
      : Promise.resolve([]),
    v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.replacedById, row.id), itemScope(v, { gone: "include" }))),
  ]);
  return { replacedBy: by[0] ?? null, replaces };
}

