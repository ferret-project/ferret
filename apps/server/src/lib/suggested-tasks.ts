import { t as translateText } from "./i18n";
/**
 * Suggested maintenance: every schedule Ferret found for the household's things — read from their manuals (the
 * analysis job) or the AI's typical upkeep for their kind (lib/typical-upkeep.ts) — in one list on the Maintenance
 * screen. Never added by themselves: a person adds each (opening it filled in, to adjust) or says it isn't needed,
 * which is remembered.
 */
import type { SuggestedTask } from "@ferret/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import { attachment, item, maintenanceTask, suggestedTask } from "../db/schema";
import type { Db } from "../ports";
import { type Caller, itemScope, logActivity, notFound } from "./inventory";
import { inList } from "./sql";

type Schedule = { title: string; intervalCount: number; intervalUnit: "day" | "week" | "month" | "year" };

const key = (title: string) => title.trim().toLowerCase();
/** "Descale" and "Descale the machine" are the same job: either containing the other counts. */
const sameJob = (a: string, b: string) => a.includes(b) || b.includes(a);

/** Adds schedules found for an item (one per job; ones it already tracks or already suggested are skipped). */
export async function suggestTasks(
  db: Db,
  at: { householdId: string; itemId: string; attachmentId?: string | null; source: "manual" | "typical" },
  schedules: Schedule[],
) {
  if (!schedules.length) return 0;
  const tracked = (
    await db
      .select({ title: maintenanceTask.title })
      .from(maintenanceTask)
      .where(and(eq(maintenanceTask.householdId, at.householdId), eq(maintenanceTask.itemId, at.itemId), isNull(maintenanceTask.deletedAt)))
  ).map((t) => key(t.title));
  const already = (
    await db
      .select({ titleKey: suggestedTask.titleKey })
      .from(suggestedTask)
      .where(and(eq(suggestedTask.householdId, at.householdId), eq(suggestedTask.itemId, at.itemId)))
  ).map((t) => t.titleKey);
  let added = 0;
  for (const s of schedules) {
    const k = key(s.title);
    if (!k || [...tracked, ...already].some((t) => sameJob(t, k))) continue;
    already.push(k);
    await db
      .insert(suggestedTask)
      .values({
        householdId: at.householdId,
        itemId: at.itemId,
        title: s.title.trim(),
        titleKey: k,
        intervalCount: s.intervalCount,
        intervalUnit: s.intervalUnit,
        source: at.source,
        attachmentId: at.attachmentId ?? null,
      })
      .onConflictDoNothing();
    added++;
  }
  return added;
}

/** Open suggestions (not added, not dismissed), for things the household still has — newest first; or one item's. */
export async function listSuggestedTasks(v: Caller, itemId?: string): Promise<SuggestedTask[]> {
  const rows = await v.db
    .select({ s: suggestedTask, itemName: item.name, filename: attachment.filename })
    .from(suggestedTask)
    .innerJoin(item, eq(item.id, suggestedTask.itemId))
    .leftJoin(attachment, and(eq(attachment.id, suggestedTask.attachmentId), isNull(attachment.deletedAt)))
    .where(
      and(
        eq(suggestedTask.householdId, v.householdId),
        isNull(suggestedTask.addedAt),
        isNull(suggestedTask.dismissedAt),
        itemScope(v),
        itemId ? eq(suggestedTask.itemId, itemId) : undefined,
      ),
    )
    .orderBy(desc(suggestedTask.createdAt))
    .limit(500);
  if (!rows.length) return [];
  // Tasks added by hand since: the job's tracked now.
  const ids = [...new Set(rows.map((r) => r.s.itemId))];
  const tasks = await v.db
    .select({ itemId: maintenanceTask.itemId, title: maintenanceTask.title })
    .from(maintenanceTask)
    .where(and(eq(maintenanceTask.householdId, v.householdId), inList(maintenanceTask.itemId, ids), isNull(maintenanceTask.deletedAt)));
  const trackedBy = new Map<string, string[]>();
  for (const t of tasks) trackedBy.set(t.itemId!, [...(trackedBy.get(t.itemId!) ?? []), key(t.title)]);
  return rows
    .filter((r) => !(trackedBy.get(r.s.itemId) ?? []).some((t) => sameJob(t, r.s.titleKey)))
    .map(({ s, itemName, filename }) => ({
      id: s.id,
      itemId: s.itemId,
      itemName,
      title: s.title,
      intervalCount: s.intervalCount,
      intervalUnit: s.intervalUnit,
      source: s.source,
      attachmentId: s.attachmentId,
      filename: filename ?? null,
      createdAt: s.createdAt.toISOString(),
    }));
}

const suggestionIn = (v: Pick<Caller, "householdId">, id: string) => and(eq(suggestedTask.id, id), eq(suggestedTask.householdId, v.householdId));

/** "Not needed": remembered, so it isn't suggested again. */
export async function dismissSuggestedTask(v: Caller, id: string) {
  const [row] = await v.db.update(suggestedTask).set({ dismissedAt: new Date() }).where(suggestionIn(v, id)).returning();
  if (!row) throw notFound(translateText("Suggestion"));
  await logActivity(v, "maintenance.suggestion_dismissed", row.id, translateText("Not needed: {v0}", { v0: row.title }), row.itemId);
  return { ok: true };
}

/** A suggestion was added as a task (createTask with `suggestionId`). */
export async function markSuggestionAdded(v: Caller, id: string) {
  await v.db.update(suggestedTask).set({ addedAt: new Date() }).where(suggestionIn(v, id));
}

/** How many are waiting (the bell's gentle line). */
export async function suggestedTaskCount(v: Caller) {
  return (await listSuggestedTasks(v)).length;
}
