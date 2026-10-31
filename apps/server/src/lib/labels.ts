/**
 * QR labels: a short code that opens a box, an item or a place. Codes use
 * Crockford's base32 alphabet (no I, L, O or U — nothing to misread on a box
 * in a dim garage), six characters: about a billion codes, unique across
 * every household. Labels can be printed blank and claimed when stuck on.
 */
import type { Label, LabelTarget } from "@ferret/shared";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, label, location } from "../db/schema";
import { membership } from "./context";
import { type Caller, itemChanged, itemScope, locationIn, locationPaths, logActivity, notFound } from "./inventory";
import { householdTimeZone } from "./household-time";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => ALPHABET[b % 32]).join("");
}

/** As typed or scanned: upper-cased, with the look-alikes Crockford folds (O→0, I/L→1). */
export function normalizeCode(raw: string) {
  return raw.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1").replace(/[^0-9A-Z]/g, "");
}

async function insertLabel(v: Caller, target: { itemId?: string; locationId?: string } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await v.db
      .insert(label)
      .values({ householdId: v.householdId, code: randomCode(), itemId: target.itemId ?? null, locationId: target.locationId ?? null })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
  }
  throw new Error("Couldn't make a unique label code");
}

/** Blank labels to print ahead (e.g. a sheet before packing). */
export async function createBlankLabels(v: Caller, count: number) {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) codes.push((await insertLabel(v)).code);
  await logActivity(v, "label.create", v.householdId, `Made ${count} blank ${count === 1 ? "label" : "labels"}`);
  return codes;
}

async function checkTarget(v: Caller, target: LabelTarget) {
  if (target.itemId) {
    const [found] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, target.itemId), itemScope(v)));
    if (!found) throw notFound("Item");
  } else {
    const [found] = await v.db.select({ id: location.id }).from(location).where(locationIn(v, target.locationId!));
    if (!found) throw notFound("Location");
  }
}

const targetWhere = (v: Caller, target: LabelTarget) =>
  and(eq(label.householdId, v.householdId), target.itemId ? eq(label.itemId, target.itemId) : eq(label.locationId, target.locationId!));

/** The label for a box, item or place — its existing one, or a new one. */
export async function labelFor(v: Caller, target: LabelTarget) {
  await checkTarget(v, target);
  const [existing] = await v.db.select().from(label).where(targetWhere(v, target));
  const row = existing ?? (await insertLabel(v, target));
  if (!existing && target.itemId) await itemChanged(v, target.itemId); // its code is searchable
  return describe(v, row);
}

/** Stick a blank label on something: scan it, "this is the garage shelf". */
export async function assignLabel(v: Caller, code: string, target: LabelTarget) {
  await checkTarget(v, target);
  const [row] = await v.db.select().from(label).where(and(eq(label.code, normalizeCode(code)), eq(label.householdId, v.householdId)));
  if (!row) throw notFound("Label");
  if (row.itemId || row.locationId) throw new HTTPException(409, { message: `Label ${row.code} is already on something` });
  const [already] = await v.db.select({ code: label.code }).from(label).where(targetWhere(v, target));
  if (already) throw new HTTPException(409, { message: `That already has label ${already.code}` });
  const [updated] = await v.db
    .update(label)
    .set({ itemId: target.itemId ?? null, locationId: target.locationId ?? null })
    .where(eq(label.id, row.id))
    .returning();
  if (target.itemId) await itemChanged(v, target.itemId);
  return describe(v, updated!);
}

/** Take a label off (it becomes blank again, to reuse). */
export async function clearLabel(v: Caller, code: string) {
  const [row] = await v.db
    .update(label)
    .set({ itemId: null, locationId: null })
    .where(and(eq(label.code, normalizeCode(code)), eq(label.householdId, v.householdId)))
    .returning();
  if (!row) throw notFound("Label");
}

export async function listLabels(v: Caller, opts: { blank?: boolean } = {}) {
  const where = [eq(label.householdId, v.householdId)];
  if (opts.blank) where.push(isNull(label.itemId), isNull(label.locationId));
  const rows = await v.db.select().from(label).where(and(...where)).orderBy(label.createdAt);
  return Promise.all(rows.map((r) => describe(v, r)));
}

async function describe(v: Caller, row: typeof label.$inferSelect): Promise<Label> {
  const [it] = row.itemId
    ? await v.db.select({ id: item.id, name: item.name, isContainer: item.isContainer }).from(item).where(and(eq(item.id, row.itemId), itemScope(v, { gone: "include" })))
    : [];
  const path = row.locationId ? (await locationPaths(v)).get(row.locationId) : undefined;
  return {
    code: row.code,
    householdId: row.householdId,
    item: it ?? null,
    location: row.locationId && path ? { id: row.locationId, path } : null,
  };
}

/**
 * What a scanned code opens, for someone signed in — in whichever of their
 * households it belongs to (the app switches to it). Not theirs: not found.
 */
export async function resolveLabel(v: Omit<Caller, "householdId" | "timeZone">, code: string) {
  const [row] = await v.db.select().from(label).where(eq(label.code, normalizeCode(code)));
  if (!row || !(await membership(v.db, row.householdId, v.userId))) throw notFound("Label");
  return describe({ ...v, householdId: row.householdId, timeZone: await householdTimeZone(v.db, row.householdId) }, row);
}
