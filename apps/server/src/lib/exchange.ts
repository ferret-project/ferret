/**
 * Exchange rates (deps.exchangeRates: the European Central Bank's, via Frankfurter), so prices that come in another
 * currency — UPCitemdb's are US dollars, card marketplaces' dollars or euros — show in the household's, marked as
 * approximate, with the original beside them. Switched on by the server admin (Settings → Server → Exchange rates);
 * fetched once a day for the whole server (EXCHANGE_RATES_JOB). Without rates, such a price shows in its own currency
 * and is never offered as a value in another.
 */
import { type ExchangeRateStatus, type ExchangeRates } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";

export const EXCHANGE_RATES_JOB = "exchange-rates.refresh";
const ON_KEY = "fx.enabled";
const RATES_KEY = "fx.rates";
/** Asked again after this long (the bank publishes once a working day). */
const FRESH_MS = 12 * 60 * 60 * 1000;
/** Rates older than this aren't used (the service has been failing for a week). */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

type Kept = ExchangeRates & { fetchedAt: string };

async function setting(db: Db, key: string) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, key));
  return row?.value ?? null;
}

async function put(db: Db, key: string, value: string) {
  await db.insert(serverSetting).values({ key, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
}

export async function exchangeRatesEnabled(db: Db) {
  return (await setting(db, ON_KEY)) === "true";
}

export async function setExchangeRatesEnabled(db: Db, enabled: boolean) {
  await put(db, ON_KEY, String(enabled));
}

async function kept(db: Db): Promise<Kept | null> {
  const raw = await setting(db, RATES_KEY);
  try {
    return raw ? (JSON.parse(raw) as Kept) : null;
  } catch {
    return null;
  }
}

/** The day's rates when they're switched on and recent enough; null otherwise. */
export async function currentRates(deps: Pick<Deps, "db" | "exchangeRates">): Promise<ExchangeRates | null> {
  if (!deps.exchangeRates || !(await exchangeRatesEnabled(deps.db))) return null;
  const k = await kept(deps.db);
  if (!k || Date.now() - Date.parse(k.fetchedAt) > STALE_MS) return null;
  return { base: k.base, date: k.date, rates: k.rates };
}

export async function exchangeRateStatus(deps: Pick<Deps, "db" | "exchangeRates">): Promise<ExchangeRateStatus> {
  return { available: Boolean(deps.exchangeRates), enabled: await exchangeRatesEnabled(deps.db), date: (await currentRates(deps))?.date ?? null };
}

/** Fetch the day's rates when the kept ones are more than half a day old (daily, and when switched on). */
export function exchangeRatesJob(deps: Pick<Deps, "db" | "exchangeRates">): JobHandler {
  return async () => {
    if (!deps.exchangeRates || !(await exchangeRatesEnabled(deps.db))) return;
    const k = await kept(deps.db);
    if (k && Date.now() - Date.parse(k.fetchedAt) < FRESH_MS) return;
    const rates = await deps.exchangeRates.latest();
    await put(deps.db, RATES_KEY, JSON.stringify({ ...rates, fetchedAt: new Date().toISOString() } satisfies Kept));
  };
}
