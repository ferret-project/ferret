/**
 * New versions of Ferret: once a day, when the server admin has switched it on (Settings → Server → Updates; off by
 * default — it's a call out to GitHub), the newest release is asked for (deps.releases) and kept; a newer one than
 * this server's goes in the server admin's bell with its release notes in Settings → Server. Hosted and the demo have
 * no `releases` (they're updated for them), so there's nothing to switch on there.
 */
import type { UpdateStatus } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";

export const UPDATE_CHECK_JOB = "updates.check";
const ENABLED_KEY = "updates.enabled";
const LATEST_KEY = "updates.latest";

type Latest = NonNullable<UpdateStatus["latest"]>;

/** Whether checking is on, and the newest release seen. */
export async function updatesState(db: Db) {
  const rows = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  const [latest] = await db.select().from(serverSetting).where(eq(serverSetting.key, LATEST_KEY));
  let seen: Latest | null = null;
  try {
    seen = latest ? (JSON.parse(latest.value) as Latest) : null;
  } catch {
    seen = null;
  }
  return { enabled: rows[0]?.value === "true", latest: seen };
}

export async function setUpdatesEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
  // Switched off: forget what was seen, so the bell says nothing.
  if (!enabled) await db.delete(serverSetting).where(eq(serverSetting.key, LATEST_KEY));
}

/** "2026.11.24", "v2026.11.24", "2026.11.24-3-gabc123" → [2026, 11, 24]; null for "dev" and anything else. */
export function versionParts(v: string): [number, number, number] | null {
  const m = /^v?(\d{4})\.(\d{1,2})\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `latest` is a newer release than `current`. A build between releases ("2026.11.24-3-g…") counts as its release. */
export function isNewer(latest: string, current: string) {
  const a = versionParts(latest);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export function updateStatus(deps: Pick<Deps, "releases">, current: string, state: Awaited<ReturnType<typeof updatesState>>): UpdateStatus {
  const available = Boolean(deps.releases);
  const latest = available && state.enabled ? state.latest : null;
  return { available, enabled: available && state.enabled, current, latest, newer: Boolean(latest && isNewer(latest.version, current)) };
}

/** The daily check: the newest release, kept. */
export function updateCheckJob(deps: Pick<Deps, "db" | "releases">): JobHandler {
  return async () => {
    if (!deps.releases || !(await updatesState(deps.db)).enabled) return;
    const latest = await deps.releases.latest();
    if (!latest) return;
    const value = JSON.stringify({ ...latest, checkedAt: new Date().toISOString() } satisfies Latest);
    await deps.db.insert(serverSetting).values({ key: LATEST_KEY, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
  };
}
