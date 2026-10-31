/**
 * The insurance export: every item with what an adjuster asks for — where it
 * is, what it is, make/model/serial, quantity, condition, what was paid and
 * what it's worth, proof (photos, receipts) and warranty. One list feeds both
 * the CSV download and the printable report.
 */
import type { ExportRow } from "@ferret/shared";
import { and, count, eq, inArray, isNull, max } from "drizzle-orm";
import { attachment, item, location, warranty } from "../db/schema";
import { type Caller, type ItemFilter, asListing, descendants, itemScope, withTags } from "./inventory";
import { inList } from "./sql";

/**
 * Items to export, sorted by where they are (property › room › …), then name. `propertyId` narrows to one property.
 * `gone: "lost"` lists what was lost or stolen instead — for a claim — with what happened and when. `filter` narrows
 * further (a tag's or category's things, for a share link).
 */
export async function exportRows(v: Caller, opts: { propertyId?: string; gone?: "lost"; filter?: ItemFilter } = {}): Promise<ExportRow[]> {
  let scope = opts.gone ? and(itemScope(v, { gone: "only" }), inArray(item.disposition, ["lost", "stolen"]))! : itemScope(v, opts.filter);
  if (opts.propertyId) {
    const rooms = await v.db
      .select({ id: location.id })
      .from(location)
      .where(and(eq(location.propertyId, opts.propertyId), eq(location.householdId, v.householdId), isNull(location.deletedAt)));
    const ids = (await Promise.all(rooms.map((r) => descendants(v, r.id)))).flat();
    if (!ids.length) return [];
    scope = and(scope, inList(item.locationId, ids))!;
  }
  // Boxes are packaging, not belongings — unless they're worth something themselves (a jewelry case).
  const owned = (await v.db.select().from(item).where(scope)).filter(
    (r) => !r.isContainer || r.valueCents != null || r.purchasePriceCents != null,
  );
  const rows = await asListing(v, await withTags(v, owned));
  const ids = rows.map((r) => r.id);
  const [files, warranties] = await Promise.all([
    ids.length
      ? v.db
          .select({ itemId: attachment.itemId, kind: attachment.kind, n: count() })
          .from(attachment)
          .where(and(eq(attachment.householdId, v.householdId), inList(attachment.itemId, ids), isNull(attachment.deletedAt)))
          .groupBy(attachment.itemId, attachment.kind)
      : [],
    ids.length
      ? v.db
          .select({ itemId: warranty.itemId, endsOn: max(warranty.endsOn) })
          .from(warranty)
          .where(and(eq(warranty.householdId, v.householdId), inList(warranty.itemId, ids), isNull(warranty.deletedAt)))
          .groupBy(warranty.itemId)
      : [],
  ]);
  const photos = new Map(files.filter((f) => f.kind === "photo").map((f) => [f.itemId, f.n]));
  const documents = new Map(files.filter((f) => f.kind === "document").map((f) => [f.itemId, f.n]));
  const warrantyEnds = new Map(warranties.map((w) => [w.itemId, w.endsOn]));
  return rows
    .map((r) => {
      const each = r.valueCents ?? r.purchasePriceCents;
      return {
        id: r.id,
        name: r.name,
        place: r.place,
        box: r.container?.name ?? null,
        category: r.category,
        tags: r.tags,
        brand: r.brand,
        model: r.model,
        serialNumber: r.serialNumber,
        quantity: r.quantity,
        condition: r.condition,
        purchaseDate: r.purchaseDate,
        purchasePriceCents: r.purchasePriceCents,
        valueCents: r.valueCents,
        totalValueCents: each == null ? null : each * Math.max(1, r.quantity),
        photos: photos.get(r.id) ?? 0,
        documents: documents.get(r.id) ?? 0,
        photoId: r.photoId,
        warrantyEnds: warrantyEnds.get(r.id) ?? null,
        description: r.description,
        notes: r.notes,
        ...(opts.gone ? { disposition: r.disposition ?? null, disposedOn: r.disposedOn ?? null } : {}),
      };
    })
    .sort((a, b) => (a.place ?? "\uffff").localeCompare(b.place ?? "\uffff") || a.name.localeCompare(b.name));
}

const COLUMNS: [string, (r: ExportRow) => string | number | null | undefined][] = [
  ["Item", (r) => r.name],
  ["Where", (r) => r.place],
  ["In box", (r) => r.box],
  ["Category", (r) => r.category],
  ["Brand", (r) => r.brand],
  ["Model", (r) => r.model],
  ["Serial number", (r) => r.serialNumber],
  ["Quantity", (r) => r.quantity],
  ["Condition", (r) => r.condition],
  ["Purchase date", (r) => r.purchaseDate],
  ["Price paid (each)", (r) => dollars(r.purchasePriceCents)],
  ["Value (each)", (r) => dollars(r.valueCents)],
  ["Total value", (r) => dollars(r.totalValueCents)],
  ["Photos", (r) => r.photos],
  ["Receipts & documents", (r) => r.documents],
  ["Warranty until", (r) => r.warrantyEnds],
  ["Tags", (r) => r.tags.join("; ")],
  ["Description", (r) => r.description],
  ["Notes", (r) => r.notes],
  ["Ferret ID", (r) => r.id],
];

const dollars = (cents: number | null | undefined) => (cents == null ? null : (cents / 100).toFixed(2));

/** For a lost-or-stolen claim: what happened, and when, first. */
const GONE_COLUMNS: typeof COLUMNS = [
  ["What happened", (r) => r.disposition],
  ["When", (r) => r.disposedOn],
];

/** RFC 4180 CSV, with a byte-order mark so Excel reads the text as UTF-8. With `gone`, what happened and when first. */
export function toCsv(rows: ExportRow[], opts: { gone?: boolean } = {}) {
  const columns = opts.gone ? [...COLUMNS.slice(0, 1), ...GONE_COLUMNS, ...COLUMNS.slice(1)] : COLUMNS;
  const cell = (value: string | number | null | undefined) => {
    const text = value == null ? "" : String(value);
    // Quote when needed; a leading =, +, -, @, tab or carriage return is defused so a spreadsheet can't run it as a formula.
    const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map(([title]) => cell(title)).join(","), ...rows.map((r) => columns.map(([, get]) => cell(get(r))).join(","))];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
