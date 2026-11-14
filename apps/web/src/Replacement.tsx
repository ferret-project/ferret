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
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/**
 * `place`: the item page shows it in two places — "top" once there's a cost or an estimate to show, "bottom" until then
 * (the button to ask, and what came of asking from there, so the answer appears where it was asked: `onAsk`).
 */
export function ReplacementCard({
  item,
  householdId,
  place,
  askedHere,
  onAsk,
}: {
  item: ItemListing;
  householdId: string;
  place: "top" | "bottom";
  /** Asked from the bottom in this visit: the bottom one keeps showing it, the top one stays out of the way. */
  askedHere: boolean;
  onAsk?: () => void;
}) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const features = useFeatures();
  const estimate = item.replacementEstimate;
  const [waitingSince, setWaitingSince] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["item", householdId, item.id] });
  const ask = useMutation({
    mutationFn: () => api.estimateReplacement(item.id),
    onSuccess: () => {
      setWaitingSince(estimate?.at ?? "");
      onAsk?.();
    },
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
  const hasSome = item.replacementCents != null || Boolean(estimate);
  if (place === "top" ? !hasSome || askedHere : hasSome && !askedHere) return null;
  if (item.replacementCents == null && !estimate && !waiting) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn btn-text btn-sm" disabled={ask.isPending} onClick={() => ask.mutate()}>
          <span className="icon-[tabler--sparkles] size-4 text-primary" />
          <Trans>Estimate replacement cost</Trans>
        </button>
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
          <Trans>Replacement cost</Trans>
        </h2>
        {item.replacementCents != null && (
          <p>
            <span className="font-medium">{money(item.replacementCents, true)}</span> <Trans><span className="text-sm text-base-content/70">to replace it new</span></Trans>
          </p>
        )}
        {waiting && (
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" /> <Trans>Estimating…</Trans>
          </p>
        )}
        {!waiting && estimate && (
          <div className="rounded-box bg-base-200 p-3 text-sm">
            {estimate.cents > 0 && (
              <p>
                <Trans><span className="badge badge-soft badge-primary badge-sm me-1">AI estimate</span>
                about</Trans> <span className="font-medium">{money(estimate.cents)}</span>
              </p>
            )}
            {estimate.reasoning && <p className="mt-1 text-base-content/70">{estimate.reasoning}</p>}
            <p className="mt-1 text-xs text-base-content/70"><Trans>An estimate — check a current price before relying on it.</Trans></p>
          </div>
        )}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {fresh && (
              <button type="button" className="btn btn-primary btn-sm" disabled={apply.isPending} onClick={() => apply.mutate(estimate.cents)}>
                <Trans>Use {ph({ amount: money(estimate.cents) })}</Trans>
              </button>
            )}
            {offer && !waiting && (
              <button type="button" className="btn btn-text btn-sm" disabled={ask.isPending} onClick={() => ask.mutate()}>
                <span className="icon-[tabler--sparkles] size-4" />
                {estimate ? t`Estimate again` : t`Estimate`}
              </button>
            )}
          </div>
        )}
        {(ask.error ?? apply.error) && <div className="alert alert-soft alert-error text-sm">{(ask.error ?? apply.error)!.message}</div>}
      </div>
    </section>
  );
}
