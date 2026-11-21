/**
 * Bike Index (deps.stolenBikes): a bike's page says whether a bike with its serial number is reported stolen there —
 * worth knowing about one bought second-hand — and links to register it, or, once it's marked stolen in Ferret, to
 * report it. Off until the server admin switches it on (Settings → Server), because the serial is sent. Asked in a
 * job; the answer is kept for the whole server a day (collectible_info, "bikeindex:").
 */
import type { BikeIndexStatus, ItemBikeIndex, StolenBikeReport } from "@ferret/shared";
import { and, count, eq, like } from "drizzle-orm";
import { z } from "zod";
import { category, collectibleInfo, serverSetting } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import { type Caller, getItem } from "./inventory";

export const BIKE_JOB = "bikeindex.check";
const ENABLED_KEY = "bikeindex.enabled";
const FRESH_MS = 24 * 60 * 60 * 1000;
const PREFIX = "bikeindex:";

const serialKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
/** A bike by what it's called or filed under: "Road bike", "E-bike", "Bicycles", "Kids' bicycle". */
export const BIKE_WORDS = /\b(bikes?|bicycles?|e-?bikes?|cycles?|tandems?|tricycles?|trikes?|bmx)\b/i;

export async function bikeIndexEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  return row?.value === "true";
}

export async function setBikeIndexEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

export async function bikeIndexStatus(deps: Pick<Deps, "db" | "stolenBikes">): Promise<BikeIndexStatus> {
  const [kept] = await deps.db.select({ n: count() }).from(collectibleInfo).where(like(collectibleInfo.key, `${PREFIX}%`));
  return { available: Boolean(deps.stolenBikes), enabled: await bikeIndexEnabled(deps.db), checked: kept?.n ?? 0 };
}

/** A thing's Bike Index card: whether it's a bike at all, and what Bike Index says about its serial. */
export async function itemBikeIndex(v: Caller, itemId: string): Promise<ItemBikeIndex> {
  const it = await getItem(v, itemId);
  if (!v.deps.stolenBikes || !(await bikeIndexEnabled(v.db))) return { status: "off" };
  const [cat] = it.categoryId ? await v.db.select({ name: category.name }).from(category).where(and(eq(category.id, it.categoryId), eq(category.householdId, v.householdId))) : [];
  if (!BIKE_WORDS.test(`${it.name} ${cat?.name ?? ""}`)) return { status: "off" };
  const serial = serialKey(it.serialNumber);
  if (serial.length < 5) return { status: "none" };
  const [kept] = await v.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, `${PREFIX}${serial}`));
  if (kept && Date.now() - kept.fetchedAt.getTime() < FRESH_MS) {
    const reports = kept.info as StolenBikeReport[];
    return reports.length ? { status: "stolen", reports } : { status: "clear" };
  }
  if (!v.deps.jobs) return { status: "none" };
  await v.deps.jobs.enqueue(BIKE_JOB, { serial: it.serialNumber });
  return { status: "pending" };
}

/** Background job: ask Bike Index about a serial; keep the answer (none too) a day. */
export function bikeJob(deps: Pick<Deps, "db" | "stolenBikes">): JobHandler {
  return async (payload) => {
    const { serial } = z.object({ serial: z.string().max(100) }).parse(payload);
    if (!deps.stolenBikes || !(await bikeIndexEnabled(deps.db))) return;
    const key = `${PREFIX}${serialKey(serial)}`;
    const [kept] = await deps.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, key));
    if (kept && Date.now() - kept.fetchedAt.getTime() < FRESH_MS) return;
    const reports = await deps.stolenBikes.stolenWithSerial(serial);
    const now = new Date();
    await deps.db.insert(collectibleInfo).values({ key, info: reports, fetchedAt: now }).onConflictDoUpdate({ target: collectibleInfo.key, set: { info: reports, fetchedAt: now } });
  };
}
