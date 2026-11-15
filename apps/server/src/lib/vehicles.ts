/**
 * Vehicles, from NHTSA's public data (`deps.vehicles`, adapters/local/nhtsa.ts), when the server admin has switched
 * vehicle look-ups on (Settings → Server; `server_setting` "vehicles.enabled" — a VIN, and a make/model/year, leave
 * the server). Two things:
 *
 * — **The VIN decoded.** A thing's VIN is its Vehicles category's VIN field, or a serial number that is unmistakably a
 *   VIN (`vinOf`, shared). When it's set or changes, a job asks vPIC and keeps the answer on the item (`item.vehicle`);
 *   its page offers make, model and a name ("2003 Honda Accord EX-V6") to apply with a tap — nothing changes by itself.
 * — **Vehicle recalls.** The CPSC doesn't cover vehicles: each decoded make + model + year is asked about (a week fresh,
 *   `recall_brand` with a "vehicle:" key), its campaigns kept in `recall` ("nhtsa:<campaign>"), and every vehicle of
 *   that make, model and year matched — a sure match (urgent in the bell), like a barcode or model match.
 */
import type { VehicleInfo, VehicleLookupStatus } from "@ferret/shared";
import { vinOf } from "@ferret/shared/utils";
import { and, count, eq, gt, isNotNull, isNull, like, notLike, or } from "drizzle-orm";
import { item, itemRecall, recall, recallBrand, serverSetting } from "../db/schema";
import type { Db, Deps, JobHandler, RawVehicleRecall, RawVinDecode } from "../ports";
import { type Caller, logActivity } from "./inventory";
import { normalise } from "./recalls";

export const VIN_JOB = "vehicles.vin";
const ENABLED_KEY = "vehicles.enabled";
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many make/model/years asked about per check (the rest next time). */
const VEHICLES_PER_CHECK = 50;
export const NHTSA_PREFIX = "nhtsa:";

export async function vehiclesEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  return row?.value === "true";
}

export async function setVehiclesEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

/** For Settings → Server. */
export async function vehicleStatus(deps: Pick<Deps, "db" | "vehicles">): Promise<VehicleLookupStatus> {
  const [[vehicles], [kept]] = await Promise.all([
    deps.db.select({ n: count() }).from(item).where(and(isNotNull(item.vehicle), isNull(item.deletedAt))),
    deps.db.select({ n: count() }).from(recall).where(like(recall.id, `${NHTSA_PREFIX}%`)),
  ]);
  return { available: Boolean(deps.vehicles), enabled: await vehiclesEnabled(deps.db), vehicles: vehicles?.n ?? 0, recalls: kept?.n ?? 0 };
}

/** "3.0 L 6-cylinder, gasoline" — as much as NHTSA said. */
export function describeEngine(r: Pick<RawVinDecode, "displacementL" | "cylinders" | "fuel">) {
  const size = [r.displacementL ? `${r.displacementL.toFixed(1)} L` : null, r.cylinders ? `${r.cylinders}-cylinder` : null].filter(Boolean).join(" ");
  return [size, r.fuel?.toLowerCase()].filter(Boolean).join(", ") || null;
}

