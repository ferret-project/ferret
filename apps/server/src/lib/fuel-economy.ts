/**
 * Fuel economy (deps.fuelEconomy, fueleconomy.gov — the US EPA's figures): a vehicle whose VIN was decoded (lib/vehicles.ts)
 * gets its miles per gallon on its page, and what a year's fuel costs. Off until the server admin switches it on
 * (Settings → Server → Vehicle look-ups), because the make, model and year are sent to fueleconomy.gov.
 *
 * - NHTSA's names and EPA's don't line up ("F-150" vs "F150 Pickup 4WD"), and one model has several entries (engine,
 *   transmission). So EPA's entries for the make, model and year are offered on the vehicle's page and a person
 *   confirms one (`item.fuelEconomy`) — or says none of them; those whose engine matches the VIN's come first.
 * - Asked in jobs; the entries for a make/model/year are kept for the whole server 90 days, an entry 30 days (the
 *   shared book, collectible_info: "fueleconomy:options:…", "fueleconomy:vehicle:…").
 * - The cost: 15,000 miles a year, 55% city (EPA's own assumptions), at this week's price of its fuel in its state (or
 *   its region, or the US) from the EIA, with the server admin's EIA key (the same as electricity prices) — an electric
 *   car at its state's average home electricity rate. Without the key, or for other fuels, EPA's own estimate at its US
 *   prices. A home outside the US gets the figures but no cost.
 */
import type { FuelEconomyOption, FuelEconomyStatus, FuelEconomyVehicle, ItemFuelEconomy, ItemFuelEconomyStatus } from "@ferret/shared";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { collectibleInfo, item, serverSetting } from "../db/schema";
import type { Db, Deps, FuelGrade, JobHandler } from "../ports";
import { EIA_KEY, FUEL_PRICES_JOB, FUEL_PRICES_KEY, homeElectricityRate, inHouseholdCurrency, stateFor } from "./energy";
import { type Caller, getItem, itemScope, logActivity } from "./inventory";
import { normalise } from "./recalls";
import { savedKeyHints } from "./server-keys";
import { vehicleKey, vehiclesEnabled } from "./vehicles";

export const FUEL_OPTIONS_JOB = "fueleconomy.options";
export const FUEL_VEHICLE_JOB = "fueleconomy.vehicle";
export { FUEL_PRICES_JOB };
const ENABLED_KEY = "fuelEconomy.enabled";
const OPTIONS_FRESH_MS = 90 * 24 * 60 * 60 * 1000;
const VEHICLE_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const PRICES_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** EPA's assumptions for a year's fuel. */
export const MILES_A_YEAR = 15_000;
/** At most this many of EPA's models offered for one of NHTSA's. */
const MAX_MODELS = 6;

const optionsKey = (key: string) => `fueleconomy:options:${key}`;
const vehicleBookKey = (id: string) => `fueleconomy:vehicle:${id}`;

export async function fuelEconomyEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  return row?.value === "true";
}

export async function setFuelEconomyEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

type Prices = { week: string; centsPerGallon: Record<FuelGrade, Record<string, number>> };

export async function fuelEconomyStatus(deps: Pick<Deps, "db" | "fuelEconomy" | "fuelPrices">): Promise<FuelEconomyStatus> {
  const [[vehicles], [prices]] = await Promise.all([
    deps.db.select({ n: count() }).from(item).where(isNotNull(item.fuelEconomy)),
    deps.db.select().from(collectibleInfo).where(eq(collectibleInfo.key, FUEL_PRICES_KEY)),
  ]);
  const confirmed = vehicles?.n ?? 0;
  return {
    available: Boolean(deps.fuelEconomy),
    enabled: await fuelEconomyEnabled(deps.db),
    vehicles: confirmed,
    prices: { available: Boolean(deps.fuelPrices), hint: (await savedKeyHints(deps.db, EIA_KEY)).get(EIA_KEY) ?? null, week: (prices?.info as Prices | undefined)?.week ?? null },
  };
}

// ── Matching NHTSA's model to EPA's ───────────────────────────────────────────────────────────────────────────

const squash = (s: string) => normalise(s).replace(/ /g, "");
const ELECTRIC = /\b(electric|ev|e-tron|plug-in)\b/i;

/**
 * EPA's models that may be NHTSA's: the same name ("Accord"), or EPA's with more after it ("F150 Pickup 4WD" for
 * "F-150", "Accord Wagon"). Electric ones only for an electric vehicle, and the other way round; when the drive is
 * known, models named for another drive are left out (unless that leaves none). The closest names first.
 */
