/**
 * Scan to count: some codes change a count instead of opening an item. Each code has a behaviour per household
 * (stock_rule) — look up (the default), use (take `step` out), restock (put `step` in) or ask — and the scanner's
 * switch can override it for a session. Every change to a count is a stock_movement (by scan, by hand, by editing the
 * item, by undo), so counts have a history and a scan can be undone. What's run out — or is at or below an item's
 * "keep at least" — is the shopping list (shoppingList): a state, so restocking takes it off by itself.
 */
import type { ScanCandidate, ScanInput, ScanResult, ShoppingItem, ShoppingList, StockAdjust, StockBehaviour, StockMovement, StockRuleInput, StockSummary } from "@ferret/shared";
import { addDays, barcodeVariants } from "@ferret/shared";
import { isPairingPayload } from "@ferret/shared/utils";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, label, maintenanceTask, ownLabel, stockMovement, stockRule, user } from "../db/schema";
import { type Caller, asListing, itemScope, logActivity, notFound } from "./inventory";
import type { FileStore } from "./files";
import { normalizeCode } from "./labels";
import { findPairing } from "./pairing";
import { productCode } from "./products";
import { todayFor } from "./household-time";
import { inList } from "./sql";

/** How a movement came about. */
type Reason = StockMovement["reason"];

const LABEL_URL = /\/l\/([0-9A-Za-z]{4,12})\/?$/;

/** A scanned or typed code as rules store it: `label:<CODE>` for Ferret's labels, 13-digit EAN for product codes. */
export function scanKey(raw: string) {
  const fromUrl = LABEL_URL.exec(raw.trim())?.[1];
  if (fromUrl) return `label:${normalizeCode(fromUrl)}`;
  if (/^label:/i.test(raw.trim())) return `label:${normalizeCode(raw.trim().slice(6))}`;
  return productCode(raw) ?? raw.trim();
}

/** A rule's code, for people. */
export function codeLabel(code: string) {
  if (code.startsWith("label:")) return `QR label ${code.slice(6)}`;
  return /^\d{8,14}$/.test(code) ? `Barcode ${code}` : `Code ${code}`;
}

async function candidatesOf(v: Caller, rows: (typeof item.$inferSelect)[]): Promise<ScanCandidate[]> {
  return (await asListing(v, rows)).map((r) => ({ id: r.id, name: r.name, place: r.place ?? null, quantity: r.quantity }));
}

/** The household's things with this barcode (any UPC/EAN spelling), most recently changed first — "you have this". */
export async function itemsWithCode(v: Caller, raw: string): Promise<ScanCandidate[]> {
  const key = scanKey(raw);
  if (key.startsWith("label:") || isPairingPayload(raw)) return [];
  const rules = await v.db.select({ itemId: stockRule.itemId }).from(stockRule).where(and(eq(stockRule.householdId, v.householdId), eq(stockRule.code, key)));
  const byBarcode = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v), inArray(item.barcode, [key, ...barcodeVariants(key)])));
  const ids = [...new Set([...rules.map((r) => r.itemId), ...byBarcode.map((r) => r.id)])];
  if (!ids.length) return [];
  const rows = await v.db.select().from(item).where(and(itemScope(v), inList(item.id, ids))).orderBy(desc(item.updatedAt));
  return candidatesOf(v, rows);
}

// ── Counts ───────────────────────────────────────────────────────────────────

/**
 * Changes an item's count by `delta`, never below 0 (`applied` says what actually changed), and logs it. Safe when
 * two people scan at once: the update only lands on the count it read, else it reads again.
 */
export async function adjustStock(v: Caller, itemId: string, delta: number, reason: Reason, note?: string | null, clientId?: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [current] = await v.db.select({ quantity: item.quantity, name: item.name }).from(item).where(and(eq(item.id, itemId), itemScope(v)));
    if (!current) throw notFound("Item");
    const next = Math.max(0, current.quantity + delta);
    const applied = next - current.quantity;
    if (applied === 0) return { quantity: current.quantity, applied: 0, movementId: null as string | null };
    const [row] = await v.db
      .update(item)
      .set({ quantity: next })
      .where(and(eq(item.id, itemId), itemScope(v), eq(item.quantity, current.quantity)))
      .returning({ quantity: item.quantity });
    if (!row) continue; // someone else changed it in between
    const movementId = await recordMovement(v, itemId, applied, next, reason, note, clientId);
    await logActivity(v, "item.stock", itemId, `${applied < 0 ? `Used ${-applied}` : `Added ${applied}`} ${current.name} (${next} left)`);
    return { quantity: next, applied, movementId };
  }
  throw new HTTPException(409, { message: "The count kept changing — try again" });
}