/** NHTSA writes makes in capitals: "HONDA" → "Honda", "MERCEDES-BENZ" → "Mercedes-Benz"; short ones ("BMW", "GMC") stay. */
export function makeName(make: string) {
  if (make.length <= 3) return make.toUpperCase();
  return make.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

const empty = (vin: string, status: VehicleInfo["status"]): VehicleInfo => ({ vin, status, make: null, model: null, year: null, trim: null, body: null, engine: null, drive: null, decodedAt: null });

/**
 * After an item is saved: if its VIN is new or changed (or gone), look it up again (or forget the old answer). Only
 * with vehicle look-ups switched on; the answer comes from a job.
 */
export async function queueVinLookup(v: Pick<Caller, "db" | "deps">, row: Pick<typeof item.$inferSelect, "id" | "customFields" | "serialNumber" | "vehicle">) {
  const vin = vinOf(row);
  if (vin === (row.vehicle?.vin ?? null)) return;
  if (!vin) {
    await v.db.update(item).set({ vehicle: null }).where(eq(item.id, row.id));
    return;
  }
  if (!v.deps.vehicles || !v.deps.jobs || !(await vehiclesEnabled(v.db))) return;
  await v.db.update(item).set({ vehicle: empty(vin, "pending") }).where(eq(item.id, row.id));
  await v.deps.jobs.enqueue(VIN_JOB, { itemId: row.id });
}

/** The job: decode the item's VIN, keep the answer, then check the household for recalls on it. */
export function vinLookupJob(deps: Deps): JobHandler {
  return async (payload) => {
    const { itemId } = payload as { itemId: string };
    if (!deps.vehicles || !(await vehiclesEnabled(deps.db))) return;
    const [row] = await deps.db
      .select({ id: item.id, householdId: item.householdId, customFields: item.customFields, serialNumber: item.serialNumber })
      .from(item)
      .where(and(eq(item.id, itemId), isNull(item.deletedAt)));
    const vin = row ? vinOf(row) : null;
    if (!row || !vin) return;
    const decoded = await deps.vehicles.decodeVin(vin);
    // The VIN may have changed while it was being looked up: that change queued its own look-up.
    const [now] = await deps.db.select({ customFields: item.customFields, serialNumber: item.serialNumber }).from(item).where(eq(item.id, itemId));
    if (!now || vinOf(now) !== vin) return;
    const info: VehicleInfo = decoded
      ? {
          vin,
          status: "found",
          make: decoded.make ? makeName(decoded.make) : null,
          model: decoded.model,
          year: decoded.year,
          trim: decoded.trim,
          body: decoded.body,
          engine: describeEngine(decoded),
          drive: decoded.drive,
          decodedAt: new Date().toISOString(),
        }
      : { ...empty(vin, "unknown"), decodedAt: new Date().toISOString() };
    await deps.db.update(item).set({ vehicle: info }).where(eq(item.id, itemId));
    if (decoded && deps.jobs) await deps.jobs.enqueue("recalls.check", { householdId: row.householdId });
  };
}

/** The key a make, model and year is asked about and matched by: "vehicle:2003|honda|accord". */
export function vehicleKey(v: Pick<VehicleInfo, "make" | "model" | "year">) {
  if (!v.make || !v.model || !v.year) return null;
  return `vehicle:${v.year}|${normalise(v.make)}|${normalise(v.model)}`;
}

/** "AIR BAGS:FRONTAL:DRIVER SIDE" → "Air bags: frontal, driver side". */
export function componentName(component: string | null) {
  if (!component) return "Vehicle recall";
  const [first = "", ...rest] = component.toLowerCase().split(":").map((p) => p.trim()).filter(Boolean);
  return first.charAt(0).toUpperCase() + first.slice(1) + (rest.length ? `: ${rest.join(", ")}` : "");
}

/**
 * Older NHTSA notices are written in capitals: those become sentence case (shouting in a red card is no help), keeping
 * NHTSA, Honda-style names lower but each sentence's first letter up. Mixed-case text is left as it is.
 */
export function calm(text: string | null) {
  if (!text) return null;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (!letters || letters.replace(/[^A-Z]/g, "").length / letters.length < 0.8) return text;
  return text
    .toLowerCase()
    .replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, before: string, c: string) => before + c.toUpperCase())
    .replace(/\b(nhtsa|vin|abs|srs|us|usa)\b/g, (w) => w.toUpperCase())
    .replace(/\bi\b/g, "I");
}

function recallRow(r: RawVehicleRecall, key: string, label: string): typeof recall.$inferInsert {
  const title = `${componentName(r.component)} (NHTSA ${r.campaign})`;
  return {
    id: `${NHTSA_PREFIX}${r.campaign}`,
    number: r.campaign,
    recalledOn: r.reportedOn,
    title,
    url: `https://www.nhtsa.gov/recalls?nhtsaId=${encodeURIComponent(r.campaign)}`,
    description: calm(r.summary)?.slice(0, 4000) ?? null,
    hazard: calm(r.consequence)?.slice(0, 2000) ?? null,
    remedy: calm(r.remedy)?.slice(0, 2000) ?? null,
    contact: calm(r.notes)?.slice(0, 1000) ?? null,
    // The vehicles it was found for: `model` holds the key each is matched by.
    products: [{ name: label, model: key }],
    companies: r.manufacturer ? [r.manufacturer] : [],
    upcs: [],
    imageUrl: null,
    searchText: normalise([title, r.summary ?? "", label, r.manufacturer ?? ""].join(" ")),
  };
}

