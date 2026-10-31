/**
 * The demo's parts, switched off one at a time by its server admin (Settings → Server → Demo) without redeploying —
 * to stop a cost or an abuse without closing the whole demo. Kept in `server_setting` ("demo.off": the parts that are
 * off), read through a short per-instance cache so a change reaches every instance within seconds. DEMO_PAUSED (the
 * environment) still rests everything, whatever these say.
 */
import { eq } from "drizzle-orm";
import { serverSetting } from "../db/schema";
import type { Db } from "../ports";

export const DEMO_PARTS = [
  /** Everything: the demo rests (as DEMO_PAUSED). */
  "everything",
  /** New accounts. */
  "signups",
  /** Adding photos and files (storage). */
  "uploads",
  /** The vision model reading photos. */
  "photos",
  /** Search by meaning (embeddings, reranking); words still work. */
  "meaning",
  /** Ask Ferret and the search judge (the chat model). */
  "chat",
  /** Reading documents (PDFs, document photos). */
  "documents",
  /** Every email the demo sends. */
  "email",
] as const;
export type DemoPart = (typeof DEMO_PARTS)[number];

const KEY = "demo.off";
const CACHE_MS = 15_000;
let cached: { at: number; off: Set<DemoPart> } | undefined;

/** The parts switched off now. */
export async function partsOff(db: Db, now = Date.now()): Promise<Set<DemoPart>> {
  if (cached && now - cached.at < CACHE_MS) return cached.off;
  const [row] = await db.select({ value: serverSetting.value }).from(serverSetting).where(eq(serverSetting.key, KEY));
  let off: DemoPart[] = [];
  try {
    off = (JSON.parse(row?.value ?? "[]") as string[]).filter((p): p is DemoPart => (DEMO_PARTS as readonly string[]).includes(p));
  } catch {
    // unreadable: everything on
  }
  cached = { at: now, off: new Set(off) };
  return cached.off;
}

export const isOff = async (db: Db, part: DemoPart) => (await partsOff(db)).has(part);

/** Switches parts off (the rest on). Takes effect here at once, elsewhere within CACHE_MS. */
export async function setPartsOff(db: Db, off: readonly DemoPart[]) {
  const value = JSON.stringify([...new Set(off)].filter((p) => DEMO_PARTS.includes(p)));
  await db.insert(serverSetting).values({ key: KEY, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value, updatedAt: new Date() } });
  cached = undefined;
  return partsOff(db);
}

/** For tests: forget the cache. */
export const forgetPartsOff = () => {
  cached = undefined;
};