/** Logs a change already made (editing an item's quantity logs through here too). */
export async function recordMovement(
  v: Caller,
  itemId: string,
  delta: number,
  quantityAfter: number,
  reason: Reason,
  note?: string | null,
  clientId?: string,
) {
  const [m] = await v.db
    .insert(stockMovement)
    .values({ householdId: v.householdId, itemId, delta, quantityAfter, reason, note: note ?? null, userId: v.userId, via: v.via, clientId: clientId ?? null })
    .returning({ id: stockMovement.id });
  return m!.id;
}

export async function adjustByHand(v: Caller, itemId: string, input: StockAdjust) {
  return adjustStock(v, itemId, input.delta, "manual", input.note);
}

/** Undoes a change (a scan by mistake): the opposite change, as far as the count allows. Each one only once. */
export async function undoMovement(v: Caller, movementId: string) {
  const [m] = await v.db
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.id, movementId), eq(stockMovement.householdId, v.householdId)));
  if (!m) throw notFound("Change");
  if (m.undoneAt || m.reason === "undo") throw new HTTPException(409, { message: "That's already been undone" });
  const result = await adjustStock(v, m.itemId, -m.delta, "undo");
  await v.db.update(stockMovement).set({ undoneAt: new Date() }).where(eq(stockMovement.id, m.id));
  return { itemId: m.itemId, ...result };
}

export async function stockSummary(v: Caller, itemId: string, limit = 30): Promise<StockSummary> {
  // Something you no longer have keeps its history (its count just can't change).
  const [row] = await v.db.select({ quantity: item.quantity }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!row) throw notFound("Item");
  const [rules, moves] = await Promise.all([
    v.db.select().from(stockRule).where(and(eq(stockRule.householdId, v.householdId), eq(stockRule.itemId, itemId))).orderBy(stockRule.createdAt),
    v.db
      .select({ m: stockMovement, by: user.name })
      .from(stockMovement)
      .leftJoin(user, eq(user.id, stockMovement.userId))
      .where(and(eq(stockMovement.householdId, v.householdId), eq(stockMovement.itemId, itemId)))
      .orderBy(desc(stockMovement.createdAt))
      .limit(limit),
  ]);
  return {
    quantity: row.quantity,
    rules: rules.map((r) => ({ id: r.id, code: r.code, label: codeLabel(r.code), behaviour: r.behaviour, step: r.step })),
    movements: moves.map(({ m, by }) => ({
      id: m.id,
      delta: m.delta,
      quantityAfter: m.quantityAfter,
      reason: m.reason,
      note: m.note,
      by,
      via: m.via,
      undone: m.undoneAt != null,
      at: m.createdAt.toISOString(),
    })),
  };
}

// ── What a code does ─────────────────────────────────────────────────────────

/** Sets what scanning `code` does to this item. A QR label must be this item's (or blank — then it becomes its). */
export async function setStockRule(v: Caller, itemId: string, input: StockRuleInput) {
  const [target] = await v.db.select({ id: item.id }).from(item).where(and(eq(item.id, itemId), itemScope(v)));
  if (!target) throw notFound("Item");
  if (isPairingPayload(input.code)) throw new HTTPException(422, { message: "That's a HomeKit or Matter pairing code — save it under Pairing codes instead" });
  let code = scanKey(input.code);
  // A label's bare code (K7QM2X) typed in: it's that label, if this household has it.
  if (!code.startsWith("label:")) {
    const [own] = await v.db.select().from(label).where(and(eq(label.householdId, v.householdId), eq(label.code, normalizeCode(input.code))));
    if (own && normalizeCode(input.code).length === 6) code = `label:${own.code}`;
  }
  if (code.startsWith("label:")) {
    const [tag] = await v.db.select().from(label).where(and(eq(label.householdId, v.householdId), eq(label.code, code.slice(6))));
    if (!tag) throw new HTTPException(404, { message: "That isn't one of this household's labels" });
    if (tag.locationId || (tag.itemId && tag.itemId !== itemId)) throw new HTTPException(409, { message: "That label is on something else" });
    if (!tag.itemId) await v.db.update(label).set({ itemId }).where(eq(label.id, tag.id));
  }
  const values = { behaviour: input.behaviour, step: input.step ?? 1 };
  const [rule] = await v.db
    .insert(stockRule)
    .values({ householdId: v.householdId, itemId, code, ...values })
    .onConflictDoUpdate({ target: [stockRule.householdId, stockRule.code, stockRule.itemId], set: values })
    .returning();
  return { id: rule!.id, code: rule!.code, label: codeLabel(rule!.code), behaviour: rule!.behaviour, step: rule!.step };
}

