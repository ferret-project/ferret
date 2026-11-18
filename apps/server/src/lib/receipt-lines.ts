/**
 * A receipt with several things on it (a Costco run, an Amazon order): the analysis lists its products
 * (`suggestions.lines`, jobs/analyze.ts), the receipt's thing shows "Also on this receipt", and a person ticks and
 * corrects them. Each becomes a thing of its own — bought the same day, at its own price, with the receipt's return
 * window, where the receipt's thing is (or where they say), its category if the model picked one — with a copy of the
 * receipt attached (its words already read, so it's found by them; not read by the model again). Handled lines (added
 * or dismissed) are marked handled (kept, so the receipt still reads as one of several things), so they're offered once.
 */
import { type ReceiptLinesInput, addDays, itemInput } from "@ferret/shared";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item } from "../db/schema";
import { addAttachment } from "./attachments";
import { categoryPaths } from "./category-paths";
import type { FileStore } from "./files";
import { refreshFileSearch } from "./fulltext";
import { todayFor } from "./household-time";
import { type Caller, createItem, itemChanged, itemScope, logActivity, notFound, updateItem } from "./inventory";

async function receiptOf(v: Caller, attachmentId: string) {
  const [row] = await v.db
    .select()
    .from(attachment)
    .where(and(eq(attachment.id, attachmentId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)));
  if (!row?.itemId) throw notFound("File");
  if (!row.analysis?.suggestions.lines?.length || row.analysis.suggestions.linesHandled) throw new HTTPException(409, { message: "That file doesn't list other things (or they were added already)" });
  return row as typeof row & { itemId: string; analysis: NonNullable<typeof row.analysis> };
}

/** The lines are handled: marked, so they aren't offered again. */
async function forgetLines(v: Caller, row: Awaited<ReturnType<typeof receiptOf>>) {
  await v.db.update(attachment).set({ analysis: { ...row.analysis, suggestions: { ...row.analysis.suggestions, linesHandled: true } } }).where(eq(attachment.id, row.id));
}

export async function addReceiptLines(v: Caller, files: FileStore, attachmentId: string, input: ReceiptLinesInput) {
  const row = await receiptOf(v, attachmentId);
  const [thing] = await v.db.select().from(item).where(and(eq(item.id, row.itemId), itemScope(v, { gone: "include" })));
  if (!thing) throw notFound("Item");
  const s = row.analysis.suggestions;
  const boughtOn = s.purchaseDate ?? thing.purchaseDate ?? null;
  // The receipt's return window, like its thing's (Suggestions.tsx): the date it prints, else its days from the day bought.
  const returnBy = s.returnBy ?? (s.returnDays && boughtOn ? addDays(boughtOn, s.returnDays) : null);
  const open = returnBy && returnBy >= todayFor(v) ? returnBy : null;
  // Where they go: as asked, else in the receipt's thing's place (not inside it, if it's a box).
  const locationId = input.locationId !== undefined ? input.locationId : thing.locationId;
  const known = await categoryPaths(v.db, v.householdId);
  const bytes = await files.get(v.householdId, row.blobKey);

  const made: { id: string; name: string }[] = [];
  let lines = input.lines;
  // The receipt photographed on its own as a "New item": the first line is that thing (it has the receipt already).
  if (input.intoItem && thing.name === "New item") {
    const [first, ...rest] = lines;
    lines = rest;
    await updateItem(v, thing.id, {
      name: first!.name,
      brand: first!.brand || null,
      model: first!.model || null,
      quantity: first!.quantity,
      purchaseDate: boughtOn,
      purchasePriceCents: first!.priceCents ?? null,
      returnBy: open,
      ...(first!.categoryId && known.pathOf.has(first!.categoryId) && { categoryId: first!.categoryId }),
      ...(input.locationId !== undefined && { locationId: input.locationId }),
    });
    made.push({ id: thing.id, name: first!.name });
  }
  for (const line of lines) {
    const created = await createItem(
      v,
      itemInput.parse({
        name: line.name,
        brand: line.brand || null,
        model: line.model || null,
        quantity: line.quantity,
        purchaseDate: boughtOn,
        purchasePriceCents: line.priceCents ?? null,
        returnBy: open,
        categoryId: line.categoryId && known.pathOf.has(line.categoryId) ? line.categoryId : null,
        locationId: locationId ?? null,
        origin: "receipt",
      }),
    );
    made.push({ id: created.id, name: created.name });
    if (!bytes) continue;
    // Its own copy of the receipt, already read: the same words to find it by, no suggestions (they're the other thing's).
    const copy = await addAttachment(v, files, { itemId: created.id }, { bytes, filename: row.filename, kind: row.kind as "photo" | "document", analyze: false });
    await v.db
      .update(attachment)
      .set({ analysisStatus: "done", analysis: { description: row.analysis.description, text: row.analysis.text, suggestions: {} }, analyzedAt: new Date() })
      .where(eq(attachment.id, copy.id));
    await refreshFileSearch(v.db, copy.id);
    await itemChanged(v, created.id);
  }
  await forgetLines(v, row);
  const added = made.filter((m) => m.id !== thing.id);
  if (added.length) await logActivity(v, "item.update", thing.id, `Added ${added.length === 1 ? added[0]!.name : `${added.length} things`} from ${row.filename}`, thing.id);
  return { items: made };
}

/** "Not these": the receipt's other lines aren't offered again. */
export async function dismissReceiptLines(v: Caller, attachmentId: string) {
  await forgetLines(v, await receiptOf(v, attachmentId));
}
