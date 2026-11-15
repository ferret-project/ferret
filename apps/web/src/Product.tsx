/**
 * "From the barcode": what the online product database says about an item's
 * barcode — name, brand, model, a typical price, and its photos — offered with
 * Apply / "Use this photo" (nothing changes until someone taps). Same look as
 * the Suggestions card.
 */
import type { ItemListing, ItemPatch } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { money } from "./lib/money";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

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
        <Trans>Looking up barcode {ph({ barcode: item.barcode ?? "" })}…</Trans>
      </p>
    );
  }
  const p = product.data?.status === "found" ? product.data.product : undefined;
  if (!p) return null;

  const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const rows: { label: string; display: string; patch: ItemPatch }[] = [
    !same(item.name, p.title) && { label: t`Name`, display: p.title, patch: { name: p.title } },
    p.brand && !same(item.brand, p.brand) && { label: t`Brand`, display: p.brand, patch: { brand: p.brand } },
    p.model && !same(item.model, p.model) && { label: t`Model`, display: p.model, patch: { model: p.model } },
    p.typicalPriceCents && item.valueCents == null && { label: t`Worth`, display: t`${ph({ price: money(p.typicalPriceCents) })} (typical price)`, patch: { valueCents: p.typicalPriceCents } },
    p.description && !item.description && { label: t`About`, display: p.description, patch: { description: p.description } },
  ].filter(Boolean) as { label: string; display: string; patch: ItemPatch }[];
  if (!rows.length && !p.images.length) return null;
  const busy = apply.isPending || photo.isPending || dismiss.isPending;

  return (
    <section className="card border border-primary/20" aria-label={t`From the barcode`}>
      <div className="card-body gap-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--barcode] size-5 text-primary" />
          <Trans>From the barcode</Trans>
        </h2>
        {rows.length > 0 && (
          <ul className="flex flex-col divide-y divide-base-content/10">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-3 py-2">
                <span className="w-16 shrink-0 text-sm text-base-content/70">{r.label}</span>
                <span className="line-clamp-2 min-w-0 flex-1 font-medium text-base-content">{r.display}</span>
                <button type="button" className="btn btn-text btn-primary btn-sm" disabled={busy} onClick={() => apply.mutate(r.patch)}>
                  <Trans>Apply</Trans>
                </button>
              </li>
            ))}
          </ul>
        )}
        {p.images.length > 0 && (
          <div>
            <p className="mb-2 text-sm text-base-content/70"><Trans>Product photos — tap one to add it</Trans></p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {p.images.slice(0, 6).map((src, i) => (
                <button
                  key={src}
                  type="button"
                  className="relative size-20 shrink-0 overflow-hidden rounded-field border border-base-content/10 bg-white"
                  disabled={busy}
                  onClick={() => photo.mutate(i)}
                  aria-label={t`Use product photo ${ph({ number: i + 1 })}`}
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
          <p className="text-xs text-base-content/70"><Trans>From {ph({ source: p.source })} — check before applying.</Trans></p>
          <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => dismiss.mutate()}>
            <Trans>Dismiss</Trans>
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * "From the VIN": what NHTSA's decoder says about a vehicle's VIN (server: lib/vehicles.ts) — a name like "2003 Honda
 * Accord EX-V6", its make and model to apply with a tap, and what else it said (body, engine, drive). Looked up in the
 * background; the item is fetched again until the answer is in.
 */
export function VehicleSuggestions({ item, householdId }: { item: ItemListing; householdId: string }) {
  const qc = useQueryClient();
  const itemKey = ["item", householdId, item.id];
  const refreshItem = () => Promise.all([qc.invalidateQueries({ queryKey: itemKey }), qc.invalidateQueries({ queryKey: ["items", householdId] })]);
  const apply = useMutation({ mutationFn: (patch: ItemPatch) => api.updateItem(item.id, patch), onSuccess: refreshItem });
  const v = item.vehicle;
  const pending = v?.status === "pending";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: itemKey }), 3000);
    const stop = setTimeout(() => clearInterval(timer), 2 * 60 * 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, item.id]);

  if (!v) return null;
  if (pending) {
    return (
      <p className="flex items-center gap-2 text-sm text-base-content/70">
        <span className="loading loading-spinner loading-xs text-primary" />
        <Trans>Reading VIN {ph({ vin: v.vin })}…</Trans>
      </p>
    );
  }
  if (v.status === "unknown") {
    return <p className="text-sm text-base-content/70"><Trans>NHTSA couldn't read VIN {ph({ vin: v.vin })} — check it for a typo.</Trans></p>;
  }

  const same = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  const rows: { label: string; display: string; patch: ItemPatch }[] = [
    title && !same(item.name, title) && { label: t`Name`, display: title, patch: { name: title } },
    v.make && !same(item.brand, v.make) && { label: t`Brand`, display: v.make, patch: { brand: v.make } },
    v.model && !same(item.model, v.model) && { label: t`Model`, display: v.model, patch: { model: v.model } },
  ].filter(Boolean) as { label: string; display: string; patch: ItemPatch }[];
  const facts = [v.body, v.engine, v.drive].filter(Boolean).join(" · ");

  return (
    <section className="card border border-primary/20" aria-label={t`From the VIN`}>
      <div className="card-body gap-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--car] size-5 text-primary" />
          <Trans>From the VIN</Trans>
        </h2>
        <p className="text-sm text-base-content/80">
          <span className="font-medium text-base-content">{title}</span>
          {facts && <span className="block text-base-content/70">{facts}</span>}
        </p>
        {rows.length > 0 && (
          <ul className="flex flex-col divide-y divide-base-content/10">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-3 py-2">
                <span className="w-16 shrink-0 text-sm text-base-content/70">{r.label}</span>
                <span className="line-clamp-2 min-w-0 flex-1 font-medium text-base-content">{r.display}</span>
                <button type="button" className="btn btn-text btn-primary btn-sm" disabled={apply.isPending} onClick={() => apply.mutate(r.patch)}>
                  <Trans>Apply</Trans>
                </button>
              </li>
            ))}
          </ul>
        )}
        {apply.isError && <p className="text-sm text-error">{apply.error.message}</p>}
        <p className="text-xs text-base-content/70"><Trans>From NHTSA's VIN decoder ({ph({ vin: v.vin })}) — check before applying.</Trans></p>
      </div>
    </section>
  );
}
