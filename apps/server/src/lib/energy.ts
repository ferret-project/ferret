/**
 * ENERGY STAR (deps.energyStar, the US EPA's certified products): a thing with a brand and model number, or a
 * barcode, gets its certified energy use on its page — kWh a year, how it compares with the US standard, a furnace's
 * AFUE — with a link to ENERGY STAR's product finder. Off until the server admin switches it on (Settings → Server),
 * because the brand and model (or barcode) are sent to data.energystar.gov.
 *
 * Asked in a job (a dozen lists, some slow); the answer — matches or none — is kept for the whole server a month
 * (the shared book, collectible_info, under "energystar:"), so a thing's page asks once.
 *
 * With the server admin's US EIA key (deps.electricity), the kWh are also put in money: at the average home rate of
 * the thing's property's state (its address's region), else the household's only state, else the US average —
 * fetched in a job at most monthly ("eia:residential").
 */
import { convertCents, type EnergyStarMatch, type EnergyStarStatus, type ItemEnergy } from "@ferret/shared";
import { and, count, eq, isNotNull, isNull, like } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { collectibleInfo, location, property, serverSetting } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import { currentRates } from "./exchange";
import { type Caller, getItem } from "./inventory";
import { savedKeyHints, saveServerKey } from "./server-keys";

export const ENERGY_JOB = "energystar.lookup";
export const ELECTRICITY_JOB = "energystar.electricity";
/** Where the server admin's US EIA key is kept (sealed: lib/server-keys.ts). */
export const EIA_KEY = "energy.eia.key";
const PRICES_KEY = "eia:residential";
const PRICES_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const ENABLED_KEY = "energystar.enabled";
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX = "energystar:";

const squash = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function energyEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  return row?.value === "true";
}

export async function setEnergyEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

type Prices = { year: number; centsPerKwh: Record<string, number> };

export async function energyStatus(deps: Pick<Deps, "db" | "energyStar" | "electricity">): Promise<EnergyStarStatus> {
  const [kept] = await deps.db.select({ n: count() }).from(collectibleInfo).where(like(collectibleInfo.key, `${PREFIX}%`));
  const [prices] = await deps.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, PRICES_KEY));
  return {
    available: Boolean(deps.energyStar),
    enabled: await energyEnabled(deps.db),
    kept: kept?.n ?? 0,
    electricity: { available: Boolean(deps.electricity), hint: (await savedKeyHints(deps.db, EIA_KEY)).get(EIA_KEY) ?? null, year: (prices?.info as Prices | undefined)?.year ?? null },
  };
}

/** Save the US EIA key (checked with the EIA first) and fetch its prices; or remove it with null (no more costs). */
export async function setElectricityKey(deps: Pick<Deps, "db" | "energyStar" | "electricity" | "jobs">, filesKey: string, key: string | null) {
  if (!deps.electricity) throw new HTTPException(409, { message: "Electricity prices aren't available on this server" });
  if (key != null) {
    const ok = await deps.electricity.check(key).catch(() => {
      throw new HTTPException(502, { message: "Couldn't reach the EIA to check the key — try again in a while" });
    });
    if (!ok) throw new HTTPException(422, { message: "The EIA didn't accept that key — copy it again from its email" });
  }
  await saveServerKey(deps.db, filesKey, EIA_KEY, key);
  await deps.db.delete(collectibleInfo).where(eq(collectibleInfo.key, PRICES_KEY));
  if (key != null && deps.jobs) await deps.jobs.enqueue(ELECTRICITY_JOB, {});
  return energyStatus(deps);
}

/** Background job: the latest year's average home electricity prices by state. */
export function electricityJob(deps: Pick<Deps, "db" | "electricity">): JobHandler {
  return async () => {
    if (!deps.electricity) return;
    const prices = await deps.electricity.residential();
    if (!prices) return;
    const now = new Date();
    await deps.db.insert(collectibleInfo).values({ key: PRICES_KEY, info: prices, fetchedAt: now }).onConflictDoUpdate({ target: collectibleInfo.key, set: { info: prices, fetchedAt: now } });
  };
}

// not translated (state names as addresses write them)
const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC", florida: "FL",
  georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** A US state's two letters from an address's region ("Colorado", "CO", "co."); null for anything else. */
export function stateCode(region: string | null | undefined, country: string | null | undefined) {
  if (country && !/^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(country.trim())) return null;
  const r = (region ?? "").trim().replace(/\.$/, "");
  if (!r) return null;
  if (/^[A-Za-z]{2}$/.test(r) && Object.values(STATES).includes(r.toUpperCase())) return r.toUpperCase();
  return STATES[r.toLowerCase()] ?? null;
}

