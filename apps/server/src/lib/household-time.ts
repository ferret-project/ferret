import { t as translateText, locale } from "./i18n";
/**
 * A household's time zone (Settings → Household): what "today" is for it — due, overdue, ending soon — and the hour its
 * reminders go out. The server keeps every moment in UTC; only these calendar questions need a zone. Not set: the
 * server's own zone (the TZ environment variable on Node; UTC where there's none).
 */
import { DEFAULT_CURRENCY, formatMoney, isCurrency, isTimeZone, localParts, type MoneyOptions, today } from "@ferret/shared";
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
  if (timeZone && !isTimeZone(timeZone)) throw new HTTPException(422, { message: translateText("{v0} isn't a time zone", { v0: timeZone }) });
  await db
    .insert(householdSetting)
    .values({ householdId, timeZone })
    .onConflictDoUpdate({ target: householdSetting.householdId, set: { timeZone, updatedAt: new Date() } });
}

/** The household's currency (Settings → Household): US dollars until it chooses one. */
export async function householdCurrency(db: Db, householdId: string) {
  const [row] = await db.select({ currency: householdSetting.currency }).from(householdSetting).where(eq(householdSetting.householdId, householdId));
  return row?.currency ?? DEFAULT_CURRENCY;
}

/** Sets the household's currency. */
export async function setHouseholdCurrency(db: Db, householdId: string, currency: string) {
  if (!isCurrency(currency)) throw new HTTPException(422, { message: translateText("{v0} isn't a currency", { v0: currency }) });
  await db
    .insert(householdSetting)
    .values({ householdId, currency })
    .onConflictDoUpdate({ target: householdSetting.householdId, set: { currency, updatedAt: new Date() } });
}

/** Where a household is, for a Caller made outside a request (jobs, share links, feeds): its zone and its currency. */
export async function householdLocale(db: Db, householdId: string) {
  const [row] = await db
    .select({ timeZone: householdSetting.timeZone, currency: householdSetting.currency })
    .from(householdSetting)
    .where(eq(householdSetting.householdId, householdId));
  return { timeZone: row?.timeZone ?? serverTimeZone(), currency: row?.currency ?? DEFAULT_CURRENCY };
}

/**
 * An amount in what the server writes (history, the bell, emails): the household's currency, written the English way
 * like the words around it ("value €80.00 → €95.00").
 */
export const moneyText = (v: { currency: string }, cents: number, opts: Omit<MoneyOptions, "locale"> = {}) => formatMoney(cents, v.currency, { ...opts, locale: locale() });

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

/** What a clock in `timeZone` reads at `at`, as if it were UTC (to find the zone's offset then). */
function wallClock(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** The moment a day (yyyy-mm-dd) starts in a time zone: "since 2025-11-08" in Denver is 07:00 UTC that day. */
export function startOfDayIn(day: string, timeZone: string) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const midnightUtc = Date.UTC(y, m - 1, d);
  let at = midnightUtc - (wallClock(midnightUtc, timeZone) - midnightUtc);
  // Across a daylight-saving change the offset at the answer can differ from the first guess's: once more.
  at = midnightUtc - (wallClock(at, timeZone) - at);
  return new Date(at);
}
