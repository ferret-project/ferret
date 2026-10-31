/**
 * Recall checks (lib/recalls.ts): daily, every household (each asks the CPSC only about brands it hasn't in a week);
 * and one household after its things change (queued once while pending — an import of 500 things is one check).
 * Both do nothing until the server admin switches recall checks on.
 */
import { organization } from "../db/schema";
import { checkHousehold } from "../lib/recalls";
import type { Deps, JobHandler } from "../ports";
import { householdTimeZone } from "../lib/household-time";

export const RECALL_SYNC_JOB = "recalls.sync";
export const RECALL_CHECK_JOB = "recalls.check";

const caller = async (deps: Deps, householdId: string) => ({ deps, db: deps.db, householdId, userId: "", timeZone: await householdTimeZone(deps.db, householdId), via: "web" as const });

export function recallSyncJob(deps: Deps): JobHandler {
  return async () => {
    for (const { id } of await deps.db.select({ id: organization.id }).from(organization)) await checkHousehold(await caller(deps, id));
  };
}

export function recallCheckJob(deps: Deps): JobHandler {
  return async (payload) => {
    const { householdId } = payload as { householdId: string };
    if (householdId) await checkHousehold(await caller(deps, householdId));
  };
}