export function pickModels(epa: string[], nhtsa: { model: string; drive?: string | null; engine?: string | null }) {
  const want = squash(nhtsa.model);
  if (!want) return [];
  const electric = /electric/i.test(nhtsa.engine ?? "");
  let found = epa.filter((m) => {
    const flat = squash(m);
    return flat === want || flat.startsWith(want) || (want.length >= 4 && squash(m.split(/\s+/)[0] ?? "") === want);
  });
  if (nhtsa.engine) found = found.filter((m) => ELECTRIC.test(m) === electric || /hybrid/i.test(m));
  const drive = (nhtsa.drive ?? "").toLowerCase();
  const tag = /4wd|4x4|four/.test(drive) ? /\b4wd\b/i : /awd|all/.test(drive) ? /\bawd\b/i : /fwd|front/.test(drive) ? /\b(fwd|2wd)\b/i : /rwd|rear/.test(drive) ? /\b(rwd|2wd)\b/i : null;
  const anyDrive = /\b(2wd|4wd|awd|fwd|rwd)\b/i;
  if (tag) {
    const sameDrive = found.filter((m) => !anyDrive.test(m) || tag.test(m));
    if (sameDrive.length) found = sameDrive;
  }
  return found.sort((a, b) => squash(a).length - squash(b).length).slice(0, MAX_MODELS);
}

/** "3.0 L 6-cylinder, gasoline" → { litres: "3.0", cylinders: "6" } (lib/vehicles.ts describeEngine). */
function engineOf(engine: string | null | undefined) {
  return { litres: /(\d+\.\d) L/.exec(engine ?? "")?.[1] ?? null, cylinders: /(\d+)-cylinder/.exec(engine ?? "")?.[1] ?? null };
}

/** An entry's engine matches the VIN's: its "6 cyl, 3.0 L" says the same (whatever is known of it). */
export function likelyOption(text: string, engine: string | null | undefined) {
  const e = engineOf(engine);
  if (!e.litres && !e.cylinders) return false;
  if (e.cylinders && !new RegExp(`\\b${e.cylinders} cyl\\b`).test(text)) return false;
  if (e.litres && !text.includes(`${e.litres} L`)) return false;
  return true;
}

// ── A vehicle's page ──────────────────────────────────────────────────────────────────────────────────────────

type Thing = Pick<typeof item.$inferSelect, "id" | "vehicle" | "fuelEconomy" | "locationId">;

/** What's asked: the decoded make, model and year (and the drive and engine, to narrow and rank). */
function askedFor(t: Thing) {
  const v = t.vehicle?.status === "found" ? t.vehicle : null;
  const key = v ? vehicleKey(v) : null;
  if (!v || !key) return null;
  return { key, year: v.year!, make: v.make!, model: v.model!, drive: v.drive, engine: v.engine };
}

async function kept<T>(db: Db, key: string, freshMs: number): Promise<{ info: T; fresh: boolean } | null> {
  const [row] = await db.select().from(collectibleInfo).where(eq(collectibleInfo.key, key));
  return row ? { info: row.info as T, fresh: Date.now() - row.fetchedAt.getTime() < freshMs } : null;
}

async function keep(db: Db, key: string, info: unknown) {
  const now = new Date();
  await db.insert(collectibleInfo).values({ key, info, fetchedAt: now }).onConflictDoUpdate({ target: collectibleInfo.key, set: { info, fetchedAt: now } });
}

async function on(v: Pick<Caller, "db" | "deps">) {
  return Boolean(v.deps.fuelEconomy) && (await fuelEconomyEnabled(v.db)) && (await vehiclesEnabled(v.db));
}

/** A vehicle's fuel economy: confirmed, entries to choose from, being looked up, or nothing. */
export async function itemFuelEconomy(v: Caller, itemId: string): Promise<ItemFuelEconomyStatus> {
  const it = await getItem(v, itemId);
  if (!(await on(v))) return { status: "off" };
  const q = askedFor(it);
  if (!q) return { status: "none" };
  const chosen = it.fuelEconomy?.key === q.key ? it.fuelEconomy : null;
  if (chosen && chosen.id === null) return { status: "none" }; // "none of these"
  if (chosen?.id) {
    const entry = await kept<FuelEconomyVehicle | null>(v.db, vehicleBookKey(chosen.id), VEHICLE_FRESH_MS);
    if (!entry?.fresh) await v.deps.jobs?.enqueue(FUEL_VEHICLE_JOB, { id: chosen.id });
    if (!entry?.info) return entry ? { status: "none" } : { status: "pending" };
    return { status: "found", vehicle: { ...entry.info, text: chosen.label ?? entry.info.text }, cost: await yearCost(v, entry.info, it.locationId ?? null) };
  }
  const options = await kept<Omit<FuelEconomyOption, "likely">[]>(v.db, optionsKey(q.key), OPTIONS_FRESH_MS);
  if (!options?.fresh) await v.deps.jobs?.enqueue(FUEL_OPTIONS_JOB, { key: q.key, year: q.year, make: q.make, model: q.model, drive: q.drive, engine: q.engine });
  if (!options) return { status: "pending" };
  if (!options.info.length) return { status: "none" };
  const ranked = options.info.map((o) => ({ ...o, likely: likelyOption(o.text, q.engine) }));
  return { status: "choose", options: [...ranked.filter((o) => o.likely), ...ranked.filter((o) => !o.likely)] };
}

