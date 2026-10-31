/**
 * A household's time zone (Settings → Household): what "today" is for it — due, overdue, ending soon — and the hour its
 * reminders go out. The server keeps every moment in UTC; only these calendar questions need a zone. Not set: the
 * server's own zone (the TZ environment variable on Node; UTC where there's none).
 */
import { isTimeZone, localParts, today } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { householdSetting } from "../db/schema";
import type { Db } from "../ports";

/** The zone the server's clock reads in. */
export const serverTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The household's chosen zone, or null if it hasn't chosen one. */
export async function chosenTimeZone(db: Db, householdId: string) {
  const [row] = await db.select({ timeZone: householdSetting.timeZone }).from(householdSetting).where(eq(householdSetting.householdId, householdId));
  return row?.timeZone ?? null;
}

/** The zone to read the household's "today" in. */
export async function householdTimeZone(db: Db, householdId: string) {
  return (await chosenTimeZone(db, householdId)) ?? serverTimeZone();
}

/** Sets (or, with null, clears) the household's zone. */
export async function setHouseholdTimeZone(db: Db, householdId: string, timeZone: string | null) {
  if (timeZone && !isTimeZone(timeZone)) throw new HTTPException(422, { message: `${timeZone} isn't a time zone` });
  await db
    .insert(householdSetting)
    .values({ householdId, timeZone })
    .onConflictDoUpdate({ target: householdSetting.householdId, set: { timeZone, updatedAt: new Date() } });
}

/** Today (or `d`'s day) where the caller's household is. */
export const todayFor = (v: { timeZone: string }, d?: Date) => today(d, v.timeZone);

/** Households' zones, each read once (for a job that goes through many households). */
export function zoneCache(db: Db) {
  const zones = new Map<string, Promise<string>>();
  return (householdId: string) => {
    if (!zones.has(householdId)) zones.set(householdId, householdTimeZone(db, householdId));
    return zones.get(householdId)!;
  };
}

/** A household's day, for things sent once a day: null until `fromHour` there (each household its own morning). */
export function dayFrom(db: Db, now: Date, fromHour: number) {
  const zoneOf = zoneCache(db);
  return async (householdId: string) => {
    const timeZone = await zoneOf(householdId);
    return localParts(now, timeZone).hour >= fromHour ? today(now, timeZone) : null;
  };
}
