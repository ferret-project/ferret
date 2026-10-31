/**
 * Labels people already have: one of this household's blank Ferret labels (by its code or its QR), or any other code —
 * a pre-printed asset tag, a QR sticker from another app. Ferret's own go through labels.ts; anything else is an
 * `own_label` on an item (or box), which scanning opens just the same (stock.scan). A code that already opens
 * something is refused, saying what has it — never moved over silently.
 */
import type { Label, LabelTarget, OwnLabel } from "@ferret/shared";
import { barcodeVariants } from "@ferret/shared";
import { isPairingPayload } from "@ferret/shared/utils";
import { and, eq, inArray, ne } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { item, label, ownLabel, stockRule } from "../db/schema";
import { type Caller, itemChanged, itemScope, logActivity, notFound } from "./inventory";
import { assignLabel, normalizeCode } from "./labels";
import { scanKey } from "./stock";

/** In use: says what has it (`details`: the item's id and name, for a link). */
const inUse = (what: string, holder: { id: string; name: string }) =>
  new HTTPException(409, { message: `${what} is already on ${holder.name}`, cause: { itemId: holder.id, name: holder.name } });

export async function ownLabelsOf(v: Caller, itemId: string): Promise<OwnLabel[]> {
  const rows = await v.db
    .select({ id: ownLabel.id, code: ownLabel.code })
    .from(ownLabel)
    .where(and(eq(ownLabel.householdId, v.householdId), eq(ownLabel.itemId, itemId)))
    .orderBy(ownLabel.createdAt);
  return rows;
}

/** Put a label you already have on something: a blank Ferret label, or (items and boxes) any other code. */
export async function attachLabel(v: Caller, raw: string, target: LabelTarget): Promise<{ label: Label } | { ownLabel: OwnLabel }> {
  if (isPairingPayload(raw)) throw new HTTPException(422, { message: "That's a HomeKit or Matter pairing code — save it under Pairing codes instead" });
  const key = scanKey(raw);
  if (key.startsWith("label:")) return { label: await assignLabel(v, key.slice(6), target) };
  const bare = normalizeCode(raw);
  if (bare.length === 6) {
    const [ferret] = await v.db.select({ code: label.code }).from(label).where(and(eq(label.householdId, v.householdId), eq(label.code, bare)));
    if (ferret) return { label: await assignLabel(v, ferret.code, target) };
  }
  if (!target.itemId) throw new HTTPException(422, { message: "A place takes one of Ferret's own labels — make one, or use a blank one you've printed" });

  const [it] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, target.itemId), itemScope(v, { gone: "include" })));
  if (!it) throw notFound("Item");

  const [held] = await v.db.select().from(ownLabel).where(and(eq(ownLabel.householdId, v.householdId), eq(ownLabel.code, key)));
  if (held?.itemId === it.id) return { ownLabel: { id: held.id, code: held.code } };
  if (held) {
    const [holder] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, held.itemId), itemScope(v, { gone: "include" })));
    if (holder) throw inUse("That label", holder);
    await v.db.delete(ownLabel).where(eq(ownLabel.id, held.id)); // on something deleted: free again
  }
  // A code that already opens something by scanning: a scan setting, or (product codes) another item's barcode.
  const [ruled] = await v.db
    .select({ id: item.id, name: item.name })
    .from(stockRule)
    .innerJoin(item, eq(item.id, stockRule.itemId))
    .where(and(eq(stockRule.householdId, v.householdId), eq(stockRule.code, key), ne(stockRule.itemId, it.id), itemScope(v)));
  if (ruled) throw inUse("That code", ruled);
  const [barcoded] = await v.db
    .select({ id: item.id, name: item.name })
    .from(item)
    .where(and(itemScope(v), inArray(item.barcode, [key, ...barcodeVariants(key)]), ne(item.id, it.id)));
  if (barcoded) throw inUse("That barcode", barcoded);

  const [row] = await v.db.insert(ownLabel).values({ householdId: v.householdId, code: key, itemId: it.id }).returning();
  await logActivity(v, "item.label", it.id, `Put label ${key} on ${it.name}`);
  await itemChanged(v, it.id); // its code is searchable
  return { ownLabel: { id: row!.id, code: row!.code } };
}

export async function removeOwnLabel(v: Caller, id: string) {
  const [row] = await v.db
    .delete(ownLabel)
    .where(and(eq(ownLabel.id, id), eq(ownLabel.householdId, v.householdId)))
    .returning();
  if (!row) throw notFound("Label");
  const [it] = await v.db.select({ name: item.name }).from(item).where(eq(item.id, row.itemId));
  await logActivity(v, "item.label", row.itemId, `Took label ${row.code} off ${it?.name ?? "it"}`);
  await itemChanged(v, row.itemId);
}
