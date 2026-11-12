/**
 * Parts & supplies for one thing: the household's items that are parts of it (`item.partOfItemId` — a dust collector's
 * bags) or that its maintenance uses (a task's part), with their stock and where to buy them; and the parts its manuals
 * list (documents' `suggestions.parts`) that aren't among them yet — suggestions a person taps to add, or dismisses.
 */
import type { ItemParts, ItemPart, SuggestedPart } from "@ferret/shared";
import { amazonCartUrl, amazonProductOf, amazonSearchUrl } from "@ferret/shared/utils";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item, maintenanceTask } from "../db/schema";
import { householdAmazon } from "./household-time";
import { asListing, type Caller, getItem, itemScope } from "./inventory";
import { inList } from "./sql";

/** A part number as compared: letters and digits only ("JT9-717531" ends with "717531"). */
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Whether a part number names this part: its model is it (or ends with it, a store's prefix), or its name says it. */
function isPart(p: { name: string; model: string | null }, partNumber: string) {
  const n = plain(partNumber);
  if (n.length < 3) return false;
  const model = p.model ? plain(p.model) : "";
  return model === n || (model.length > n.length && model.endsWith(n)) || (n.length >= 5 && plain(p.name).includes(n));
}

export async function itemParts(v: Caller, itemId: string): Promise<ItemParts> {
  await getItem(v, itemId); // the household's, or a 404
  const tasks = await v.db
    .select({ partId: maintenanceTask.partItemId, title: maintenanceTask.title })
    .from(maintenanceTask)
    .where(and(eq(maintenanceTask.householdId, v.householdId), eq(maintenanceTask.itemId, itemId), isNotNull(maintenanceTask.partItemId), isNull(maintenanceTask.deletedAt)));
  const taskParts = [...new Set(tasks.map((t) => t.partId!))];
  const rows = await v.db
    .select()
    .from(item)
    .where(and(itemScope(v), or(eq(item.partOfItemId, itemId), taskParts.length ? inList(item.id, taskParts) : undefined)));
  const { site } = await householdAmazon(v.db, v.householdId);
  const parts: ItemPart[] = (await asListing(v, rows.filter((r) => r.id !== itemId)))
    .map((r) => {
      const amazon = amazonProductOf(r.links);
      const task = tasks.find((t) => t.partId === r.id);
      return {
        id: r.id,
        name: r.name,
        brand: r.brand ?? null,
        model: r.model ?? null,
        quantity: r.quantity,
        minQuantity: r.minQuantity ?? null,
        low: r.minQuantity != null && r.quantity <= r.minQuantity,
        photoId: r.photoId,
        place: r.place ?? null,
        link: (r.links ?? []).find((l) => !amazonProductOf([l])) ?? null,
        amazonCart: amazon ? amazonCartUrl(amazon.site, [{ asin: amazon.asin, quantity: 1 }]) : null,
        amazonSearch: amazon ? null : amazonSearchUrl(r, site),
        task: task?.title ?? null,
      };
    })
    .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));

  // What its manuals list that it doesn't have yet (one of each part number, the first document's).
  const docs = await v.db
    .select({ id: attachment.id, filename: attachment.filename, analysis: attachment.analysis })
    .from(attachment)
    .where(and(eq(attachment.householdId, v.householdId), eq(attachment.itemId, itemId), eq(attachment.kind, "document"), eq(attachment.analysisStatus, "done"), isNull(attachment.deletedAt)));
  const suggested: SuggestedPart[] = [];
  for (const d of docs) {
    for (const p of d.analysis?.suggestions.parts ?? []) {
      if (parts.some((x) => isPart(x, p.partNumber)) || suggested.some((s) => plain(s.partNumber) === plain(p.partNumber))) continue;
      suggested.push({ ...p, attachmentId: d.id, filename: d.filename });
    }
  }
  return { parts, suggested };
}

/** "Not needed": the part leaves the document's suggestions for good (a new reading of it may suggest it again). */
export async function dismissSuggestedPart(v: Caller, itemId: string, input: { attachmentId: string; partNumber: string }) {
  await getItem(v, itemId);
  const [doc] = await v.db
    .select({ analysis: attachment.analysis })
    .from(attachment)
    .where(and(eq(attachment.id, input.attachmentId), eq(attachment.householdId, v.householdId), eq(attachment.itemId, itemId), isNull(attachment.deletedAt)));
  if (!doc?.analysis) throw new HTTPException(404, { message: "Document not found" });
  const left = (doc.analysis.suggestions.parts ?? []).filter((p) => plain(p.partNumber) !== plain(input.partNumber));
  const suggestions = { ...doc.analysis.suggestions, parts: left.length ? left : undefined };
  if (!left.length) delete suggestions.parts;
  await v.db
    .update(attachment)
    .set({ analysis: { ...doc.analysis, suggestions } })
    .where(and(eq(attachment.id, input.attachmentId), eq(attachment.householdId, v.householdId)));
}