/** One household's vehicles against NHTSA's recalls: asks about stale make/model/years, adds new matches. Returns how many. */
export async function checkVehicles(v: Caller) {
  if (!v.deps.vehicles || !(await vehiclesEnabled(v.db))) return 0;
  const vehicles = (
    await v.db
      .select({ id: item.id, name: item.name, vehicle: item.vehicle })
      .from(item)
      .where(and(eq(item.householdId, v.householdId), isNull(item.deletedAt), isNull(item.disposition), isNotNull(item.vehicle)))
  ).flatMap((t) => {
    const key = t.vehicle?.status === "found" ? vehicleKey(t.vehicle) : null;
    return key ? [{ ...t, key, vehicle: t.vehicle! }] : [];
  });
  if (!vehicles.length) return 0;

  const now = Date.now();
  const fresh = new Set(
    (await v.db.select({ brand: recallBrand.brand }).from(recallBrand).where(and(like(recallBrand.brand, "vehicle:%"), gt(recallBrand.checkedAt, new Date(now - FRESH_MS))))).map((r) => r.brand),
  );
  const stale = [...new Map(vehicles.filter((t) => !fresh.has(t.key)).map((t) => [t.key, t.vehicle])).entries()].slice(0, VEHICLES_PER_CHECK);
  for (const [key, info] of stale) {
    const found = await v.deps.vehicles.recalls(info.make!, info.model!, info.year!);
    const label = `${info.year} ${info.make} ${info.model}`;
    for (const r of found) {
      const row = recallRow(r, key, label);
      const [had] = await v.db.select({ products: recall.products }).from(recall).where(eq(recall.id, row.id));
      // One campaign can cover several vehicles: keep every key it was found for.
      const products = [...(had?.products ?? []).filter((p) => p.model !== key), ...row.products];
      await v.db.insert(recall).values({ ...row, products }).onConflictDoUpdate({ target: recall.id, set: { ...row, products } });
    }
    const values = { checkedAt: new Date(now), found: found.length };
    await v.db.insert(recallBrand).values({ brand: key, ...values }).onConflictDoUpdate({ target: recallBrand.brand, set: values });
  }

  const campaigns = await v.db.select({ id: recall.id, title: recall.title, products: recall.products }).from(recall).where(like(recall.id, `${NHTSA_PREFIX}%`));
  const byKey = new Map<string, { id: string; title: string }[]>();
  for (const c of campaigns) for (const p of c.products) byKey.set(p.model, [...(byKey.get(p.model) ?? []), c]);
  const known = new Set(
    (await v.db.select({ itemId: itemRecall.itemId, recallId: itemRecall.recallId }).from(itemRecall).where(eq(itemRecall.householdId, v.householdId))).map(
      (r) => `${r.itemId}:${r.recallId}`,
    ),
  );
  let added = 0;
  for (const t of vehicles) {
    for (const c of byKey.get(t.key) ?? []) {
      if (known.has(`${t.id}:${c.id}`)) continue;
      await v.db.insert(itemRecall).values({ householdId: v.householdId, itemId: t.id, recallId: c.id, match: "model" }).onConflictDoNothing();
      known.add(`${t.id}:${c.id}`);
      added++;
      await logActivity(v, "recall.found", c.id, `Recall for ${t.name}: ${c.title}`, t.id);
    }
  }
  return added;
}

/** The CPSC matching leaves NHTSA's campaigns alone (they're matched by vehicle above). */
export const notVehicleRecall = notLike(recall.id, `${NHTSA_PREFIX}%`);

export const VIN_BACKFILL_JOB = "vehicles.backfill";

/** When vehicle look-ups are switched on: look up every VIN already in Ferret (in any household) that has no answer yet. */
export function vinBackfillJob(deps: Deps): JobHandler {
  return async () => {
    if (!deps.vehicles || !deps.jobs || !(await vehiclesEnabled(deps.db))) return;
    const rows = await deps.db
      .select({ id: item.id, customFields: item.customFields, serialNumber: item.serialNumber, vehicle: item.vehicle })
      .from(item)
      .where(and(isNull(item.deletedAt), isNull(item.vehicle), or(isNotNull(item.customFields), isNotNull(item.serialNumber))));
    for (const row of rows) if (vinOf(row)) await queueVinLookup({ db: deps.db, deps }, row);
  };
}