export async function deleteStockRule(v: Caller, itemId: string, ruleId: string) {
  const gone = await v.db
    .delete(stockRule)
    .where(and(eq(stockRule.id, ruleId), eq(stockRule.itemId, itemId), eq(stockRule.householdId, v.householdId)))
    .returning({ id: stockRule.id });
  if (!gone.length) throw notFound("Barcode setting");
}

/**
 * A scan: what the code is (rules, items with that barcode, the label it is), and what to do — open it, change its
 * count, ask which item, or ask what to do. `canWrite` false (a viewer) only ever looks things up.
 */
export async function scan(v: Caller, input: ScanInput, canWrite: boolean, files?: FileStore): Promise<ScanResult> {
  // A HomeKit/Matter pairing QR: the item it's saved on, or "which item is it for?" — never a count, never a lookup.
  if (isPairingPayload(input.code)) {
    const found = files ? await findPairing(v, files, input.code) : null;
    if (!found) return { action: "unknown", code: input.code };
    if (found.item) return { action: "open", item: (await candidatesOf(v, [found.item]))[0]! };
    return { action: "pairing", kind: found.info.kind, category: found.info.category };
  }
  const key = scanKey(input.code);
  const mode = input.mode ?? "auto";
  // Sent again (an offline scan whose answer got lost): the change it already made, not another one.
  if (input.clientId) {
    const [done] = await v.db
      .select()
      .from(stockMovement)
      .where(and(eq(stockMovement.householdId, v.householdId), eq(stockMovement.clientId, input.clientId)));
    if (done) {
      const [row] = await v.db.select().from(item).where(and(eq(item.id, done.itemId), itemScope(v, { gone: "include" })));
      if (row) {
        const [only] = await candidatesOf(v, [row]);
        return { action: "adjusted", item: only!, delta: done.delta, applied: done.delta, movementId: done.id, repeat: true };
      }
    }
  }

  const rules = await v.db.select().from(stockRule).where(and(eq(stockRule.householdId, v.householdId), eq(stockRule.code, key)));
  const ids = new Set(rules.map((r) => r.itemId));
  // Scanning to add: a QR label is looked up as ever (the label page offers what to do with it).
  const adding = mode === "add";
  let labelOnly = key.startsWith("label:");
  if (key.startsWith("label:")) {
    const [tag] = await v.db.select().from(label).where(and(eq(label.householdId, v.householdId), eq(label.code, key.slice(6))));
    if (tag?.itemId) ids.add(tag.itemId);
    // A room's label, a blank one, or one from elsewhere: its label page knows what to do.
    if (!ids.size) return { action: "open", label: key.slice(6) };
  } else {
    const variants = [key, ...barcodeVariants(key)];
    const byBarcode = await v.db.select({ id: item.id }).from(item).where(and(itemScope(v), inArray(item.barcode, variants)));
    for (const r of byBarcode) ids.add(r.id);
    // A label someone brought (an asset tag): it opens its item, like Ferret's own labels.
    const [own] = await v.db.select({ itemId: ownLabel.itemId }).from(ownLabel).where(and(eq(ownLabel.householdId, v.householdId), eq(ownLabel.code, key)));
    if (own) {
      ids.add(own.itemId);
      if (ids.size === 1 && !rules.length) labelOnly = true;
    }
  }
  let rows = ids.size ? await v.db.select().from(item).where(and(itemScope(v), inList(item.id, [...ids]))) : [];
  if (!rows.length) return { action: "unknown", code: input.code };

  // The one scanned most recently first (where the spares usually come from).
  const lastScan = new Map<string, number>();
  const recent = await v.db
    .select({ itemId: stockMovement.itemId, at: stockMovement.createdAt })
    .from(stockMovement)
    .where(and(eq(stockMovement.householdId, v.householdId), inList(stockMovement.itemId, rows.map((r) => r.id)), eq(stockMovement.reason, "scan"), isNull(stockMovement.undoneAt)))
    .orderBy(desc(stockMovement.createdAt))
    .limit(50);
  for (const r of recent) if (!lastScan.has(r.itemId)) lastScan.set(r.itemId, r.at.getTime());
  rows.sort((a, b) => (lastScan.get(b.id) ?? 0) - (lastScan.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const ruleFor = (itemId: string) => rules.find((r) => r.itemId === itemId);

  // What to do: the scanner's switch, else what the code is set to — with several items, the first one that changes a
  // count (decided across all of them, so picking one from "which?" does what the code does).
  let behaviour: StockBehaviour =
    mode === "add" ? "restock" : mode !== "auto" ? mode : (rows.map((r) => ruleFor(r.id)?.behaviour).find((b) => b && b !== "lookup") ?? "lookup");
  if (!canWrite || (adding && labelOnly)) behaviour = "lookup";
  const stepOf = (itemId: string) => ruleFor(itemId)?.step ?? rules.find((r) => r.behaviour === behaviour)?.step ?? 1;

  if (input.itemId) {
    rows = rows.filter((r) => r.id === input.itemId);
    if (!rows.length) throw notFound("Item");
  }
  const candidates = await candidatesOf(v, rows);

  // Already have it: add to what's there (the usual answer), or add it as a separate item — never a silent duplicate.
  if (adding && behaviour === "restock" && !input.itemId) return { action: "have", code: input.code, step: stepOf(candidates[0]!.id), items: candidates };
  if (candidates.length > 1) return { action: "choose", behaviour, step: stepOf(candidates[0]!.id), items: candidates };
  const only = candidates[0]!;
  if (behaviour === "lookup") return { action: "open", item: only };
  if (behaviour === "ask") return { action: "ask", item: only, step: stepOf(only.id) };
  const delta = behaviour === "use" ? -stepOf(only.id) : stepOf(only.id);
  const result = await adjustStock(v, only.id, delta, "scan", null, input.clientId);
  return { action: "adjusted", item: { ...only, quantity: result.quantity }, delta, applied: result.applied, movementId: result.movementId };
}

// ── Shopping list ────────────────────────────────────────────────────────────

/** How far ahead maintenance's parts are checked: enough time to order some. */
export const PARTS_AHEAD_DAYS = 30;

/**
 * What to buy: items at or below their "keep at least", tracked items (a scan code or any count history) that have
 * run out, and parts that maintenance due in the next PARTS_AHEAD_DAYS needs and there aren't enough of. Run out first.
 */
export async function shoppingList(v: Caller): Promise<ShoppingList> {
  const tracked = sql`${item.id} in (select ${stockRule.itemId} from ${stockRule} where ${stockRule.householdId} = ${v.householdId}
    union select ${stockMovement.itemId} from ${stockMovement} where ${stockMovement.householdId} = ${v.householdId})`;
  const low = await v.db
    .select()
    .from(item)
    .where(and(itemScope(v), or(and(isNotNull(item.minQuantity), lte(item.quantity, item.minQuantity)), and(eq(item.quantity, 0), tracked))));
  // Parts that maintenance coming up (or overdue) needs and there aren't enough of.
  const soon = addDays(todayFor(v), PARTS_AHEAD_DAYS);
  const needs = await v.db
    .select({ task: maintenanceTask, part: item })
    .from(maintenanceTask)
    .innerJoin(item, eq(item.id, maintenanceTask.partItemId))
    .where(
      and(
        eq(maintenanceTask.householdId, v.householdId),
        isNull(maintenanceTask.deletedAt),
        isNotNull(maintenanceTask.dueOn),
        lte(maintenanceTask.dueOn, soon),
        itemScope(v),
        sql`${item.quantity} < ${maintenanceTask.partQuantity}`,
      ),
    )
    .orderBy(maintenanceTask.dueOn);
  const rows = [...low];
  for (const n of needs) if (!rows.some((r) => r.id === n.part.id)) rows.push(n.part);

  const packs = rows.length
    ? await v.db
        .select({ itemId: stockRule.itemId, step: stockRule.step })
        .from(stockRule)
        .where(and(eq(stockRule.householdId, v.householdId), eq(stockRule.behaviour, "restock"), inList(stockRule.itemId, rows.map((r) => r.id))))
    : [];
  const items: ShoppingItem[] = (await asListing(v, rows))
    .map((r) => {
      const need = needs.find((n) => n.part.id === r.id);
      const toMin = Math.max(1, (r.minQuantity ?? 0) - r.quantity + 1);
      return {
        id: r.id,
        name: r.name,
        place: r.place ?? null,
        quantity: r.quantity,
        minQuantity: r.minQuantity ?? null,
        buy: packs.find((p) => p.itemId === r.id)?.step ?? Math.max(toMin, need ? need.task.partQuantity - r.quantity : 0),
        forTask: need ? `${need.task.title}, due ${need.task.dueOn}` : null,
        photoId: r.photoId,
        unitCents: r.purchasePriceCents ?? r.valueCents ?? null,
      };
    })
    .sort((a, b) => Number(b.quantity === 0) - Number(a.quantity === 0) || a.name.localeCompare(b.name));
  return { items, text: shoppingText(items) };
}

/** The list as plain text — for a message, a notes app, a to-do list. */
export function shoppingText(items: ShoppingItem[]) {
  if (!items.length) return "Nothing to buy.";
  return [
    "Shopping list",
    ...items.map((i) => `- ${i.name}${i.buy > 1 ? ` ×${i.buy}` : ""} (${i.quantity === 0 ? "none left" : `${i.quantity} left`}${i.forTask ? ` — for ${i.forTask}` : ""})`),
  ].join("\n");
}
