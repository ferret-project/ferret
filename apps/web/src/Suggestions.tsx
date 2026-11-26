/**
 * "Suggestions from your photos": item fields and warranty terms the model read off photos, receipts and warranty
 * cards. Nothing changes until someone taps Apply or Add (unless the household lets AI fill in — AiFill.tsx).
 * Maintenance schedules from manuals are in Suggested maintenance (SuggestedMaintenance.tsx).
 */
import type { Attachment, AttachmentSuggestions, Item, ItemPatch, MaintenanceInput, MaintenanceTask, ReceiptLine, Warranty, WarrantyInput } from "@ferret/shared";
import { addDays, addMonths, today } from "@ferret/shared/utils";
import { money } from "./lib/money";
import { FileThumb } from "./FileThumb";
import { ReceiptLinesButton } from "./ReceiptLines";
import { flattenCategories, useCategories } from "./Catalog";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

type Field = "name" | "brand" | "model" | "serialNumber" | "barcode" | "purchaseDate" | "purchasePriceCents" | "returnBy" | "categoryId";

const fields: { key: Field; label: MessageDescriptor; format?: (v: string | number) => string }[] = [
  { key: "name", label: msg`Name` },
  { key: "brand", label: msg`Brand` },
  { key: "model", label: msg`Model` },
  { key: "serialNumber", label: msg`Serial` },
  { key: "barcode", label: msg`Barcode` },
  { key: "purchaseDate", label: msg`Purchased` },
  { key: "purchasePriceCents", label: msg`Price paid`, format: (v) => money(Number(v), true) },
];

const same = (a: unknown, b: unknown) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Which of a receipt's lines is this thing: the one at its price (or the receipt's), else one sharing its name, else the dearest when its model names it; -1 for none. */
export function receiptLineOf(lines: ReceiptLine[], item: Pick<Item, "name" | "model" | "purchasePriceCents">, s?: AttachmentSuggestions) {
  const at = (price?: number | null) => (price != null ? lines.findIndex((l) => l.priceCents === price) : -1);
  const own = at(item.purchasePriceCents);
  if (own >= 0) return own;
  if (item.name === "New item") return at(s?.purchasePriceCents);
  // Its name before the receipt's price: the receipt's top-level price can be any product's.
  const name = item.name.toLowerCase();
  const byName = lines.findIndex((l) => {
    const line = l.name.toLowerCase();
    return line.includes(name) || name.includes(line);
  });
  if (byName >= 0) return byName;
  const byPrice = at(s?.purchasePriceCents);
  if (byPrice >= 0) return byPrice;
  // "Bambu Lab R1" and its line "R1 Long Material Bundle", model R1: the dearest line, when its model is in this
  // thing's name (or is its model). Only the dearest — an R1's lenses are model R1 too.
  const dearest = lines.reduce((best, l, i) => ((l.priceCents ?? -1) > (lines[best]?.priceCents ?? -1) ? i : best), 0);
  return namesModel(item, lines[dearest]?.model) ? dearest : -1;
}

/** A model ("R1") that's this thing's model, or a whole word of its name. */
export function namesModel(item: Pick<Item, "name"> & { model?: string | null }, model?: string | null) {
  const m = model?.trim().toLowerCase();
  if (!m || m.length < 2) return false;
  if (item.model?.trim().toLowerCase() === m) return true;
  const words = item.name.toLowerCase().split(/[^\p{L}\p{N}-]+/u);
  return words.includes(m);
}

/**
 * For each field, the newest suggestion that differs from what the item already says. `categories`: the household's
 * category paths by id, to offer the category the AI picked (left out without them).
 */