/** "It's this one" (an offered entry's id), or "none of these" (null). */
export async function chooseFuelEconomy(v: Caller, itemId: string, id: string | null) {
  const it = await getItem(v, itemId);
  if (!(await on(v))) throw new HTTPException(409, { message: "Fuel economy look-ups are off" });
  const q = askedFor(it);
  if (!q) throw new HTTPException(422, { message: "This thing has no decoded VIN" });
  let choice: ItemFuelEconomy = { key: q.key, id: null, label: null };
  if (id !== null) {
    const options = await kept<Omit<FuelEconomyOption, "likely">[]>(v.db, optionsKey(q.key), Infinity);
    const picked = options?.info.find((o) => o.id === id);
    if (!picked) throw new HTTPException(422, { message: "That isn't one of the entries for this vehicle" });
    choice = { key: q.key, id, label: `${picked.model} · ${picked.text}` };
    await v.deps.jobs?.enqueue(FUEL_VEHICLE_JOB, { id });
  }
  await v.db.update(item).set({ fuelEconomy: choice, updatedAt: new Date() }).where(and(eq(item.id, it.id), itemScope(v, { gone: "include" })));
  if (choice.id) await logActivity(v, "item.update", it.id, `Fuel economy for ${it.name}: ${choice.label}`);
  return itemFuelEconomy(v, it.id);
}

/** "Not this one": offer the entries again. */
export async function clearFuelEconomy(v: Caller, itemId: string) {
  const it = await getItem(v, itemId);
  await v.db.update(item).set({ fuelEconomy: null, updatedAt: new Date() }).where(and(eq(item.id, it.id), itemScope(v, { gone: "include" })));
  return itemFuelEconomy(v, it.id);
}

// ── What a year's fuel costs ──────────────────────────────────────────────────────────────────────────────────

/**
 * Where the EIA prices a state's fuel: its own price (the nine states it does), else its region (the PADD, the East
 * Coast in three parts, the West Coast without California). Every state is in one.
 */
// not translated (EIA's areas)
const REGION: Record<string, string> = {
  CT: "R1X", ME: "R1X", MA: "R1X", NH: "R1X", RI: "R1X", VT: "R1X",
  DE: "R1Y", DC: "R1Y", MD: "R1Y", NJ: "R1Y", NY: "R1Y", PA: "R1Y",
  FL: "R1Z", GA: "R1Z", NC: "R1Z", SC: "R1Z", VA: "R1Z", WV: "R1Z",
  IL: "R20", IN: "R20", IA: "R20", KS: "R20", KY: "R20", MI: "R20", MN: "R20", MO: "R20", NE: "R20", ND: "R20", SD: "R20", OH: "R20", OK: "R20", TN: "R20", WI: "R20",
  AL: "R30", AR: "R30", LA: "R30", MS: "R30", NM: "R30", TX: "R30",
  CO: "R40", ID: "R40", MT: "R40", UT: "R40", WY: "R40",
  AK: "R5XCA", AZ: "R5XCA", HI: "R5XCA", NV: "R5XCA", OR: "R5XCA", WA: "R5XCA", CA: "R50",
};
const PARENT: Record<string, string> = { R1X: "R10", R1Y: "R10", R1Z: "R10", R5XCA: "R50" };

/** Which of the EIA's grades EPA's fuel is priced at; "electricity" for electric cars; null: EPA's own estimate. */
export function gradeOf(fuel: string): FuelGrade | "electricity" | null {
  const f = fuel.toLowerCase();
  if (f.includes("electric")) return "electricity";
  if (f.includes("diesel")) return "diesel";
  if (f.includes("premium")) return "premium";
  if (f.includes("midgrade")) return "midgrade";
  if (f.includes("regular")) return "regular";
  return null;
}

/** The price of a grade for a state: its own, its region's (or the region's parent), else the US's. */
export function priceFor(prices: Prices, grade: FuelGrade, state: string | null): { cents: number; source: "state" | "region" | "us"; state: string | null } | null {
  const table = prices.centsPerGallon[grade] ?? {};
  if (state && table[state]) return { cents: table[state]!, source: "state", state };
  const region = state ? REGION[state] : undefined;
  for (const r of [region, region && PARENT[region]]) if (r && table[r]) return { cents: table[r]!, source: "region", state };
  return table.US ? { cents: table.US, source: "us", state: null } : null;
}

