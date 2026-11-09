import { t as translateText } from "./i18n";
import { translate, languages } from "@ferret/shared/i18n";
/**
 * "Let AI fill in" (Settings → Household, per kind; a self-hosted server's admin can make kinds the default for its
 * households — Settings → Server). Off unless switched on. When on, the analysis job writes what the model read
 * straight into the item — but only into **empty** fields a person hasn't cleared since the file was added, and only
 * what the model said it read plainly (`suggestions.sure`). Everything else stays a suggestion, as before.
 *
 * Each fill is written through `updateItem` (so it's in the history: "Filled in by AI from receipt.pdf: brand DeWalt"),
 * kept in `item.aiFilled` (the field's small AI mark) until a person confirms or edits it, and can be undone.
 * Never by itself: merging, values or replacement costs, renaming something a person named, gone/sold, maintenance
 * schedules (those go to Suggested maintenance), anything sent outside Ferret.
 */
import {
  type AiFill,
  type AiFillEntry,
  type AiFillKind,
  type AiFillSwitches,
  type AttachmentAnalysis,
  type ItemPatch,
  addDays,
  addMonths,
  aiFillKinds,
  today,
} from "@ferret/shared";
import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { activity, attachment, householdSetting, item, serverSetting, warranty } from "../db/schema";
import type { Db, Deps } from "../ports";
import { householdLocale, moneyText } from "./household-time";
import { type Caller, getItem, itemScope, notFound, updateItem } from "./inventory";
import { createWarranty, deleteWarranty } from "./warranties";

const DEFAULTS_KEY = "ai.fill.defaults";
const PLACEHOLDER = "New item";

/** Fields "details" may fill, with the words the history uses for them (describeChanges) and the model's own name. */
const DETAIL_FIELDS = [
  { field: "brand", get label() { return translateText("Brand"); }, history: "brand", sure: "brand" },
  { field: "model", get label() { return translateText("Model"); }, history: "model", sure: "model" },
  { field: "serialNumber", get label() { return translateText("Serial number"); }, history: "serial number", sure: "serialNumber" },
  { field: "barcode", get label() { return translateText("Barcode"); }, history: "barcode", sure: "barcode" },
  { field: "purchaseDate", get label() { return translateText("Purchase date"); }, history: "bought on", sure: "purchaseDate" },
  { field: "purchasePriceCents", get label() { return translateText("Price paid"); }, history: "price paid", sure: "purchasePrice" },
] as const;

export const AI_FIELD_LABELS = (): Record<string, string> => ({
  get name() { return translateText("Name"); },
  ...Object.fromEntries(DETAIL_FIELDS.map((f) => [f.field, f.label])),
  get returnBy() { return translateText("Return by"); },
  get warranty() { return translateText("Warranty"); },
});

const off = (): Record<AiFillKind, boolean> => Object.fromEntries(aiFillKinds.map((k) => [k, false])) as Record<AiFillKind, boolean>;
const clean = (raw: unknown): AiFillSwitches => {
  const out: AiFillSwitches = {};
  if (raw && typeof raw === "object") for (const k of aiFillKinds) if (typeof (raw as AiFillSwitches)[k] === "boolean") out[k] = (raw as AiFillSwitches)[k];
  return out;
};

/** The server's defaults for households that haven't chosen (all off unless the server admin turned kinds on). */
export async function serverAiFillDefaults(db: Db): Promise<Record<AiFillKind, boolean>> {
  const [row] = await db.select().from(serverSetting).where(eq(serverSetting.key, DEFAULTS_KEY));
  let parsed: unknown = null;
  try {
    parsed = row ? JSON.parse(row.value) : null;
  } catch {
    parsed = null;
  }
  return { ...off(), ...clean(parsed) };
}

export async function setServerAiFillDefaults(db: Db, switches: AiFillSwitches) {
  const value = JSON.stringify({ ...(await serverAiFillDefaults(db)), ...clean(switches) });
  await db.insert(serverSetting).values({ key: DEFAULTS_KEY, value }).onConflictDoUpdate({ target: serverSetting.key, set: { value } });
  return serverAiFillDefaults(db);
}

/** What fills in by itself in this household: its own choice per kind, else the server's default. */
export async function aiFillSettings(db: Db, householdId: string) {
  const defaults = await serverAiFillDefaults(db);
  const [row] = await db.select({ aiFill: householdSetting.aiFill }).from(householdSetting).where(eq(householdSetting.householdId, householdId));
  const chosen = clean(row?.aiFill);
  return {
    aiFill: { ...defaults, ...chosen },
    aiFillDefaults: defaults,
    aiFillChosen: aiFillKinds.filter((k) => chosen[k] !== undefined),
  };
}

