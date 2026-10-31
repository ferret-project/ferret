/**
 * "From the barcode": what the online product database says about an item's
 * barcode — name, brand, model, a typical price, and its photos — offered with
 * Apply / "Use this photo" (nothing changes until someone taps). Same look as
 * the Suggestions card.
 */
import type { ItemListing, ItemPatch } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { money } from "./Overview";

export function ProductSuggestions({ item, householdId }: { item: ItemListing; householdId: string }) {
  const qc = useQueryClient();
  const key = ["product", householdId, item.id, item.barcode];
  const product = useQuery({
    queryKey: key,
    queryFn: () => api.itemProduct(item.id),
    enabled: Boolean(item.barcode),
    // The lookup runs in the background: check back while it does.
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 3000 : false),
  });
  const refreshItem = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["item", householdId, item.id] }),
      qc.invalidateQueries({ queryKey: ["items", householdId] }),
    ]);
  const apply = useMutation({ mutationFn: (patch: ItemPatch) => api.updateItem(item.id, patch), onSuccess: refreshItem });
  const [usingPhoto, setUsingPhoto] = useState<number | null>(null);
  const photo = useMutation({
    mutationFn: (index: number) => api.useProductPhoto(item.id, index),
    onMutate: (index) => setUsingPhoto(index),
    onSettled: () => setUsingPhoto(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attachments", householdId, item.id] }),
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissProduct(item.id), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });

  if (product.data?.status === "pending") {
    return (
      <p className="flex items-center gap-2 text-sm text-base-content/70">
        <span className="loading loading-spinner loading-xs text-primary" />
        Looking up barcode {item.barcode}…
      </p>
    );
  }
  const p = product.data?.status === "found" ? product.data.product : undefined;
  if (!p) return null;

  const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const rows: { label: string; display: string; patch: ItemPatch }[] = [
    !same(item.name, p.title) && { label: "Name", display: p.title, patch: { name: p.title } },
    p.brand && !same(item.brand, p.brand) && { label: "Brand", display: p.brand, patch: { brand: p.brand } },
    p.model && !same(item.model, p.model) && { label: "Model", display: p.model, patch: { model: p.model } },
    p.typicalPriceCents && item.valueCents == null && { label: "Worth", display: `${money(p.typicalPriceCents)} (typical price)`, patch: { valueCents: p.typicalPriceCents } },
    p.description && !item.description && { label: "About", display: p.description, patch: { description: p.description } },
  ].filter(Boolean) as { label: string; display: string; patch: ItemPatch }[];
  if (!rows.length && !p.images.length) return null;
  const busy = apply.isPending || photo.isPending || dismiss.isPending;

  return (
    <section className="card border border-primary/20" aria-label="From the barcode">
      <div className="card-body gap-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--barcode] size-5 text-primary" />
          From the barcode
        </h2>
        {rows.length > 0 && (
          <ul className="flex flex-col divide-y divide-base-content/10">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-3 py-2">
                <span className="w-16 shrink-0 text-sm text-base-content/70">{r.label}</span>
                <span className="line-clamp-2 min-w-0 flex-1 font-medium text-base-content">{r.display}</span>
                <button type="button" className="btn btn-text btn-primary btn-sm" disabled={busy} onClick={() => apply.mutate(r.patch)}>
                  Apply
                </button>
              </li>
            ))}
          </ul>
        )}
        {p.images.length > 0 && (
          <div>
            <p className="mb-2 text-sm text-base-content/70">Product photos — tap one to add it</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {p.images.slice(0, 6).map((src, i) => (
                <button
                  key={src}
                  type="button"
                  className="relative size-20 shrink-0 overflow-hidden rounded-field border border-base-content/10 bg-white"
                  disabled={busy}
                  onClick={() => photo.mutate(i)}
                  aria-label={`Use product photo ${i + 1}`}
                >
                  <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-contain" />
                  {usingPhoto === i && <span className="loading loading-spinner loading-sm absolute inset-0 m-auto text-primary" />}
                </button>
              ))}
            </div>
          </div>
        )}
        {(apply.isError || photo.isError) && <p className="text-sm text-error">{apply.error?.message ?? photo.error?.message}</p>}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-base-content/70">From {p.source} — check before applying.</p>
          <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => dismiss.mutate()}>
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