async function fuelPrices(v: Caller): Promise<Prices | null> {
  if (!v.deps.fuelPrices) return null;
  const k = await kept<Prices>(v.db, FUEL_PRICES_KEY, PRICES_FRESH_MS);
  if (!k?.fresh && (await savedKeyHints(v.db, EIA_KEY)).size && v.deps.jobs) await v.deps.jobs.enqueue(FUEL_PRICES_JOB, {});
  return k?.info ?? null;
}

async function yearCost(v: Caller, veh: FuelEconomyVehicle, locationId: string | null): Promise<ItemFuelEconomyStatus["cost"]> {
  const where = await stateFor(v, locationId);
  if (where.abroad) return null; // US prices say nothing about a home elsewhere
  const grade = gradeOf(veh.fuel);
  const plugIn = /plug-in/i.test(veh.kind ?? "");
  const money = async (usd: number, rest: Omit<NonNullable<ItemFuelEconomyStatus["cost"]>, "cents" | "currency" | "miles">) => {
    const cents = await inHouseholdCurrency(v, Math.round(usd));
    return cents == null ? null : { cents, currency: v.currency, miles: MILES_A_YEAR, ...rest };
  };
  if (!plugIn && grade === "electricity" && veh.kwhPer100Miles) {
    const rate = await homeElectricityRate(v, locationId);
    if (rate) return money((MILES_A_YEAR / 100) * veh.kwhPer100Miles * rate.centsPerKwh, { source: rate.state ? "state" : "us", unitCents: rate.centsPerKwh, unit: "kWh", state: rate.state, asOf: String(rate.year) });
  } else if (!plugIn && grade && grade !== "electricity") {
    const prices = await fuelPrices(v);
    const price = prices ? priceFor(prices, grade, where.state) : null;
    if (prices && price) return money((MILES_A_YEAR / veh.combined) * price.cents, { source: price.source, unitCents: price.cents, unit: "gallon", state: price.state, asOf: prices.week });
  }
  return veh.epaYearCents ? money(veh.epaYearCents, { source: "epa", unitCents: null, unit: null, state: null, asOf: null }) : null;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** EPA's entries for a make, model and year (every model of EPA's that may be NHTSA's), kept even when none. */
export function fuelOptionsJob(deps: Pick<Deps, "db" | "fuelEconomy">): JobHandler {
  return async (payload) => {
    const q = z.object({ key: z.string().max(300), year: z.number().int(), make: z.string().max(100), model: z.string().max(100), drive: z.string().max(100).nullish(), engine: z.string().max(200).nullish() }).parse(payload);
    if (!deps.fuelEconomy || !(await fuelEconomyEnabled(deps.db))) return;
    const had = await kept<unknown>(deps.db, optionsKey(q.key), OPTIONS_FRESH_MS);
    if (had?.fresh) return; // queued twice
    // EPA writes some makes differently ("Mercedes-Benz" either way, but "MINI" vs "Mini"): its own spelling if NHTSA's has none.
    let make = q.make;
    let models = await deps.fuelEconomy.models(q.year, make);
    if (!models.length && make.toUpperCase() !== make) {
      make = make.toUpperCase();
      models = await deps.fuelEconomy.models(q.year, make);
    }
    const options: Omit<FuelEconomyOption, "likely">[] = [];
    for (const model of pickModels(models, q)) {
      for (const o of await deps.fuelEconomy.options(q.year, make, model)) options.push({ id: o.id, model, text: o.text });
    }
    await keep(deps.db, optionsKey(q.key), options.slice(0, 30));
  };
}

/** One of EPA's entries, kept (null when there's no such entry). */
export function fuelVehicleJob(deps: Pick<Deps, "db" | "fuelEconomy">): JobHandler {
  return async (payload) => {
    const { id } = z.object({ id: z.string().regex(/^\d{1,8}$/) }).parse(payload);
    if (!deps.fuelEconomy || !(await fuelEconomyEnabled(deps.db))) return;
    if ((await kept<unknown>(deps.db, vehicleBookKey(id), VEHICLE_FRESH_MS))?.fresh) return;
    const found = await deps.fuelEconomy.vehicle(id);
    await keep(deps.db, vehicleBookKey(id), found ? { ...found, text: "" } : null);
  };
}

/** This week's fuel prices (with the server admin's EIA key). */
export function fuelPricesJob(deps: Pick<Deps, "db" | "fuelPrices">): JobHandler {
  return async () => {
    if (!deps.fuelPrices) return;
    const prices = await deps.fuelPrices.weekly();
    if (prices) await keep(deps.db, FUEL_PRICES_KEY, prices);
  };
}