/** Sets kinds on or off for the household; null hands a kind back to the server's default. */
export async function setHouseholdAiFill(db: Db, householdId: string, input: Partial<Record<AiFillKind, boolean | null>>) {
  const [row] = await db.select({ aiFill: householdSetting.aiFill }).from(householdSetting).where(eq(householdSetting.householdId, householdId));
  const next: AiFillSwitches = clean(row?.aiFill);
  for (const k of aiFillKinds) {
    if (input[k] === null) delete next[k];
    else if (typeof input[k] === "boolean") next[k] = input[k];
  }
  await db
    .insert(householdSetting)
    .values({ householdId, aiFill: next })
    .onConflictDoUpdate({ target: householdSetting.householdId, set: { aiFill: next, updatedAt: new Date() } });
}

/**
 * After a file's analysis: fill in what the household lets the AI fill. Returns the fields filled. Never throws for the
 * job's sake — a failure here leaves the suggestions as they are.
 */
export async function autoFill(
  deps: Deps,
  file: Pick<typeof attachment.$inferSelect, "id" | "householdId" | "itemId" | "filename" | "createdAt">,
  analysis: AttachmentAnalysis,
): Promise<string[]> {
  const db = deps.db;
  const { aiFill: on } = await aiFillSettings(db, file.householdId);
  if (!aiFillKinds.some((k) => on[k])) return [];
  const s = analysis.suggestions;
  const sure = new Set(s.sure ?? []);
  if (!sure.size) return [];
  // The AI acts for nobody (like the recall check): its history lines say "by AI" themselves.
  const v: Caller = { deps, db, householdId: file.householdId, userId: "", ...(await householdLocale(db, file.householdId)), via: "web" };
  const [current] = await db.select().from(item).where(and(eq(item.id, file.itemId), itemScope(v)));
  if (!current) return [];

  // What a person cleared since the file came: never filled again ("brand removed" in the item's history).
  const edits = await db
    .select({ summary: activity.summary, clearedFields: activity.clearedFields })
    .from(activity)
    .where(
      and(
        eq(activity.householdId, v.householdId),
        eq(activity.itemId, current.id),
        eq(activity.action, "item.update"),
        isNotNull(activity.actorId),
        gte(activity.createdAt, file.createdAt), // timestamps are to the second
      ),
    );
  // New activity carries machine-readable field IDs. Read both legacy display languages only for old rows.
  const cleared = (field: string, history: string) => edits.some((edit) => edit.clearedFields != null
    ? edit.clearedFields.includes(field)
    : languages.some((language) => edit.summary?.includes(translate(language, "{v0} removed", { v0: translate(language, history) }))));

  const patch: ItemPatch = {};
  const fills: Record<string, AiFill> = {};
  const words: string[] = [];
  const at = new Date().toISOString();
  const mark = (field: string, value: string | number, extra: Partial<AiFill> = {}) => {
    fills[field] = { value, from: file.filename, attachmentId: file.id, at, ...extra };
  };

  if (on.details) {
    for (const f of DETAIL_FIELDS) {
      const value = s[f.field];
      if (value == null || current[f.field] != null || !sure.has(f.sure) || cleared(f.field, f.history)) continue;
      (patch as Record<string, unknown>)[f.field] = value;
      mark(f.field, value);
      words.push(`${translateText(f.history)} ${f.field === "purchasePriceCents" ? moneyText(v, value as number, { exact: true }) : value}`);
    }
    // An unnamed "New item" gets its name too — never a name a person gave.
    if (s.name && current.name === PLACEHOLDER && sure.has("name")) {
      patch.name = s.name;
      mark("name", s.name);
      words.push(translateText("named {v0}", { v0: s.name }));
    }
  }
  const boughtOn = patch.purchaseDate ?? current.purchaseDate;
  if (on.returnBy && current.returnBy == null && !cleared("returnBy", "return by")) {
    const printed = s.returnBy && sure.has("returnBy") ? s.returnBy : undefined;
    const fromDays = s.returnDays && sure.has("returnDays") && boughtOn ? addDays(boughtOn, s.returnDays) : undefined;
    const returnBy = printed ?? fromDays;
    if (returnBy && returnBy >= today(undefined, v.timeZone)) {
      patch.returnBy = returnBy;
      mark("returnBy", returnBy);
      words.push(translateText("return by {v0}", { v0: returnBy }));
    }
  }
  if (Object.keys(patch).length) {
    await updateItem(v, current.id, patch, () => translateText("Filled in by AI from {v0}: {v1}", { v0: file.filename, v1: words.join("; ") }), { aiFills: fills });
  }

  if (on.warranty && s.warrantyMonths && sure.has("warrantyMonths") && boughtOn) {
    const endsOn = addMonths(boughtOn, s.warrantyMonths);
    const existing = await db
      .select({ id: warranty.id })
      .from(warranty)
      .where(and(eq(warranty.householdId, v.householdId), eq(warranty.itemId, current.id), eq(warranty.endsOn, endsOn), isNull(warranty.deletedAt)));
    if (!existing.length) {
      const w = await createWarranty(v, current.id, { provider: s.warrantyProvider ?? null, startsOn: boughtOn, endsOn, attachmentId: file.id });
      await setMarks(v, current.id, (marks) => ({ ...marks, warranty: { value: endsOn, from: file.filename, attachmentId: file.id, at, warrantyId: w.id } }));
      fills.warranty = { value: endsOn, from: file.filename, attachmentId: file.id, at, warrantyId: w.id };
    }
  }
  return Object.keys(fills);
}

