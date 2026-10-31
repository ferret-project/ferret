/**
 * Warranty claims: what went wrong, the provider's claim number, where it
 * stands, and how it ended (with what it cost us). Same Caller pattern as
 * lib/inventory.ts — everything scoped to the caller's household.
 */
import { type ClaimInput, type ClaimPatch, type ClaimStatus, type WarrantyClaim, openClaimStatuses } from "@ferret/shared";
import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { item, warranty, warrantyClaim } from "../db/schema";
import { type Caller, logActivity, notFound } from "./inventory";
import { todayFor } from "./household-time";

const claimIn = (v: Caller, id: string) =>
  and(eq(warrantyClaim.id, id), eq(warrantyClaim.householdId, v.householdId), isNull(warrantyClaim.deletedAt));

export async function listClaims(v: Caller, filter: { itemId?: string; warrantyId?: string; open?: boolean } = {}): Promise<WarrantyClaim[]> {
  const where: SQL[] = [eq(warrantyClaim.householdId, v.householdId), isNull(warrantyClaim.deletedAt), isNull(item.deletedAt)];
  if (filter.itemId) where.push(eq(warrantyClaim.itemId, filter.itemId));
  if (filter.warrantyId) where.push(eq(warrantyClaim.warrantyId, filter.warrantyId));
  if (filter.open) where.push(inArray(warrantyClaim.status, [...openClaimStatuses]));
  const rows = await v.db
    .select({ claim: warrantyClaim, itemName: item.name, warrantyProvider: warranty.provider })
    .from(warrantyClaim)
    .innerJoin(item, eq(item.id, warrantyClaim.itemId))
    .innerJoin(warranty, eq(warranty.id, warrantyClaim.warrantyId))
    .where(and(...where))
    .orderBy(desc(warrantyClaim.filedOn), desc(warrantyClaim.createdAt));
  return rows.map(({ claim: c, itemName, warrantyProvider }) => ({
    id: c.id,
    warrantyId: c.warrantyId,
    itemId: c.itemId,
    itemName,
    warrantyProvider,
    filedOn: c.filedOn,
    problem: c.problem,
    reference: c.reference,
    status: c.status as ClaimStatus,
    resolution: c.resolution,
    resolvedOn: c.resolvedOn,
    costCents: c.costCents,
    notes: c.notes,
  }));
}

async function getClaim(v: Caller, id: string) {
  const [found] = (await listClaims(v)).filter((c) => c.id === id);
  if (!found) throw notFound("Claim");
  return found;
}

/** Closing a claim (denied or resolved) dates it today unless a date is given. */
const settled = (status: ClaimStatus | undefined, resolvedOn: string | null | undefined, on: string) =>
  (status === "denied" || status === "resolved") && !resolvedOn ? on : resolvedOn;

export async function fileClaim(v: Caller, warrantyId: string, input: ClaimInput) {
  const [w] = await v.db
    .select({ id: warranty.id, itemId: warranty.itemId, itemName: item.name })
    .from(warranty)
    .innerJoin(item, eq(item.id, warranty.itemId))
    .where(and(eq(warranty.id, warrantyId), eq(warranty.householdId, v.householdId), isNull(warranty.deletedAt), isNull(item.deletedAt)));
  if (!w) throw notFound("Warranty");
  const status = input.status ?? "filed";
  const [row] = await v.db
    .insert(warrantyClaim)
    .values({
      ...input,
      householdId: v.householdId,
      warrantyId: w.id,
      itemId: w.itemId,
      filedOn: input.filedOn ?? todayFor(v),
      status,
      resolvedOn: settled(status, input.resolvedOn, todayFor(v)) ?? null,
    })
    .returning({ id: warrantyClaim.id });
  await logActivity(v, "claim.create", row!.id, `Filed a warranty claim for ${w.itemName}: ${input.problem.slice(0, 80)}`, w.itemId);
  return getClaim(v, row!.id);
}

export async function updateClaim(v: Caller, id: string, input: ClaimPatch) {
  const current = await getClaim(v, id);
  const status = input.status ?? current.status;
  const changes = { ...input, resolvedOn: input.status ? settled(status, input.resolvedOn ?? current.resolvedOn, todayFor(v)) : input.resolvedOn };
  if (changes.resolvedOn === undefined) delete changes.resolvedOn;
  await v.db.update(warrantyClaim).set(changes).where(claimIn(v, id));
  if (input.status && input.status !== current.status) {
    await logActivity(v, "claim.update", id, `Warranty claim for ${current.itemName}: ${input.status.replace("_", " ")}`, current.itemId);
  }
  return getClaim(v, id);
}

export async function deleteClaim(v: Caller, id: string) {
  const current = await getClaim(v, id);
  await v.db.update(warrantyClaim).set({ deletedAt: new Date() }).where(claimIn(v, id));
  await logActivity(v, "claim.delete", id, `Removed a warranty claim for ${current.itemName}`, current.itemId);
}
