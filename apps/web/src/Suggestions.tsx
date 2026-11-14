/**
 * "Suggestions from your photos": item fields and warranty terms the model read off photos, receipts and warranty
 * cards. Nothing changes until someone taps Apply or Add (unless the household lets AI fill in — AiFill.tsx).
 * Maintenance schedules from manuals are in Suggested maintenance (SuggestedMaintenance.tsx).
 */
import type { Attachment, Item, ItemPatch, MaintenanceInput, MaintenanceTask, Warranty, WarrantyInput } from "@ferret/shared";
import { addDays, addMonths, today } from "@ferret/shared/utils";
import { money } from "./lib/money";
import { FileThumb } from "./FileThumb";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

type Field = "name" | "brand" | "model" | "serialNumber" | "barcode" | "purchaseDate" | "purchasePriceCents" | "returnBy";

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

/** For each field, the newest suggestion that differs from what the item already says. */
export function pendingSuggestions(item: Item, attachments: Attachment[], warranties: Warranty[] = [], tasks: MaintenanceTask[] = []) {
  const sources = attachments
    .filter((a) => a.analysisStatus === "done" && a.analysis && !a.suggestionsDismissedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Each with the file it was read from, shown beside it.
  const rows: { key: Field; label: string; value: string | number; display: string; source?: Attachment }[] = [];
  for (const field of fields) {
    const source = sources.find((a) => a.analysis!.suggestions[field.key] != null);
    const value = source?.analysis!.suggestions[field.key];
    if (value == null || same(item[field.key], value)) continue;
    rows.push({ key: field.key, label: t(field.label), value, display: field.format?.(value) ?? String(value), source });
  }

  // A return window from a receipt: the date it prints, else its days from the purchase date — while it's still open.
  const printedIn = sources.find((a) => a.analysis!.suggestions.returnBy);
  const printed = printedIn?.analysis!.suggestions.returnBy;
  const window = sources.find((a) => a.analysis!.suggestions.returnDays);
  const boughtOn = item.purchaseDate ?? sources.find((a) => a.analysis!.suggestions.purchaseDate)?.analysis!.suggestions.purchaseDate;
  const returnBy = printed ?? (window && boughtOn ? addDays(boughtOn, window.analysis!.suggestions.returnDays!) : undefined);
  if (returnBy && returnBy >= today() && returnBy !== item.returnBy) {
    rows.push({ key: "returnBy", label: t`Return by`, value: returnBy, display: new Date(`${returnBy}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }), source: printed ? printedIn : window });
  }

  // Warranty terms run from the purchase date: the item's, or one read from a receipt.
  const terms = sources.find((a) => a.analysis!.suggestions.warrantyMonths);
  let warranty: { input?: WarrantyInput; display: string; needsDate: boolean; source?: Attachment } | undefined;
  if (terms) {
    const { warrantyMonths: months, warrantyProvider: provider } = terms.analysis!.suggestions;
    const purchased = item.purchaseDate ?? sources.find((a) => a.analysis!.suggestions.purchaseDate)?.analysis!.suggestions.purchaseDate;
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
  return { rows, warranty, sources };
}

export function Suggestions(props: {
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
  const { rows, warranty, sources } = pendingSuggestions(props.item, props.attachments, props.warranties);
  if (rows.length === 0 && !warranty) return null;
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
