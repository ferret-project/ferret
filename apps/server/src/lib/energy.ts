/**
 * ENERGY STAR (deps.energyStar, the US EPA's certified products): a thing with a brand and model number, or a
 * barcode, gets its certified energy use on its page — kWh a year, how it compares with the US standard, a furnace's
 * AFUE — with a link to ENERGY STAR's product finder. Off until the server admin switches it on (Settings → Server),
 * because the brand and model (or barcode) are sent to data.energystar.gov.
 *
 * Asked in a job (a dozen lists, some slow); the answer — matches or none — is kept for the whole server a month
 * (the shared book, collectible_info, under "energystar:"), so a thing's page asks once.
 */
import type { EnergyStarMatch, EnergyStarStatus, ItemEnergy } from "@ferret/shared";
import { count, eq, like } from "drizzle-orm";
import { z } from "zod";
import { collectibleInfo, serverSetting } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import { type Caller, getItem } from "./inventory";

export const ENERGY_JOB = "energystar.lookup";
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

export async function energyStatus(deps: Pick<Deps, "db" | "energyStar">): Promise<EnergyStarStatus> {
  const [kept] = await deps.db.select({ n: count() }).from(collectibleInfo).where(like(collectibleInfo.key, `${PREFIX}%`));
  return { available: Boolean(deps.energyStar), enabled: await energyEnabled(deps.db), kept: kept?.n ?? 0 };
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
    return matches.length ? { status: "found", matches } : { status: "none" };
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