export function pendingSuggestions(item: Item, attachments: Attachment[], warranties: Warranty[] = [], tasks: MaintenanceTask[] = [], categories?: Map<string, string>) {
  // A receipt with several products says nothing about this thing as a whole: its line does (brand, model, price,
  // category), when one of them is this thing; the receipt's day and return window still hold.
  const sugg = (a: Attachment): AttachmentSuggestions => {
    const s = a.analysis!.suggestions;
    if (!s.lines?.length) return s;
    const line = s.lines[receiptLineOf(s.lines, item, s)];
    const { name: _, brand: _b, model: _m, purchasePriceCents: _p, categoryId: _c, ...rest } = s;
    return { ...rest, ...(line && { brand: line.brand, model: line.model, purchasePriceCents: line.priceCents, categoryId: line.categoryId }) };
  };
  const sources = attachments
    .filter((a) => a.analysisStatus === "done" && a.analysis && !a.suggestionsDismissedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Each with the file it was read from, shown beside it.
  const rows: { key: Field; label: string; value: string | number; display: string; source?: Attachment }[] = [];
  // Several files of one thing (its front, its label, its receipt): each field from the file that read it plainly, then
  // from the one that read the most — the label's "Cordless drill" over the front's "Tool" — then the newest.
  const richness = (a: Attachment) => Object.keys(sugg(a)).length;
  const plainly = (a: Attachment, key: string) => (sugg(a).sure ?? []).includes(key === "purchasePriceCents" ? "purchasePrice" : key);
  const best = (key: Field) =>
    sources
      .filter((a) => sugg(a)[key] != null)
      .sort((a, b) => Number(plainly(b, key)) - Number(plainly(a, key)) || richness(b) - richness(a))[0];
  for (const field of fields) {
    const source = best(field.key);
    const value = (source && sugg(source))?.[field.key];
    if (value == null || same(item[field.key], value)) continue;
    rows.push({ key: field.key, label: t(field.label), value, display: field.format?.(value) ?? String(value), source });
  }

  // The category the AI picked: one of the household's, while the thing has another (or none).
  const sorted = categories && sources.find((a) => categories.has(sugg(a).categoryId ?? ""));
  const categoryId = (sorted && sugg(sorted))?.categoryId;
  if (categoryId && categoryId !== item.categoryId) {
    rows.push({ key: "categoryId", label: t`Category`, value: categoryId, display: categories!.get(categoryId)!, source: sorted });
  }

  // A return window from a receipt: the date it prints, else its days from the purchase date — while it's still open.
  const printedIn = sources.find((a) => sugg(a).returnBy);
  const printed = (printedIn && sugg(printedIn))?.returnBy;
  const window = sources.find((a) => sugg(a).returnDays);
  const boughtOn = item.purchaseDate ?? sources.map(sugg).find((x) => x.purchaseDate)?.purchaseDate;
  const returnBy = printed ?? (window && boughtOn ? addDays(boughtOn, sugg(window).returnDays!) : undefined);
  if (returnBy && returnBy >= today() && returnBy !== item.returnBy) {
    rows.push({ key: "returnBy", label: t`Return by`, value: returnBy, display: new Date(`${returnBy}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }), source: printed ? printedIn : window });
  }

  // Warranty terms run from the purchase date: the item's, or one read from a receipt.
  const terms = sources.find((a) => sugg(a).warrantyMonths);
  let warranty: { input?: WarrantyInput; display: string; needsDate: boolean; source?: Attachment } | undefined;
  if (terms) {
    const { warrantyMonths: months, warrantyProvider: provider } = sugg(terms);
    const purchased = item.purchaseDate ?? sources.map(sugg).find((x) => x.purchaseDate)?.purchaseDate;
    const length = months! % 12 === 0 ? plural(months! / 12, { one: "# year", other: "# years" }) : plural(months!, { one: "# month", other: "# months" });
    if (purchased) {
      const endsOn = addMonths(purchased, months!);
      const already = warranties.some((w) => w.endsOn === endsOn);
      if (!already) {
        warranty = {
          input: { provider, startsOn: purchased, endsOn, attachmentId: terms.id },
          display: provider ? t`${ph({ length })} (${ph({ provider })}) — until ${ph({ endsOn })}` : t`${ph({ length })} — until ${ph({ endsOn })}`,
          needsDate: false,
          source: terms,
        };
      }
    } else {
      warranty = { display: `${length}${provider ? ` (${provider})` : ""}`, needsDate: true, source: terms };
    }
  }
  // A receipt with other things on it, not handled yet.
  const receipt = sources.find((a) => sugg(a).lines?.length && !sugg(a).linesHandled);
  return { rows, warranty, sources, receipt };
}

export function Suggestions(props: {
  householdId: string;
  item: Item;
  attachments: Attachment[];
  warranties: Warranty[];
  tasks: MaintenanceTask[];
  onApply: (patch: ItemPatch) => void;
  onAddWarranty: (input: WarrantyInput) => void;
  onAddTask: (input: MaintenanceInput) => void;
  onDismiss: (attachmentIds: string[]) => void;
  busy: boolean;
}) {
  const categories = useCategories(props.householdId);
  const paths = new Map(flattenCategories(categories.data ?? []).map((c) => [c.id, c.path]));
  const { rows, warranty, sources, receipt } = pendingSuggestions(props.item, props.attachments, props.warranties, props.tasks, paths);
  if (rows.length === 0 && !warranty && !receipt) return null;
  const all = Object.fromEntries(rows.map((r) => [r.key, r.value])) as ItemPatch;

  return (
    <section className="card border border-primary/20" aria-label={t`Suggestions from your files`}>
      <div className="card-body gap-3 p-4">
        <h2 className="text-base-content flex items-center gap-2 font-semibold">
          <span className="icon-[tabler--sparkles] text-primary size-5" />
          <Trans>Suggestions from your files</Trans>
        </h2>
        <ul className="divide-base-content/10 flex flex-col divide-y">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 py-2">
              <span className="text-base-content/70 w-20 shrink-0 text-sm">{r.label}</span>
              {r.source && <FileThumb attachmentId={r.source.id} filename={r.source.filename} />}
              <span className="text-base-content min-w-0 flex-1 truncate font-medium">{r.display}</span>
              <button
                type="button"
                className="btn btn-text btn-primary btn-sm"
                disabled={props.busy}
                onClick={() => props.onApply({ [r.key]: r.value } as ItemPatch)}
                aria-label={t`Apply ${ph({ label: r.label })}: ${ph({ display: r.display })}`}
              >
                <Trans>Apply</Trans>
              </button>
            </li>
          ))}
          {warranty && (
            <li className="flex items-center gap-3 py-2">
              <Trans><span className="text-base-content/70 w-20 shrink-0 text-sm">Warranty</span></Trans>
              {warranty.source && <FileThumb attachmentId={warranty.source.id} filename={warranty.source.filename} />}
              <span className="min-w-0 flex-1">
                <span className="text-base-content block truncate font-medium">{warranty.display}</span>
                {warranty.needsDate && (
                  <span className="text-base-content/70 text-xs"><Trans>Add the purchase date to work out when it ends.</Trans></span>
                )}
              </span>
              <button
                type="button"
                className="btn btn-text btn-primary btn-sm"
                disabled={props.busy || !warranty.input}
                onClick={() => warranty.input && props.onAddWarranty(warranty.input)}
                aria-label={t`Add warranty: ${ph({ display: warranty.display })}`}
              >
                <Trans>Add</Trans>
              </button>
            </li>
          )}
        </ul>
        {receipt && (
          <div className="flex items-center gap-3">
            <FileThumb attachmentId={receipt.id} filename={receipt.filename} />
            <ReceiptLinesButton item={props.item} receipt={receipt} householdId={props.householdId} />
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="btn btn-text btn-sm"
            disabled={props.busy}
            onClick={() => props.onDismiss(sources.map((s) => s.id))}
          >
            <Trans>Dismiss</Trans>
          </button>
          {rows.length > 1 && (
            <button type="button" className="btn btn-primary btn-sm" disabled={props.busy} onClick={() => props.onApply(all)}>
              <Trans>Apply all</Trans>
            </button>
          )}
        </div>
        <p className="text-base-content/70 text-xs"><Trans>Read by AI from your photos and documents — check before applying.</Trans></p>
      </div>
    </section>
  );
}
