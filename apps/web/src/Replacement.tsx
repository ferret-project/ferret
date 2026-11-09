import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * An item's replacement cost (AI-3; server: lib/replacement.ts): what a person set, and the AI's estimate — always
 * labelled an estimate, with its reasoning, applied only by a tap. The insurance report shows the replacement cost
 * beside the value.
 */
import type { ItemListing } from "@ferret/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { useFeatures } from "./lib/features";
import { money } from "./lib/money";

export function ReplacementCard({ item, householdId }: { item: ItemListing; householdId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const features = useFeatures();
  const estimate = item.replacementEstimate;
  const [waitingSince, setWaitingSince] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["item", householdId, item.id] });
  const ask = useMutation({
    mutationFn: () => api.estimateReplacement(item.id),
    onSuccess: () => setWaitingSince(estimate?.at ?? ""),
  });
  const apply = useMutation({
    mutationFn: (cents: number) => api.updateItem(item.id, { replacementCents: cents }),
    onSuccess: (updated) => qc.setQueryData(["item", householdId, item.id], (old: ItemListing | undefined) => (old ? { ...old, ...updated } : old)),
  });
  // Waiting for the job: look again every few seconds (up to two minutes).
  const waiting = waitingSince !== null && (estimate?.at ?? "") === waitingSince;
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => void refresh(), 3000);
    const stop = setTimeout(() => setWaitingSince(null), 120_000);
    return () => (clearInterval(tick), clearTimeout(stop));
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  const offer = canEdit && features?.textAi && !item.isContainer;
  if (item.replacementCents == null && !estimate && !offer) return null;
  if (item.replacementCents == null && !estimate && !waiting) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn btn-text btn-sm" disabled={ask.isPending} onClick={() => ask.mutate()}>
          <span className="icon-[tabler--sparkles] size-4 text-primary" />
          {translateText("Estimate replacement cost")}</button>
        {ask.isError && <span className="text-error">{ask.error.message}</span>}
      </div>
    );
  }
  const fresh = estimate && estimate.cents > 0 && estimate.cents !== item.replacementCents;
  return (
    <section className="card" aria-labelledby="replacement-title">
      <div className="card-body gap-2 p-4">
        <h2 id="replacement-title" className="flex items-center gap-2 font-semibold">
          <span className="icon-[tabler--receipt-2] size-5 text-primary" />
          {translateText("Replacement cost")}</h2>
        {item.replacementCents != null && (
          <p>
            <span className="font-medium">{money(item.replacementCents, true)}</span> <span className="text-sm text-base-content/70">{translateText("to replace it new")}</span>
          </p>
        )}
        {waiting && (
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" /> {translateText("Estimating…")}</p>
        )}
        {!waiting && estimate && (
          <div className="rounded-box bg-base-200 p-3 text-sm">
            {estimate.cents > 0 && (
              <p>{tr("{v0}about {v1}", { v0: <span className="badge badge-soft badge-primary badge-sm me-1">{translateText("AI estimate")}</span>, v1: <span className="font-medium">{money(estimate.cents)}</span> })}</p>
            )}
            {estimate.reasoning && <p className="mt-1 text-base-content/70">{estimate.reasoning}</p>}
            <p className="mt-1 text-xs text-base-content/70">{translateText("An estimate — check a current price before relying on it.")}</p>
          </div>
        )}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {fresh && (
              <button type="button" className="btn btn-primary btn-sm" disabled={apply.isPending} onClick={() => apply.mutate(estimate.cents)}>{tr("Use {v0}", { v0: money(estimate.cents) })}</button>
            )}
            {offer && !waiting && (
              <button type="button" className="btn btn-text btn-sm" disabled={ask.isPending} onClick={() => ask.mutate()}>
                <span className="icon-[tabler--sparkles] size-4" />
                {estimate ? translateText("Estimate again") : translateText("Estimate")}
              </button>
            )}
          </div>
        )}
        {(ask.error ?? apply.error) && <div className="alert alert-soft alert-error text-sm">{(ask.error ?? apply.error)!.message}</div>}
      </div>
    </section>
  );
}
