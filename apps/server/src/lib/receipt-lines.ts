/**
 * A receipt with several things on it (a Costco run, an Amazon order): the analysis lists its products
 * (`suggestions.lines`, jobs/analyze.ts), the receipt's thing shows "Also on this receipt", and a person ticks and
 * corrects them. Each becomes a thing of its own — bought the same day, at its own price, with the receipt's return
 * window, where the receipt's thing is (or where they say), its category if the model picked one — with a copy of the
 * receipt attached (its words already read, so it's found by them; not read by the model again). Handled lines (added
 * or dismissed) are marked handled (kept, so the receipt still reads as one of several things), so they're offered once.
 */
import { type ReceiptLine, type ReceiptLinesInput, type ReceiptLinesKnown, addDays, itemInput } from "@ferret/shared";
import { and, asc, count, eq, isNull, like, min } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { attachment, item } from "../db/schema";
import { addAttachment, addSharedCopy } from "./attachments";
import { categoryPaths } from "./category-paths";
import type { FileStore } from "./files";
import { inList } from "./sql";
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

/** The order number as a key: letters, digits and dashes only (so it's safe in a LIKE pattern). */
const orderKey = (number?: string) => number?.replace(/[^\p{L}\p{N}-]+/gu, "").toLowerCase().slice(0, 80) || null;
/** Names compared without case, spaces or punctuation: "PLA Matte — Ivory White" is "PLA Matte, Ivory White". */
const plain = (s?: string | null) => s?.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase() || null;
/** A line's thing's import key: its receipt's order and its model (else name), so the same order added again is known. */
const lineKey = (order: string, line: { name: string; model?: string | null; barcode?: string | null }) => `receipt:${order}:${plain(line.model) ?? line.barcode ?? plain(line.name)}`;

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Which of a receipt's lines are already in Ferret: a thing added from the same order (its import key), else one with
 * its model or its name that cost the same or was bought within two weeks of it — the order added some other way (by
 * hand, by Claude, from another copy). Each thing counts for one line only, the closest first. Gone things count;
 * deleted ones don't.
 */
export async function receiptLinesKnown(v: Caller, attachmentId: string): Promise<ReceiptLinesKnown> {
  const [row] = await v.db
    .select()
    .from(attachment)
    .where(and(eq(attachment.id, attachmentId), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)));
  // A thing's receipt, or one waiting in the inbox (lib/inbox.ts) to be read before anything is added.
  if (!row?.itemId && !row?.inboxId) throw notFound("File");
  const s = row.analysis?.suggestions ?? {};
  const lines = s.lines ?? [];
  // Either number: a read takes the order number one time and only the invoice number another.
  const numbers = [s.orderNumber, s.invoiceNumber].filter((n): n is string => Boolean(orderKey(n)));
  const orders = numbers.map((n) => orderKey(n)!);
  const live = and(eq(item.householdId, v.householdId), isNull(item.deletedAt));

  let known: ReceiptLinesKnown["order"];
  for (const [i, order] of orders.entries()) {
    const [added] = await v.db
      .select({ things: count(), first: min(item.createdAt) })
      .from(item)
      .where(and(live, like(item.importKey, `receipt:${order}:%`)));
    if (added?.things) {
      known = { number: numbers[i]!, things: added.things, addedAt: new Date(added.first!).toISOString() };
      break;
    }
  }
  if (!lines.length) return { order: known, lines: [] };

  const models = [...new Set(lines.map((l) => l.model?.trim()).filter((m): m is string => Boolean(m)))];
  const names = [...new Set(lines.map((l) => l.name.trim()))];
  // Each line's possible keys (either number; the same product twice on it gets "#2").
  const keysOf = (l: ReceiptLine) => orders.flatMap((o) => [lineKey(o, l), `${lineKey(o, l)}#2`, `${lineKey(o, l)}#3`]);
  const keys = lines.flatMap(keysOf);
  const fields = { id: item.id, name: item.name, model: item.model, barcode: item.barcode, purchaseDate: item.purchaseDate, purchasePriceCents: item.purchasePriceCents, importKey: item.importKey };
  type Candidate = { id: string; name: string; model: string | null; barcode: string | null; purchaseDate: string | null; purchasePriceCents: number | null; importKey: string | null };
  const candidates = new Map<string, Candidate>();
  const barcodes = [...new Set(lines.map((l) => l.barcode).filter((b): b is string => Boolean(b)))];
  if (barcodes.length) for (const c of await v.db.select(fields).from(item).where(and(live, inList(item.barcode, barcodes)))) candidates.set(c.id, c);
  if (models.length) for (const c of await v.db.select(fields).from(item).where(and(live, inList(item.model, models)))) candidates.set(c.id, c);
  if (keys.length) for (const c of await v.db.select(fields).from(item).where(and(live, inList(item.importKey, keys)))) candidates.set(c.id, c);
  // By name: the same words, whatever the punctuation — compared below; fetched by their first word.
  const firstWords = [...new Set(names.map((n) => n.split(/\s+/)[0]!).filter((w) => w.length >= 2))];
  for (const w of firstWords.slice(0, 50)) {
    for (const c of await v.db.select(fields).from(item).where(and(live, like(item.name, `${w.replace(/[%_]/g, "")}%`))).orderBy(asc(item.createdAt)).limit(500)) candidates.set(c.id, c);
  }

  const boughtOn = s.purchaseDate ?? null;
  const ours = (key: string) => orders.some((o) => key.startsWith(`receipt:${o}:`));
  const score = (l: ReceiptLine, c: Candidate) => {
    if (c.importKey && keysOf(l).includes(c.importKey)) return 3;
    // Added from another order: that order's (the same filament bought twice in a week, at one price).
    if (c.importKey?.startsWith("receipt:") && !ours(c.importKey)) return 0;
    const sameThing = (l.barcode && c.barcode === l.barcode) || (l.model && plain(c.model) === plain(l.model)) || plain(c.name) === plain(l.name);
    if (!sameThing) return 0;
    const samePrice = l.priceCents != null && c.purchasePriceCents === l.priceCents;
    const near = boughtOn && c.purchaseDate ? daysApart(boughtOn, c.purchaseDate) : null;
    if (samePrice && near != null && near <= 14) return 2.5 - near / 100;
    if (samePrice) return 2;
    if (near != null && near <= 14) return 1.5 - near / 100;
    return 0;
  };
  // Best pairs first, each thing and each line once.
  const pairs = lines.flatMap((l, i) => [...candidates.values()].map((c) => ({ i, c, score: score(l, c) }))).filter((p) => p.score > 0);
  pairs.sort((a, b) => b.score - a.score);
  const result: ReceiptLinesKnown["lines"] = lines.map(() => null);
  const used = new Set<string>();
  for (const p of pairs) {
    if (result[p.i] || used.has(p.c.id)) continue;
    result[p.i] = { id: p.c.id, name: p.c.name };
    used.add(p.c.id);
  }
  return { order: known, lines: result };
}

