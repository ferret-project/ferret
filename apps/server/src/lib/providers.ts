/**
 * Service providers: the plumber, the HVAC company, the appliance repair shop.
 * Maintenance tasks say who usually does them, and each "done" can say who did
 * it this time — so a provider's page is their history with the house.
 */
import type { Provider, ProviderInput, ProviderPatch, ProviderVisit } from "@ferret/shared";
import { and, count, desc, eq, isNull, max, sql } from "drizzle-orm";
import { item, maintenanceLog, maintenanceTask, provider } from "../db/schema";
import { type Caller, logActivity, notFound } from "./inventory";

export const providerIn = (v: Pick<Caller, "householdId">, id: string) =>
  and(eq(provider.id, id), eq(provider.householdId, v.householdId), isNull(provider.deletedAt));

const fields = {
  id: provider.id,
  name: provider.name,
  trade: provider.trade,
  contactName: provider.contactName,
  phone: provider.phone,
  email: provider.email,
  website: provider.website,
  address: provider.address,
  notes: provider.notes,
};

/** Every provider, with how many tasks they do, their visits, the last one and what they've cost. */
export async function listProviders(v: Caller): Promise<Provider[]> {
  const [rows, tasks, visits] = await Promise.all([
    v.db
      .select(fields)
      .from(provider)
      .where(and(eq(provider.householdId, v.householdId), isNull(provider.deletedAt)))
      .orderBy(provider.name),
    v.db
      .select({ providerId: maintenanceTask.providerId, n: count() })
      .from(maintenanceTask)
      .where(and(eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt)))
      .groupBy(maintenanceTask.providerId),
    v.db
      .select({
        providerId: maintenanceLog.providerId,
        n: count(),
        last: max(maintenanceLog.doneOn),
        spent: sql<number>`coalesce(sum(${maintenanceLog.costCents}), 0)`,
      })
      .from(maintenanceLog)
      .where(eq(maintenanceLog.householdId, v.householdId))
      .groupBy(maintenanceLog.providerId),
  ]);
  const taskCount = new Map(tasks.map((t) => [t.providerId, t.n]));
  const visitStats = new Map(visits.map((x) => [x.providerId, x]));
  return rows.map((p) => {
    const stats = visitStats.get(p.id);
    return { ...p, tasks: taskCount.get(p.id) ?? 0, visits: stats?.n ?? 0, lastVisit: stats?.last ?? null, spentCents: Number(stats?.spent ?? 0) };
  });
}

export async function getProvider(v: Caller, id: string) {
  const found = (await listProviders(v)).find((p) => p.id === id);
  if (!found) throw notFound("Provider");
  return found;
}

/** The jobs a provider did, newest first. */
export async function providerVisits(v: Caller, id: string): Promise<ProviderVisit[]> {
  await getProvider(v, id);
  return v.db
    .select({
      id: maintenanceLog.id,
      doneOn: maintenanceLog.doneOn,
      taskId: maintenanceTask.id,
      taskTitle: maintenanceTask.title,
      itemId: maintenanceTask.itemId,
      itemName: item.name,
      note: maintenanceLog.note,
      costCents: maintenanceLog.costCents,
    })
    .from(maintenanceLog)
    .innerJoin(maintenanceTask, eq(maintenanceTask.id, maintenanceLog.taskId))
    .leftJoin(item, eq(item.id, maintenanceTask.itemId))
    .where(and(eq(maintenanceLog.householdId, v.householdId), eq(maintenanceLog.providerId, id)))
    .orderBy(desc(maintenanceLog.doneOn), desc(maintenanceLog.createdAt));
}

export async function createProvider(v: Caller, input: ProviderInput) {
  const [row] = await v.db
    .insert(provider)
    .values({ ...input, householdId: v.householdId })
    .returning({ id: provider.id, name: provider.name });
  await logActivity(v, "provider.create", row!.id, `Added ${row!.name}`);
  return getProvider(v, row!.id);
}

export async function updateProvider(v: Caller, id: string, input: ProviderPatch) {
  const [row] = await v.db.update(provider).set(input).where(providerIn(v, id)).returning({ id: provider.id });
  if (!row) throw notFound("Provider");
  return getProvider(v, id);
}

/** Removes a provider; their history stays on the tasks it belongs to, without the name. */
export async function deleteProvider(v: Caller, id: string) {
  const [row] = await v.db
    .update(provider)
    .set({ deletedAt: new Date() })
    .where(providerIn(v, id))
    .returning({ id: provider.id, name: provider.name });
  if (!row) throw notFound("Provider");
  await v.db
    .update(maintenanceTask)
    .set({ providerId: null })
    .where(and(eq(maintenanceTask.householdId, v.householdId), eq(maintenanceTask.providerId, id)));
  await logActivity(v, "provider.delete", id, `Removed ${row.name}`);
}

/** A provider id from a request must be one of this household's. */
export async function checkProvider(v: Caller, id: string | null | undefined) {
  if (!id) return;
  const [found] = await v.db.select({ id: provider.id }).from(provider).where(providerIn(v, id));
  if (!found) throw notFound("Provider");
}
