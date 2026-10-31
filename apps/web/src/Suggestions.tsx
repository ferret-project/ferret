/**
 * "Suggestions from your photos": item fields, warranty terms and maintenance
 * schedules the model read off photos, receipts, warranty cards and manuals.
 * Nothing changes until someone taps Apply or Add.
 */
import type { Attachment, Item, ItemPatch, MaintenanceInput, MaintenanceTask, Warranty, WarrantyInput } from "@ferret/shared";
import { addMonths, describeInterval } from "@ferret/shared/utils";
import { money } from "./Overview";

type Field = "name" | "brand" | "model" | "serialNumber" | "barcode" | "purchaseDate" | "purchasePriceCents";

const fields: { key: Field; label: string; format?: (v: string | number) => string }[] = [
  { key: "name", label: "Name" },
  { key: "brand", label: "Brand" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "barcode", label: "Barcode" },
  { key: "purchaseDate", label: "Purchased" },
  { key: "purchasePriceCents", label: "Price paid", format: (v) => money(Number(v), true) },
];

const same = (a: unknown, b: unknown) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** For each field, the newest suggestion that differs from what the item already says. */
export function pendingSuggestions(item: Item, attachments: Attachment[], warranties: Warranty[] = [], tasks: MaintenanceTask[] = []) {
  const sources = attachments
    .filter((a) => a.analysisStatus === "done" && a.analysis && !a.suggestionsDismissedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows: { key: Field; label: string; value: string | number; display: string }[] = [];
  for (const field of fields) {
    const source = sources.find((a) => a.analysis!.suggestions[field.key] != null);
    const value = source?.analysis!.suggestions[field.key];
    if (value == null || same(item[field.key], value)) continue;
    rows.push({ key: field.key, label: field.label, value, display: field.format?.(value) ?? String(value) });
  }

  // Warranty terms run from the purchase date: the item's, or one read from a receipt.
  const terms = sources.find((a) => a.analysis!.suggestions.warrantyMonths);
  let warranty: { input?: WarrantyInput; display: string; needsDate: boolean } | undefined;
  if (terms) {
    const { warrantyMonths: months, warrantyProvider: provider } = terms.analysis!.suggestions;
    const purchased = item.purchaseDate ?? sources.find((a) => a.analysis!.suggestions.purchaseDate)?.analysis!.suggestions.purchaseDate;
    const length = months! % 12 === 0 ? `${months! / 12} year${months === 12 ? "" : "s"}` : `${months} months`;
    if (purchased) {
      const endsOn = addMonths(purchased, months!);
      const already = warranties.some((w) => w.endsOn === endsOn);
      if (!already) {
        warranty = {
          input: { provider, startsOn: purchased, endsOn, attachmentId: terms.id },
          display: `${length}${provider ? ` (${provider})` : ""} — until ${endsOn}`,
          needsDate: false,
        };
      }
    } else {
      warranty = { display: `${length}${provider ? ` (${provider})` : ""}`, needsDate: true };
    }
  }
  // Maintenance schedules from manuals, unless the item already tracks one by that name.
  const maintenance: (MaintenanceInput & { display: string })[] = [];
  // "Descale" and "Descale the machine" are the same job: either containing the other counts.
  const seen = tasks.map((t) => t.title.trim().toLowerCase());
  const tracked = (title: string) => seen.some((t) => t.includes(title) || title.includes(t));
  for (const source of sources) {
    for (const m of source.analysis!.suggestions.maintenance ?? []) {
      const key = m.title.trim().toLowerCase();
      if (tracked(key)) continue;
      seen.push(key);
      maintenance.push({ ...m, itemId: item.id, attachmentId: source.id, display: `${m.title} — ${describeInterval(m.intervalCount, m.intervalUnit)}` });
    }
  }
  return { rows, warranty, maintenance, sources };
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
  const { rows, warranty, maintenance, sources } = pendingSuggestions(props.item, props.attachments, props.warranties, props.tasks);
  if (rows.length === 0 && !warranty && maintenance.length === 0) return null;
  const all = Object.fromEntries(rows.map((r) => [r.key, r.value])) as ItemPatch;

  return (
    <section className="card border border-primary/20" aria-label="Suggestions from your files">
      <div className="card-body gap-3 p-4">
        <h2 className="text-base-content flex items-center gap-2 font-semibold">
          <span className="icon-[tabler--sparkles] text-primary size-5" />
          Suggestions from your files
        </h2>
        <ul className="divide-base-content/10 flex flex-col divide-y">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 py-2">
              <span className="text-base-content/70 w-20 shrink-0 text-sm">{r.label}</span>
              <span className="text-base-content min-w-0 flex-1 truncate font-medium">{r.display}</span>
              <button
                type="button"
                className="btn btn-text btn-primary btn-sm"
                disabled={props.busy}
                onClick={() => props.onApply({ [r.key]: r.value } as ItemPatch)}
                aria-label={`Apply ${r.label}: ${r.display}`}
              >
                Apply
              </button>
            </li>
          ))}
          {warranty && (
            <li className="flex items-center gap-3 py-2">
              <span className="text-base-content/70 w-20 shrink-0 text-sm">Warranty</span>
              <span className="min-w-0 flex-1">
                <span className="text-base-content block truncate font-medium">{warranty.display}</span>
                {warranty.needsDate && (
                  <span className="text-base-content/70 text-xs">Add the purchase date to work out when it ends.</span>
                )}
              </span>
              <button
                type="button"
                className="btn btn-text btn-primary btn-sm"
                disabled={props.busy || !warranty.input}
                onClick={() => warranty.input && props.onAddWarranty(warranty.input)}
                aria-label={`Add warranty: ${warranty.display}`}
              >
                Add
              </button>
            </li>
          )}
          {maintenance.map(({ display, ...task }) => (
            <li key={task.title} className="flex items-center gap-3 py-2">
              <span className="text-base-content/70 w-20 shrink-0 text-sm">Upkeep</span>
              <span className="text-base-content min-w-0 flex-1 font-medium">{display}</span>
              <button
                type="button"
                className="btn btn-text btn-primary btn-sm"
                disabled={props.busy}
                onClick={() => props.onAddTask(task)}
                aria-label={`Add maintenance: ${display}`}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="btn btn-text btn-sm"
            disabled={props.busy}
            onClick={() => props.onDismiss(sources.map((s) => s.id))}
          >
            Dismiss
          </button>
          {rows.length > 1 && (
            <button type="button" className="btn btn-primary btn-sm" disabled={props.busy} onClick={() => props.onApply(all)}>
              Apply all
            </button>
          )}
        </div>
        <p className="text-base-content/70 text-xs">Read by AI from your photos and documents — check before applying.</p>
      </div>
    </section>
  );
}