/** A SKU as a word: lower case, and wrapped after a hyphen ("A00-G3-1.75-1000-" / "SPLFREE") joined up again. */
const skuWords = (s: string) => s.toLowerCase().replace(/-\s+/g, "-").split(/\s+/).filter(Boolean);

/**
 * Each line's photo from a PDF invoice that prints one by each product: the picture whose row has the line's model
 * (its SKU) as a whole word — "…-SPL" isn't "…-SPLFREE" — else, without one, its name when only one picture has it.
 * Each picture goes to one line, in order (the same SKU bought and given free: two pictures, two lines).
 */
async function linePhotos(v: Caller, bytes: Uint8Array, contentType: string, lines: { name: string; model?: string | null }[]) {
  const pdfPages = v.deps.pdfPages;
  if (contentType !== "application/pdf" || !pdfPages?.pictures) return [];
  const models = lines.map((l) => (l.model ? skuWords(l.model).join(" ") : null));
  const names = lines.map((l) => l.name.split(",")[0]!.trim().toLowerCase());
  const has = (beside: string, i: number) => {
    const words = skuWords(beside);
    const model = models[i];
    if (model) return !model.includes(" ") ? words.includes(model) : words.join(" ").includes(model);
    return beside.toLowerCase().includes(names[i]!);
  };
  const pictures = (await pdfPages.pictures(bytes, v.deps.documentLimits?.pdfPages ?? 50, (beside) => lines.some((_, i) => has(beside, i)))) ?? [];
  const used = new Set<number>();
  return lines.map((_, i) => {
    const fits = pictures.flatMap((p, j) => (!used.has(j) && has(p.beside, i) ? [j] : []));
    const j = models[i] ? fits[0] : fits.length === 1 ? fits[0] : undefined;
    if (j === undefined) return null;
    used.add(j);
    return pictures[j]!.image;
  });
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
  const bytes = await files.get(v.householdId, row.blobKey).catch(() => null);

  // Their photos, from the invoice itself where it prints one by each product.
  const wanted = input.ownLine ? [...input.lines, input.ownLine] : input.lines;
  const photos = bytes ? await linePhotos(v, bytes, row.contentType, wanted).catch(() => []) : [];
  const photoOf = (line: (typeof wanted)[number]) => photos[wanted.indexOf(line)] ?? null;
  const addPhoto = async (itemId: string, line: (typeof wanted)[number]) => {
    const image = photoOf(line);
    if (image) await addAttachment(v, files, { itemId }, { bytes: image, filename: `${line.name.replace(/[^\p{L}\p{N} .-]+/gu, "").slice(0, 80) || "photo"}.jpg`, kind: "photo", analyze: false }).catch(() => {});
  };
  const made: { id: string; name: string }[] = [];
  // Each thing remembers its order, so adding the same receipt again shows them as already in Ferret.
  const order = orderKey(s.orderNumber) ?? orderKey(s.invoiceNumber);
  const keysUsed = new Set<string>();
  const keyOf = (line: { name: string; model?: string | null; barcode?: string | null }) => {
    if (!order) return null;
    let key = lineKey(order, line);
    for (let n = 2; keysUsed.has(key); n++) key = `${lineKey(order, line)}#${n}`;
    keysUsed.add(key);
    return key;
  };
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
    const importKey = keyOf(first!);
    if (importKey) await v.db.update(item).set({ importKey }).where(eq(item.id, thing.id));
    await addPhoto(thing.id, first!);
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
        partOfItemId: line.partOfItemId ?? null,
        barcode: line.barcode ?? null,
        origin: "receipt",
      }),
    );
    const importKey = keyOf(line);
    if (importKey) await v.db.update(item).set({ importKey }).where(eq(item.id, created.id));
    await addPhoto(created.id, line);
    made.push({ id: created.id, name: created.name });
    // The receipt on it too — the same stored file, already read (found by its words), no suggestions of its own.
    await addSharedCopy(v, { itemId: created.id }, row);
    await itemChanged(v, created.id);
  }
  // The receipt's own thing, by its line: its photo too, if it has none yet.
  if (input.ownLine && photoOf(input.ownLine)) {
    const [photo] = await v.db.select({ id: attachment.id }).from(attachment).where(and(eq(attachment.itemId, thing.id), eq(attachment.kind, "photo"), isNull(attachment.deletedAt))).limit(1);
    if (!photo) await addPhoto(thing.id, input.ownLine);
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
