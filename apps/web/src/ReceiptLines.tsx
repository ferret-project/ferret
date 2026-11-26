/**
 * "Also on this receipt" (server: lib/receipt-lines.ts): a receipt with several things on it lists the others, and
 * each one ticked becomes a thing of its own — bought the same day at its own price, where this thing is (or another
 * place), in the category the AI picked, with a copy of the receipt. The line that's probably this thing starts
 * unticked, and so does food or drink (groceries aren't usually kept track of), and each one already in Ferret (added from the same order before, or the same product bought then —
 * GET /attachments/{id}/lines). An accessory whose model names a thing (an R1's lens, model R1) starts as a part of
 * it. Names, how many, prices and parts can be corrected first; nothing is added until Add.
 */
import type { Attachment, Item, ReceiptLine } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { flattenCategories, useCategories } from "./Catalog";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { DialogActions, Modal } from "./Modal";
import { namesModel, receiptLineOf } from "./Suggestions";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { currencySymbol, money, toCents } from "./lib/money";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** `ticked` and `partOf` stay undefined until changed: until then what Ferret found decides them. */
type Row = ReceiptLine & { key: number; ticked?: boolean; price: string; thisOne: boolean; partOf?: Choice | null; pickPart?: boolean };

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
  const known = useQuery({ queryKey: ["receipt-lines", householdId, receipt.id], queryFn: () => api.receiptLinesKnown(receipt.id) });
  // What an accessory is for: the machine it's printed as fitting ("R1 / Medium Focal"), else its own model.
  const fitsOf = (l: ReceiptLine) => (l.fits ?? l.model)?.trim() || null;
  // The things each other one names (an H3C's hotends → the H3C): the dearest thing whose model or name it is.
  const models = [...new Set(lines.filter((l, key) => key !== mine && fitsOf(l) && !namesModel(item, fitsOf(l))).map((l) => fitsOf(l)!))];
  const named = useQuery({
    queryKey: ["items", householdId, "receipt-parts", models],
    queryFn: async () => {
      const out = new Map<string, Choice>();
      for (const model of models.slice(0, 20)) {
        const hits = (await api.listItems(model, { limit: 10 })).data.filter((it) => it.id !== item.id && namesModel(it, model));
        const best = hits.sort((a, b) => (b.purchasePriceCents ?? 0) - (a.purchasePriceCents ?? 0))[0];
        if (best) out.set(model.toLowerCase(), { id: best.id, label: best.name });
      }
      return out;
    },
    enabled: models.length > 0,
  });
  // The line that's this thing is "in Ferret" as this thing, not as another.
  const already = (r: Row) => (r.thisOne ? null : (known.data?.lines[r.key] ?? null));
  const ownChoice: Choice = { id: item.id, label: item.name };
  const suggestedPart = (r: Row): Choice | null => {
    const fits = fitsOf(r);
    if (r.thisOne || !fits) return null;
    if (!unnamed(item) && namesModel(item, fits)) return ownChoice;
    return named.data?.get(fits.toLowerCase()) ?? null;
  };
  const partOf = (r: Row) => (r.partOf !== undefined ? r.partOf : suggestedPart(r));
  const isTicked = (r: Row) => r.ticked ?? ((unnamed(item) || r.key !== mine) && !already(r) && !r.food);
  const [rows, setRows] = useState<Row[]>(() => {
    const all = lines.map((l, key) => ({
      ...l,
      key,
      thisOne: key === mine,
      price: l.priceCents != null ? (l.priceCents / 100).toFixed(2) : "",
    }));
    return unnamed(item) && mine > 0 ? [all[mine]!, ...all.filter((r) => r.key !== mine)] : all;
  });
  const [place, setPlace] = useState<string | null>(item.locationId ?? null);
  const change = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const ticked = rows.filter((r) => isTicked(r) && r.name.trim());
  const alreadyCount = rows.filter((r) => already(r)).length;
  const refresh = async () => {
    for (const k of ["items", "places", "overview", "to-confirm", "receipt-lines"]) await qc.invalidateQueries({ queryKey: [k, householdId] });
    await qc.invalidateQueries({ queryKey: ["attachments", householdId, item.id] });
    await qc.invalidateQueries({ queryKey: ["item", householdId, item.id] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.addReceiptLines(receipt.id, {
        locationId: place,
        intoItem: unnamed(item),
        ownLine: !unnamed(item) && mine >= 0 ? { name: lines[mine]!.name, model: lines[mine]!.model ?? null } : null,
        lines: ticked.map((r) => ({ name: r.name.trim(), brand: r.brand ?? null, model: r.model ?? null, quantity: r.quantity, priceCents: toCents(r.price), categoryId: r.categoryId ?? null, partOfItemId: partOf(r)?.id ?? null, barcode: r.barcode ?? null })),
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
        {known.data?.order && (
          <div className="alert alert-soft alert-warning" role="status">
            <span className="icon-[tabler--copy-check] size-5 shrink-0" />
            <span>
              {plural(known.data.order.things, {
                one: `# thing from order ${ph({ number: known.data.order.number })} was already added, on ${ph({ day: new Date(known.data.order.addedAt).toLocaleDateString() })}.`,
                other: `# things from order ${ph({ number: known.data.order.number })} were already added, on ${ph({ day: new Date(known.data.order.addedAt).toLocaleDateString() })}.`,
              })}
            </span>
          </div>
        )}
        {alreadyCount > 0 && (
          <p className="text-sm">
            {plural(alreadyCount, { one: "# of them is probably in Ferret already, so it isn't ticked.", other: "# of them are probably in Ferret already, so they aren't ticked." })}
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.key} className="flex items-start gap-3 rounded-box border border-base-content/10 p-3">
              <input
                type="checkbox"
                className="checkbox checkbox-primary mt-2.5"
                checked={isTicked(r)}
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
                {r.food && !already(r) && (
                  <p className="text-base-content/70 text-sm">
                    <span className="icon-[tabler--apple] me-1 size-4 align-[-3px]" />
                    <Trans>Food or drink, so it isn't ticked</Trans>
                  </p>
                )}
                {already(r) && (
                  <p className="text-sm">
                    <span className="icon-[tabler--copy-check] me-1 size-4 align-[-3px]" />
                    <Trans>
                      Already in Ferret:{" "}
                      <a className="link link-primary tap" href={itemHref(already(r)!.id)} target="_blank" rel="noreferrer">
                        {already(r)!.name}
                      </a>
                    </Trans>
                  </p>
                )}
                {isTicked(r) && !r.thisOne && (partOf(r) || r.pickPart ? (
                  r.pickPart ? (
                    <ItemPicker
                      householdId={householdId}
                      id={`receipt-line-part-${r.key}`}
                      name={`part-${r.key}`}
                      label={t`Part of`}
                      value={partOf(r)}
                      onChange={(choice) => change(r.key, { partOf: choice, pickPart: !choice })}
                      noneLabel={t`Not a part of anything`}
                    />
                  ) : (
                    <p className="flex flex-wrap items-center gap-1 text-sm">
                      <Trans>Part of {ph({ thing: partOf(r)!.label })}</Trans>
                      <button type="button" className="btn btn-text btn-xs tap" onClick={() => change(r.key, { pickPart: true })}>
                        <Trans>Change</Trans>
                      </button>
                      <button type="button" className="btn btn-text btn-xs tap" onClick={() => change(r.key, { partOf: null })}>
                        <Trans>Not a part</Trans>
                      </button>
                    </p>
                  )
                ) : (
                  <button type="button" className="btn btn-text btn-xs tap self-start" onClick={() => change(r.key, { pickPart: true })}>
                    <span className="icon-[tabler--puzzle] size-4" />
                    <Trans>Part of…</Trans>
                  </button>
                ))}
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