async function setMarks(v: Caller, itemId: string, change: (marks: Record<string, AiFill>) => Record<string, AiFill>) {
  const [row] = await v.db.select({ aiFilled: item.aiFilled }).from(item).where(and(eq(item.id, itemId), eq(item.householdId, v.householdId)));
  if (!row) return;
  const next = change({ ...(row.aiFilled ?? {}) });
  await v.db
    .update(item)
    .set({ aiFilled: Object.keys(next).length ? next : null })
    .where(and(eq(item.id, itemId), eq(item.householdId, v.householdId)));
}

/** A person edited these fields: their AI marks go (updateItem). */
export function marksAfterEdit(marks: Record<string, AiFill> | null, was: Record<string, unknown>, now: Record<string, unknown>) {
  if (!marks) return undefined;
  const next = { ...marks };
  for (const field of Object.keys(marks)) if (field !== "warranty" && (was[field] ?? null) !== (now[field] ?? null)) delete next[field];
  return Object.keys(next).length === Object.keys(marks).length ? undefined : Object.keys(next).length ? next : null;
}

/** "Filled in by AI": every field still waiting for a person's look, newest first. */
export async function aiFillEntries(v: Caller): Promise<AiFillEntry[]> {
  const rows = await v.db
    .select({ id: item.id, name: item.name, aiFilled: item.aiFilled })
    .from(item)
    .where(and(itemScope(v, { gone: "include" }), isNotNull(item.aiFilled)))
    .limit(1000);
  return rows
    .flatMap((r) =>
      Object.entries(r.aiFilled ?? {}).map(([field, f]) => ({
        itemId: r.id,
        itemName: r.name,
        field,
        label: AI_FIELD_LABELS()[field] ?? field,
        value: f.value,
        from: f.from,
        at: f.at,
      })),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
}

async function markOf(v: Caller, itemId: string, field: string) {
  const [row] = await v.db.select().from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!row) throw notFound(translateText("Item"));
  const mark = row.aiFilled?.[field];
  if (!mark) throw new HTTPException(404, { message: translateText("Nothing the AI filled in there") });
  return { row, mark };
}

/** A person looked and it's right: the mark goes, the value stays. */
export async function confirmAiFill(v: Caller, itemId: string, field: string) {
  await markOf(v, itemId, field);
  await setMarks(v, itemId, (marks) => (delete marks[field], marks));
  return getItem(v, itemId);
}

/** Undo: the field is emptied again (if it still says what the AI wrote), or its warranty removed. */
export async function undoAiFill(v: Caller, itemId: string, field: string) {
  const { row, mark } = await markOf(v, itemId, field);
  if (field === "warranty") {
    if (mark.warrantyId) await deleteWarranty(v, mark.warrantyId).catch(() => {});
  } else if ((row as Record<string, unknown>)[field] === mark.value) {
    // A name can't be empty: back to the placeholder it had.
    await updateItem(v, itemId, { [field]: field === "name" ? PLACEHOLDER : null } as ItemPatch, (name) => translateText("Undid what AI filled in on {v0}: {v1}", { v0: name, v1: (AI_FIELD_LABELS()[field] ?? field).toLowerCase() }));
  }
  await setMarks(v, itemId, (marks) => (delete marks[field], marks));
  return getItem(v, itemId);
}
