/**
 * Donations by year: things marked "donated" (item.disposition), with who they went to (`disposedTo`), when, and what
 * they were worth when given (`disposalCents`). For the Past page's yearly list, its printable page and CSV. Ferret
 * records what was given; it says nothing about what's deductible — that's for the person or their accountant.
 */
import { moneyNumber } from "@ferret/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { attachment, item } from "../db/schema";
import { type Caller, asListing, itemScope } from "./inventory";
import { csvText } from "./export";
import { inList } from "./sql";

export type DonationRow = {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  condition: string | null;
  quantity: number;
  category: string | null;
  donatedOn: string | null;
  charity: string | null;
  /** What it was worth when given (minor units), as entered. */
  valueCents: number | null;
  /** What was paid for it, for reference. */
  purchasePriceCents: number | null;
  purchaseDate: string | null;
  note: string | null;
  /** Documents on the item (a donation receipt, usually). */
  documents: number;
  photoId: string | null;
};

export type DonationYear = { year: number; count: number; valueCents: number };

/** The years anything was donated in (newest first), with counts and totals; and one year's donations when asked. */
export async function donations(v: Caller, year?: number): Promise<{ years: DonationYear[]; data: DonationRow[] }> {
  const rows = await v.db
    .select()
    .from(item)
    .where(and(itemScope(v, { gone: "only" }), eq(item.disposition, "donated")));
  const byYear = new Map<number, DonationYear>();
  for (const r of rows) {
    const y = Number((r.disposedOn ?? "").slice(0, 4));
    if (!y) continue;
    const entry = byYear.get(y) ?? { year: y, count: 0, valueCents: 0 };
    entry.count += 1;
    entry.valueCents += r.disposalCents ?? 0;
    byYear.set(y, entry);
  }
  const years = [...byYear.values()].sort((a, b) => b.year - a.year);
  if (year == null) return { years, data: [] };
  const chosen = rows.filter((r) => r.disposedOn?.startsWith(`${year}-`));
  const listed = await asListing(v, chosen);
  const ids = listed.map((r) => r.id);
  const docs = ids.length
    ? await v.db
        .select({ itemId: attachment.itemId, n: count() })
        .from(attachment)
        .where(and(eq(attachment.householdId, v.householdId), inList(attachment.itemId, ids), eq(attachment.kind, "document"), isNull(attachment.deletedAt)))
        .groupBy(attachment.itemId)
    : [];
  const documents = new Map(docs.map((d) => [d.itemId, d.n]));
  const data = listed
    .map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      model: r.model,
      condition: r.condition,
      quantity: r.quantity,
      category: r.category,
      donatedOn: r.disposedOn ?? null,
      charity: r.disposedTo ?? null,
      valueCents: r.disposalCents ?? null,
      purchasePriceCents: r.purchasePriceCents,
      purchaseDate: r.purchaseDate,
      note: r.disposalNote ?? null,
      documents: documents.get(r.id) ?? 0,
      photoId: r.photoId,
    }))
    .sort((a, b) => (a.donatedOn ?? "").localeCompare(b.donatedOn ?? "") || a.name.localeCompare(b.name));
  return { years, data };
}

const COLUMNS: [string, (r: DonationRow, currency: string) => string | number | null | undefined][] = [
  ["Date given", (r) => r.donatedOn],
  ["Given to", (r) => r.charity],
  ["Item", (r) => r.name],
  ["Brand", (r) => r.brand],
  ["Model", (r) => r.model],
  ["Condition", (r) => r.condition],
  ["Quantity", (r) => r.quantity],
  ["Category", (r) => r.category],
  ["Value when given", (r, cur) => (r.valueCents == null ? null : moneyNumber(r.valueCents, cur))],
  ["Price paid", (r, cur) => (r.purchasePriceCents == null ? null : moneyNumber(r.purchasePriceCents, cur))],
  ["Purchase date", (r) => r.purchaseDate],
  ["Currency", (_r, cur) => cur],
  ["Receipts & documents", (r) => r.documents],
  ["Note", (r) => r.note],
  ["Ferret ID", (r) => r.id],
];

/** The year's donations as a spreadsheet (amounts as plain numbers in the household's currency). */
export function donationsCsv(rows: DonationRow[], currency: string) {
  return csvText(COLUMNS.map(([title]) => title), rows.map((r) => COLUMNS.map(([, get]) => get(r, currency))));
}
