/**
 * "Also on this receipt" (server: lib/receipt-lines.ts): a receipt with several things on it lists the others, and
 * each one ticked becomes a thing of its own — bought the same day at its own price, where this thing is (or another
 * place), in the category the AI picked, with a copy of the receipt. The line that's probably this thing starts
 * unticked. Names, how many and prices can be corrected first; nothing is added until Add.
 */
import type { Attachment, Item, ReceiptLine } from "@ferret/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { flattenCategories, useCategories } from "./Catalog";
import { PlacePicker } from "./Combobox";
import { DialogActions, Modal } from "./Modal";
import { receiptLineOf } from "./Suggestions";
import { api } from "./lib/api";
import { currencySymbol, money, toCents } from "./lib/money";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

type Row = ReceiptLine & { key: number; ticked: boolean; price: string; thisOne: boolean };

/** The line that's this thing (Suggestions.tsx decides the same way). */
const thisOne = (lines: ReceiptLine[], item: Item, receipt: Attachment) => receiptLineOf(lines, item, receipt.analysis?.suggestions);
/** The receipt photographed on its own: its thing is an unnamed "New item", which the first line ticked becomes. */
const unnamed = (item: Item) => item.name === "New item";

export function ReceiptLinesButton({ item, receipt, householdId }: { item: Item; receipt: Attachment; householdId: string }) {
  const [open, setOpen] = useState(false);
  const lines = receipt.analysis?.suggestions.lines ?? [];
  const others = lines.length - (thisOne(lines, item, receipt) >= 0 ? 1 : 0);
  if (!lines.length) return null;
  return (
    <>
      <button type="button" className="btn btn-soft btn-primary btn-sm btn-wrap" onClick={() => setOpen(true)}>
        <span className="icon-[tabler--receipt] size-4" />
        {unnamed(item)
          ? plural(lines.length, { one: "Add the thing on this receipt…", other: "Add the # things on this receipt…" })
          : plural(others, { one: "Add the other thing on this receipt…", other: "Add the # other things on this receipt…" })}
      </button>
      {open && <ReceiptLinesDialog item={item} receipt={receipt} householdId={householdId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReceiptLinesDialog({ item, receipt, householdId, onClose }: { item: Item; receipt: Attachment; householdId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const categories = useCategories(householdId);
  const paths = new Map(flattenCategories(categories.data ?? []).map((c) => [c.id, c.path]));
  const lines = receipt.analysis?.suggestions.lines ?? [];
  const mine = thisOne(lines, item, receipt);
  // A named thing already is its line, so that one starts unticked. An unnamed "New item" becomes the first line ticked,
  // so every line starts ticked and its own line goes first — otherwise the next line would take its place and its own
  // (often the dearest) would never be added.
  const [rows, setRows] = useState<Row[]>(() => {
    const all = lines.map((l, key) => ({
      ...l,
      key,
      ticked: unnamed(item) || key !== mine,
      thisOne: key === mine,
      price: l.priceCents != null ? (l.priceCents / 100).toFixed(2) : "",
    }));
    return unnamed(item) && mine > 0 ? [all[mine]!, ...all.filter((r) => r.key !== mine)] : all;
  });
  const [place, setPlace] = useState<string | null>(item.locationId ?? null);
  const change = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const ticked = rows.filter((r) => r.ticked && r.name.trim());
  const refresh = async () => {
    for (const k of ["items", "places", "overview", "to-confirm"]) await qc.invalidateQueries({ queryKey: [k, householdId] });
    await qc.invalidateQueries({ queryKey: ["attachments", householdId, item.id] });
    await qc.invalidateQueries({ queryKey: ["item", householdId, item.id] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.addReceiptLines(receipt.id, {
        locationId: place,
        intoItem: unnamed(item),
        lines: ticked.map((r) => ({ name: r.name.trim(), brand: r.brand ?? null, model: r.model ?? null, quantity: r.quantity, priceCents: toCents(r.price), categoryId: r.categoryId ?? null })),
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissReceiptLines(receipt.id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  return (
    <Modal id="receipt-lines" title={t`On this receipt`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ticked.length) add.mutate();
        }}
      >
        <p className="text-base-content/70 text-sm">
          {unnamed(item) ? (
            <Trans>Each one ticked becomes a thing, bought the same day, with the receipt — the first one this "New item". Check what AI read first.</Trans>
          ) : (
            <Trans>Each one ticked becomes a thing of its own, bought the same day, with a copy of the receipt. Check what AI read first.</Trans>
          )}
        </p>
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-3 rounded-box border border-base-content/10 p-3">
              <input
                type="checkbox"
                className="checkbox checkbox-primary mt-2.5"
                checked={r.ticked}
                onChange={(e) => change(r.key, { ticked: e.target.checked })}
                aria-label={t`Add ${ph({ name: r.name })}`}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <input className="input" value={r.name} maxLength={200} onChange={(e) => change(r.key, { name: e.target.value })} aria-label={t`Name`} />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="input w-24">
                    <span className="text-base-content/70 my-auto me-1 text-sm">×</span>
                    <input
                      className="grow"
                      inputMode="numeric"
                      value={r.quantity}
                      onChange={(e) => change(r.key, { quantity: Math.max(1, Number.parseInt(e.target.value, 10) || 1) })}
                      aria-label={t`How many`}
                    />
                  </label>
                  <label className="input w-32">
                    <span className="text-base-content/70 my-auto me-1">{currencySymbol()}</span>
                    <input className="grow" inputMode="decimal" value={r.price} onChange={(e) => change(r.key, { price: e.target.value })} aria-label={t`Price each`} />
                  </label>
                </div>
                <p className="text-base-content/70 text-xs">
                  {[r.brand, r.model, r.categoryId && paths.get(r.categoryId)].filter(Boolean).join(" · ")}
                  {r.thisOne && (
                    <span className="badge badge-soft badge-sm ms-1">
                      <Trans>Probably this thing</Trans>
                    </span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <PlacePicker householdId={householdId} id="receipt-lines-place" name="place" label={t`Where are they?`} value={place} onChange={setPlace} noneLabel={t`Not in a place yet`} />
        {(add.isError || dismiss.isError) && <div className="alert alert-soft alert-error">{(add.error ?? dismiss.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text me-auto" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
            <Trans>Not these</Trans>
          </button>
          <button type="button" className="btn btn-text" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ticked.length || add.isPending}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            {ticked.length ? plural(ticked.length, { one: "Add # thing", other: "Add # things" }) : t`Add`}
            {ticked.length > 0 && ticked.some((r) => toCents(r.price) != null) && (
              <span className="sr-only">{money(ticked.reduce((sum, r) => sum + (toCents(r.price) ?? 0) * r.quantity, 0), true)}</span>
            )}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}
