import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * #/duplicates — Possible duplicates (server: lib/duplicates.ts): pairs with the same serial number, the same barcode
 * and name, or descriptions that read nearly the same. Each pair side by side; "Merge…" compares them field by field,
 * picks what to keep, and moves everything onto one (the other goes to Recently deleted). "Not a duplicate" is
 * remembered. Nothing is merged by itself.
 */
import type { DuplicatePair, DuplicateSide, ItemListing } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { money } from "./lib/money";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { BarSearch } from "./Nav";

export function Duplicates({ householdId }: { householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["duplicates", householdId], queryFn: api.duplicates });
  const [merging, setMerging] = useState<DuplicatePair | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["duplicates", householdId] });
    void qc.invalidateQueries({ queryKey: ["attention", householdId] });
    void qc.invalidateQueries({ queryKey: ["items", householdId] });
  };
  const notDup = useMutation({ mutationFn: (p: DuplicatePair) => api.notDuplicate(p.a.id, p.b.id), onSuccess: refresh });
  const pairs = list.data?.data ?? [];
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{translateText("Possible duplicates")}</h1>
          <HelpLink page="guide/ai.html#possible-duplicates" label={translateText("Possible duplicates")} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {list.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {notDup.isError && <div className="alert alert-soft alert-error">{notDup.error.message}</div>}
        {list.data && pairs.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--copy-check] size-10 text-primary" />
              <h2 className="text-lg font-semibold">{translateText("No duplicates found")}</h2>
              <p className="max-w-sm text-sm text-base-content/70">
                {translateText("Things with the same serial number, the same barcode and name, or descriptions that read nearly the same show up here.")}</p>
            </div>
          </div>
        )}
        {pairs.map((p) => (
          <section key={`${p.a.id}|${p.b.id}`} className="card">
            <div className="card-body gap-3 p-4">
              <p className="flex flex-wrap gap-1.5">
                {p.reasons.map((r) => (
                  <span key={r} className="badge badge-soft badge-primary badge-sm">
                    {r}
                  </span>
                ))}
              </p>
              <div className="grid gap-3 @container sm:grid-cols-2">
                <Side side={p.a} />
                <Side side={p.b} />
              </div>
              {canEdit && (
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="btn btn-text btn-sm" disabled={notDup.isPending} onClick={() => notDup.mutate(p)}>
                    {translateText("Not a duplicate")}</button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setMerging(p)}>
                    <span className="icon-[tabler--arrow-merge] size-4" />
                    {translateText("Merge…")}</button>
                </div>
              )}
            </div>
          </section>
        ))}
      </main>
      {merging && (
        <MergeDialog
          pair={merging}
          onClose={() => setMerging(null)}
          onMerged={() => {
            setMerging(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Side({ side }: { side: DuplicateSide }) {
  return (
    <a href={itemHref(side.id)} className="flex gap-3 rounded-box border border-base-content/10 p-3 hover:bg-base-200">
      {side.photoId ? (
        <img src={api.thumbnailUrl(side.photoId)} alt="" className="size-16 shrink-0 rounded-field object-cover" />
      ) : (
        <span className="flex size-16 shrink-0 items-center justify-center rounded-field bg-base-200">
          <span className="icon-[tabler--box] size-6 text-base-content/40" />
        </span>
      )}
      <span className="min-w-0 text-sm">
        <span className="block truncate font-semibold text-base-content">{side.name}</span>
        {(side.brand || side.model) && <span className="block truncate text-base-content/80">{[side.brand, side.model].filter(Boolean).join(" ")}</span>}
        {side.serialNumber && <span className="block truncate text-base-content/70">{tr("Serial {v0}", { v0: side.serialNumber })}</span>}
        {side.place && <span className="block truncate text-base-content/70">{side.place}</span>}
        <span className="block text-base-content/70">{tr("Added {v0}", { v0: new Date(side.createdAt).toLocaleDateString(locale()) })}</span>
      </span>
    </a>
  );
}

/** Fields compared in the merge dialog, and how to show them. */
const FIELDS: { key: keyof ItemListing; label: string; show?: (v: unknown) => string }[] = [
  { key: "name", get label() { return translateText("Name"); } },
  { key: "brand", get label() { return translateText("Brand"); } },
  { key: "model", get label() { return translateText("Model"); } },
  { key: "serialNumber", get label() { return translateText("Serial number"); } },
  { key: "barcode", get label() { return translateText("Barcode"); } },
  { key: "place", get label() { return translateText("Place"); } },
  { key: "category", get label() { return translateText("Category"); } },
  { key: "condition", get label() { return translateText("Condition"); } },
  { key: "purchaseDate", get label() { return translateText("Bought"); } },
  { key: "purchasePriceCents", get label() { return translateText("Price paid"); }, show: (v) => money(Number(v), true) },
  { key: "valueCents", get label() { return translateText("Value"); }, show: (v) => money(Number(v), true) },
  { key: "quantity", get label() { return translateText("Quantity"); } },
  { key: "description", get label() { return translateText("Description"); } },
  { key: "notes", get label() { return translateText("Notes"); } },
];
/** The server's names for the fields where a place or category is shown by name. */
const SERVER_FIELD: Partial<Record<keyof ItemListing, string>> = { place: "locationId", category: "categoryId" };

function MergeDialog({ pair, onClose, onMerged }: { pair: DuplicatePair; onClose: () => void; onMerged: () => void }) {
  const a = useQuery({ queryKey: ["item-for-merge", pair.a.id], queryFn: () => api.getItem(pair.a.id) });
  const b = useQuery({ queryKey: ["item-for-merge", pair.b.id], queryFn: () => api.getItem(pair.b.id) });
  // The one kept: the older by default (its links and labels have been around longest).
  const [keep, setKeep] = useState<"a" | "b">(pair.a.createdAt <= pair.b.createdAt ? "a" : "b");
  const [take, setTake] = useState<Set<string>>(new Set());
  const merge = useMutation({
    mutationFn: () => {
      const [into, from] = keep === "a" ? [pair.a.id, pair.b.id] : [pair.b.id, pair.a.id];
      return api.mergeItems(into, { from, take: [...take].map((k) => SERVER_FIELD[k as keyof ItemListing] ?? k) });
    },
    onSuccess: onMerged,
  });
  const kept = keep === "a" ? a.data : b.data;
  const other = keep === "a" ? b.data : a.data;
  const has = (v: unknown) => v != null && v !== "";
  const differ = kept && other ? FIELDS.filter((f) => has(kept[f.key]) && has(other[f.key]) && String(kept[f.key]) !== String(other[f.key])) : [];
  const fills = kept && other ? FIELDS.filter((f) => !has(kept[f.key]) && has(other[f.key])) : [];
  const shown = (f: (typeof FIELDS)[number], it: ItemListing) => (f.show ? f.show(it[f.key]) : String(it[f.key]));
  return (
    <Modal id="merge" title={translateText("Merge two things")} onClose={onClose}>
      {(a.isPending || b.isPending) && <span className="loading loading-spinner mx-auto my-8 block text-primary" />}
      {(a.isError || b.isError) && <div className="alert alert-soft alert-error">{(a.error ?? b.error)!.message}</div>}
      {kept && other && (
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{translateText("Keep")}</legend>
            {(["a", "b"] as const).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-3">
                <input type="radio" className="radio radio-primary" name="keep" checked={keep === k} onChange={() => (setKeep(k), setTake(new Set()))} />
                <span>
                  {pair[k].name} <span className="text-sm text-base-content/70">{tr("(added {v0})", { v0: new Date(pair[k].createdAt).toLocaleDateString(locale()) })}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {differ.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{translateText("Where they differ, use:")}</p>
              {differ.map((f) => (
                <div key={String(f.key)} className="flex flex-col gap-1 rounded-box border border-base-content/10 p-3">
                  <span className="text-sm text-base-content/70">{f.label}</span>
                  {[false, true].map((fromOther) => (
                    <label key={String(fromOther)} className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="radio"
                        className="radio radio-primary radio-sm mt-0.5"
                        name={`take-${String(f.key)}`}
                        checked={take.has(String(f.key)) === fromOther}
                        onChange={() =>
                          setTake((t) => {
                            const next = new Set(t);
                            if (fromOther) next.add(String(f.key));
                            else next.delete(String(f.key));
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 break-words">{shown(f, fromOther ? other : kept)}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
          {fills.length > 0 && (
            <p className="text-sm text-base-content/70">{tr("From {v0}, filling gaps: {v1}.", { v0: other.name, v1: fills.map((f) => f.label.toLowerCase()).join(", ") })}</p>
          )}
          <p className="text-sm text-base-content/70">{tr("Photos, documents, warranties, maintenance, stock, labels, loans, tags and history all move to the one kept. {v0} goes to Recently deleted, and its old links lead here.", { v0: other.name })}</p>
          {merge.isError && <div className="alert alert-soft alert-error">{merge.error.message}</div>}
          <DialogActions>
            <button type="button" className="btn btn-text" onClick={onClose}>
              {translateText("Cancel")}</button>
            <button type="button" className="btn btn-primary" disabled={merge.isPending} onClick={() => merge.mutate()}>
              {translateText("Merge")}</button>
          </DialogActions>
        </div>
      )}
    </Modal>
  );
}