/** Which state a thing's electricity is priced at: its property's, else the household's only one; null: the US average. */
async function stateFor(v: Caller, locationId: string | null): Promise<{ state: string | null; abroad: boolean }> {
  if (locationId) {
    const [p] = await v.db
      .select({ region: property.region, country: property.country })
      .from(location)
      .innerJoin(property, eq(property.id, location.propertyId))
      .where(and(eq(location.id, locationId), eq(location.householdId, v.householdId)));
    if (p?.region || p?.country) {
      const state = stateCode(p.region, p.country);
      return { state, abroad: !state && Boolean(p.country) && !stateCode("CO", p.country) };
    }
  }
  const all = await v.db
    .select({ region: property.region, country: property.country })
    .from(property)
    .where(and(eq(property.householdId, v.householdId), isNull(property.deletedAt), isNotNull(property.region)));
  const states = [...new Set(all.map((p) => stateCode(p.region, p.country)).filter(Boolean))];
  return { state: states.length === 1 ? states[0]! : null, abroad: false };
}

/** What a year at this many kWh costs at the average home rate, in the household's currency. Null without prices. */
async function costOf(v: Caller, kwh: number, locationId: string | null): Promise<ItemEnergy["cost"]> {
  if (!v.deps.electricity) return null;
  const [kept] = await v.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, PRICES_KEY));
  if (!kept || Date.now() - kept.fetchedAt.getTime() >= PRICES_FRESH_MS) {
    if ((await savedKeyHints(v.db, EIA_KEY)).size && v.deps.jobs) await v.deps.jobs.enqueue(ELECTRICITY_JOB, {});
  }
  const prices = kept?.info as Prices | undefined;
  if (!prices) return null;
  const where = await stateFor(v, locationId);
  if (where.abroad) return null; // US prices say nothing about a home elsewhere
  const rate = (where.state && prices.centsPerKwh[where.state]) || prices.centsPerKwh.US;
  if (!rate) return null;
  const usd = Math.round(kwh * rate);
  const cents = v.currency === "USD" ? usd : convertCents(usd, "USD", v.currency, await currentRates(v.deps));
  if (cents == null) return null;
  return { cents, currency: v.currency, centsPerKwh: rate, state: where.state && prices.centsPerKwh[where.state] ? where.state : null, year: prices.year };
}

/** What a thing is asked by: its brand and model (both needed), and its barcode. Null when there's not enough. */
export function askedBy(it: { brand?: string | null; model?: string | null; barcode?: string | null }) {
  const brand = it.brand?.trim() ?? "";
  const model = squash(it.model).length >= 4 ? (it.model ?? "").trim() : "";
  const barcode = (it.barcode ?? "").replace(/\D/g, "");
  if (!(brand && model) && barcode.length < 8) return null;
  return { brand: model ? brand : "", model, barcode: barcode.length >= 8 ? barcode : "" };
}

const bookKey = (q: NonNullable<ReturnType<typeof askedBy>>) => `${PREFIX}${squash(q.brand)}|${squash(q.model)}|${q.barcode}`;

/** A thing's ENERGY STAR entry: kept, or asked for in the background (`pending` — ask again). */
export async function itemEnergy(v: Caller, itemId: string): Promise<ItemEnergy> {
  const it = await getItem(v, itemId);
  if (!v.deps.energyStar || !(await energyEnabled(v.db))) return { status: "off" };
  const q = askedBy(it);
  if (!q) return { status: "none" };
  const [kept] = await v.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, bookKey(q)));
  if (kept && Date.now() - kept.fetchedAt.getTime() < FRESH_MS) {
    const matches = kept.info as EnergyStarMatch[];
    if (!matches.length) return { status: "none" };
    const kwh = matches[0]!.kwhPerYear;
    return { status: "found", matches, cost: kwh ? await costOf(v, kwh, it.locationId ?? null) : null };
  }
  if (!v.deps.jobs) return { status: "none" };
  await v.deps.jobs.enqueue(ENERGY_JOB, q);
  // Last month's answer while a new one is fetched.
  const old = (kept?.info ?? []) as EnergyStarMatch[];
  return old.length ? { status: "found", matches: old } : { status: "pending" };
}

/** Background job: ask ENERGY STAR about a brand and model (the barcode first, when there is one); keep the answer, even none. */
export function energyJob(deps: Pick<Deps, "db" | "energyStar">): JobHandler {
  return async (payload) => {
    const q = z.object({ brand: z.string().max(200), model: z.string().max(200), barcode: z.string().max(20) }).parse(payload);
    if (!deps.energyStar || !(await energyEnabled(deps.db))) return;
    const [kept] = await deps.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, bookKey(q)));
    if (kept && Date.now() - kept.fetchedAt.getTime() < FRESH_MS) return; // queued twice
    let matches = q.barcode ? await deps.energyStar.forBarcode(q.barcode) : [];
    if (!matches.length && q.brand && q.model) matches = await deps.energyStar.forModel(q.brand, q.model);
    const now = new Date();
    await deps.db
      .insert(collectibleInfo)
      .values({ key: bookKey(q), info: matches.slice(0, 5), fetchedAt: now })
      .onConflictDoUpdate({ target: collectibleInfo.key, set: { info: matches.slice(0, 5), fetchedAt: now } });
  };
}
