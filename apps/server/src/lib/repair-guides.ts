/**
 * "Repair guides on iFixit" — a link on a thing's page to iFixit's device page, when the server admin has switched
 * repair guides on (Settings → Server; `server_setting` "repairGuides.enabled" — a thing's brand and model leave the
 * server, nothing else). Only on a sure match: the device's title holds the model (with a digit in it — "DCD771",
 * "iPhone 12") and the brand, or, for a vehicle, its make and model and a year range that includes its year
 * ("2003-2007 Honda Accord"). Asked once per brand + model for every household (`repair_guide`, 30 days), in a job:
 * when a thing's brand or model changes, or its page is opened with no answer yet. Ferret links; it never copies.
 */
import type { RepairGuideStatus } from "@ferret/shared";
import { count, eq, gt, and, isNotNull } from "drizzle-orm";
import { repairGuide, serverSetting, type item } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import type { Caller } from "./inventory";
import { normalise } from "./recalls";

export const REPAIR_GUIDE_JOB = "repair-guides.lookup";
const ENABLED_KEY = "repairGuides.enabled";
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;

export async function repairGuidesEnabled(db: Db) {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, ENABLED_KEY));
  return row?.value === "true";
}

export async function setRepairGuidesEnabled(db: Db, enabled: boolean) {
  await db.insert(serverSetting).values({ key: ENABLED_KEY, value: String(enabled) }).onConflictDoUpdate({ target: serverSetting.key, set: { value: String(enabled) } });
}

/** For Settings → Server. */
export async function repairGuideStatus(deps: Pick<Deps, "db" | "repairGuides">): Promise<RepairGuideStatus> {
  const [[asked], [found]] = await Promise.all([
    deps.db.select({ n: count() }).from(repairGuide),
    deps.db.select({ n: count() }).from(repairGuide).where(isNotNull(repairGuide.url)),
  ]);
  return { available: Boolean(deps.repairGuides), enabled: await repairGuidesEnabled(deps.db), asked: asked?.n ?? 0, found: found?.n ?? 0 };
}

type Thing = Pick<typeof item.$inferSelect, "brand" | "model" | "vehicle">;
const squash = (s: string) => normalise(s).replace(/ /g, "");

/** What's asked and kept for a thing: brand + model (a vehicle: year + make + model), or null when too vague to ask. */
export function guideQuery(thing: Thing): { key: string; query: string; year: number | null } | null {
  const vehicle = thing.vehicle?.status === "found" && thing.vehicle.make && thing.vehicle.model && thing.vehicle.year ? thing.vehicle : null;
  if (vehicle) {
    return { key: `vehicle|${vehicle.year}|${normalise(vehicle.make!)}|${normalise(vehicle.model!)}`, query: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, year: vehicle.year };
  }
  const brand = thing.brand?.trim();
  const model = thing.model?.trim();
  if (!brand || !model) return null;
  // A model with no digit ("Classic", "Pro") would match too much.
  if (!/\d/.test(model) || squash(model).length < 3) return null;
  return { key: `${normalise(brand)}|${squash(model)}`, query: `${brand} ${model}`, year: null };
}

/** The first device that surely is this thing (see the top), or null. */
export function pickGuide(results: { title: string; url: string }[], thing: Thing, year: number | null) {
  for (const r of results) {
    const title = normalise(r.title);
    const flat = title.replace(/ /g, "");
    if (year !== null) {
      const make = normalise(thing.vehicle!.make!);
      const model = normalise(thing.vehicle!.model!);
      const range = /\b(\d{4})(?:\s+(\d{4}))?\b/.exec(title); // "2003 2007 honda accord" once normalised
      const from = range ? Number(range[1]) : null;
      const to = range ? Number(range[2] ?? range[1]) : null;
      if ((` ${title} `.includes(` ${make} `) || flat.includes(make.replace(/ /g, ""))) && ` ${title} `.includes(` ${model} `) && from !== null && to !== null && year >= from && year <= to) return r;
      continue;
    }
    const model = squash(thing.model!);
    const brand = squash(thing.brand!);
    if (flat.includes(model) && (flat.includes(brand) || flat.startsWith(model))) return r;
  }
  return null;
}

async function cached(db: Db, key: string) {
  const [row] = await db.select().from(repairGuide).where(and(eq(repairGuide.key, key), gt(repairGuide.checkedAt, new Date(Date.now() - FRESH_MS))));
  return row ?? null;
}

/** After a thing is saved, or its page opened: ask iFixit about its brand and model if nobody has lately (in a job). */
export async function queueGuideLookup(v: Pick<Caller, "db" | "deps">, thing: Thing) {
  if (!v.deps.repairGuides || !v.deps.jobs) return;
  const q = guideQuery(thing);
  if (!q || (await cached(v.db, q.key)) || !(await repairGuidesEnabled(v.db))) return;
  await v.deps.jobs.enqueue(REPAIR_GUIDE_JOB, { key: q.key, query: q.query, year: q.year, brand: thing.brand, model: thing.model, vehicle: thing.vehicle ?? null });
}

export function repairGuideJob(deps: Deps): JobHandler {
  return async (payload) => {
    const p = payload as { key: string; query: string; year: number | null } & Thing;
    if (!deps.repairGuides || !(await repairGuidesEnabled(deps.db)) || (await cached(deps.db, p.key))) return;
    const found = pickGuide(await deps.repairGuides.searchDevices(p.query), p, p.year);
    const values = { title: found?.title ?? null, url: found?.url ?? null, checkedAt: new Date() };
    await deps.db.insert(repairGuide).values({ key: p.key, ...values }).onConflictDoUpdate({ target: repairGuide.key, set: values });
  };
}

/** For a thing's page: its iFixit device, if one surely matches (and repair guides are on); asks in the background if not known. */
export async function repairGuideFor(v: Caller, thing: Thing) {
  if (!v.deps.repairGuides || !(await repairGuidesEnabled(v.db))) return null;
  const q = guideQuery(thing);
  if (!q) return null;
  const row = await cached(v.db, q.key);
  if (!row) {
    await queueGuideLookup(v, thing);
    return null;
  }
  return row.url && row.title ? { title: row.title, url: row.url } : null;
}
