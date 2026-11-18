/**
 * #/to-confirm "To confirm" (server: lib/to-confirm.ts): everything the AI suggested that's waiting for a person, in
 * one list — what it read off each thing's photos and receipts (Apply / Dismiss, as on the thing's page, with "Add
 * the other things on this receipt"), replacement-cost estimates not used yet (Use / Not this), and the other lists
 * with their own screens. Also where to ask for estimates for every thing that has no value yet.
 */
import type { ItemPatch, ToConfirm as ToConfirmData, WarrantyInput } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HelpLink } from "./HelpLink";
import { TopBar } from "./Nav";
import { Suggestions } from "./Suggestions";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { useFeatures } from "./lib/features";
import { money } from "./lib/money";
import { itemHref } from "./lib/route";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const key = (householdId: string) => ["to-confirm", householdId];

export function ToConfirm({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const list = useQuery({ queryKey: key(householdId), queryFn: api.toConfirm, refetchInterval: 15_000 });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key(householdId) });
    for (const k of ["items", "attention", "overview"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
  };
  const data = list.data;
  const empty = data && !data.items.length && !data.estimates.length;
  const others = data ? otherLists(data) : [];
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar title={<Trans>To confirm</Trans>} back="#/" help={<HelpLink page="guide/ai.html#to-confirm" label={t`To confirm`} />} />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {list.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {others.length > 0 && (
          <nav className="flex flex-wrap gap-2" aria-label={t`Other lists to look at`}>
            {others.map((o) => (
              <a key={o.href} href={o.href} className="tap badge badge-soft badge-primary h-auto gap-1 py-1.5">
                <span className={`${o.icon} size-4`} />
                {o.label}
              </a>
            ))}
          </nav>
        )}
        {empty && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--circle-check] size-10 text-success" />
              <h2 className="text-lg font-semibold">
                <Trans>Nothing to confirm</Trans>
              </h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>What AI reads off photos and receipts, and the values it estimates, wait here until someone applies or dismisses them.</Trans>
              </p>
            </div>
          </div>
        )}
        {data?.items.map(({ item, attachments, warranties }) => (
          <ThingSuggestions key={item.id} householdId={householdId} item={item} attachments={attachments} warranties={warranties} canEdit={canEdit} onChanged={refresh} />
        ))}
        {data && data.estimates.length > 0 && <Estimates householdId={householdId} estimates={data.estimates} canEdit={canEdit} onChanged={refresh} />}
        {canEdit && <EstimateMissing onQueued={refresh} />}
      </main>
    </div>
  );
}

function otherLists(data: ToConfirmData) {
  const c = data.counts;
  return [
    c.aiFilled && { href: "#/ai-filled", icon: "icon-[tabler--sparkles]", label: plural(c.aiFilled, { one: "# detail AI filled in", other: "# details AI filled in" }) },
    c.duplicates && { href: "#/duplicates", icon: "icon-[tabler--copy]", label: plural(c.duplicates, { one: "# possible duplicate", other: "# possible duplicates" }) },
    c.suggestedTasks && { href: "#/maintenance", icon: "icon-[tabler--tool]", label: plural(c.suggestedTasks, { one: "# suggested maintenance task", other: "# suggested maintenance tasks" }) },
    c.paperless && { href: "#/paperless", icon: "icon-[tabler--file-text]", label: plural(c.paperless, { one: "# document from Paperless", other: "# documents from Paperless" }) },
  ].filter((x): x is { href: string; icon: string; label: string } => Boolean(x));
}

/** One thing: its name and photo, then its suggestions as on its page. */
function ThingSuggestions({
  householdId,
  item,
  attachments,
  warranties,
  canEdit,
  onChanged,
}: ToConfirmData["items"][number] & { householdId: string; canEdit: boolean; onChanged: () => Promise<void> }) {
  const apply = useMutation({ mutationFn: (patch: ItemPatch) => api.updateItem(item.id, patch), onSuccess: onChanged });
  const addWarranty = useMutation({ mutationFn: (input: WarrantyInput) => api.addWarranty(item.id, input), onSuccess: onChanged });
  const dismiss = useMutation({ mutationFn: (ids: string[]) => Promise.all(ids.map(api.dismissSuggestions)), onSuccess: onChanged });
  const error = apply.error ?? addWarranty.error ?? dismiss.error;
  return (
    <div className="flex flex-col gap-2">
      <a href={itemHref(item.id)} className="tap flex items-center gap-3">
        {item.photoId ? (
          <img src={api.thumbnailUrl(item.photoId)} alt="" className="size-10 shrink-0 rounded-field bg-base-300 object-cover" />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-field bg-base-300">
            <span className="icon-[tabler--package] size-5 text-base-content/40" />
          </span>
        )}
        <span className="min-w-0">
          <span className="link link-hover block truncate font-semibold">{item.name}</span>
          {item.place && <span className="block truncate text-xs text-base-content/70">{item.place}</span>}
        </span>
      </a>
      {canEdit ? (
        <Suggestions
          householdId={householdId}
          item={item}
          attachments={attachments}
          // Only the end dates count (a warranty already there isn't offered again).
          warranties={warranties.map((w) => ({ endsOn: w.endsOn }) as never)}
          tasks={[]}
          onApply={(p) => apply.mutate(p)}
          onAddWarranty={(w) => addWarranty.mutate(w)}
          onAddTask={() => {}}
          onDismiss={(ids) => dismiss.mutate(ids)}
          busy={apply.isPending || addWarranty.isPending || dismiss.isPending}
        />
      ) : null}
      {error && <div className="alert alert-soft alert-error text-sm">{error.message}</div>}
    </div>
  );
}

/** Replacement-cost estimates not used yet: Use (as its replacement cost — and its value, if it has none) or Not this. */
function Estimates({ estimates, canEdit, onChanged }: { householdId: string; estimates: ToConfirmData["estimates"]; canEdit: boolean; onChanged: () => Promise<void> }) {
  const use = useMutation({
    mutationFn: (list: ToConfirmData["estimates"]) =>
      Promise.all(list.map((e) => api.updateItem(e.itemId, { replacementCents: e.cents, ...(e.valueCents == null && e.purchasePriceCents == null && { valueCents: e.cents }) }))),
    onSuccess: onChanged,
  });
  const dismiss = useMutation({ mutationFn: (itemId: string) => api.dismissReplacementEstimate(itemId), onSuccess: onChanged });
  return (
    <section className="card" aria-labelledby="estimates-title">
      <div className="card-body gap-3 p-4">
        <h2 id="estimates-title" className="flex items-center gap-2 font-semibold">
          <span className="icon-[tabler--coin] size-5 text-primary" />
          <Trans>What they'd cost to replace</Trans>
        </h2>
        <p className="text-xs text-base-content/70">
          <Trans>Estimated by AI — check before using. Use sets its replacement cost, and its value too if it has none.</Trans>
        </p>
        <ul className="divide-base-content/10 flex flex-col divide-y">
          {estimates.map((e) => (
            <li key={e.itemId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <a href={itemHref(e.itemId)} className="tap link link-hover min-w-0 flex-1 truncate font-medium">
                {e.name}
              </a>
              <span className="font-semibold">{money(e.cents)}</span>
              {canEdit && (
                <span className="flex gap-1">
                  <button type="button" className="btn btn-text btn-sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(e.itemId)} aria-label={t`Not this estimate for ${ph({ name: e.name })}`}>
                    <Trans>Not this</Trans>
                  </button>
                  <button type="button" className="btn btn-text btn-primary btn-sm" disabled={use.isPending} onClick={() => use.mutate([e])} aria-label={t`Use ${ph({ amount: money(e.cents) })} for ${ph({ name: e.name })}`}>
                    <Trans>Use</Trans>
                  </button>
                </span>
              )}
              <p className="w-full text-xs text-base-content/70">{e.reasoning}</p>
            </li>
          ))}
        </ul>
        {canEdit && estimates.length > 1 && (
          <div className="flex justify-end">
            <button type="button" className="btn btn-primary btn-sm" disabled={use.isPending} onClick={() => use.mutate(estimates)}>
              {use.isPending && <span className="loading loading-spinner loading-xs" />}
              <Trans>Use all</Trans>
            </button>
          </div>
        )}
        {(use.error ?? dismiss.error) && <div className="alert alert-soft alert-error text-sm">{(use.error ?? dismiss.error)!.message}</div>}
      </div>
    </section>
  );
}

/** Ask AI what every thing with no value yet would cost to replace (up to 50 at a time). Also on Everything's "no value" list. */
export function EstimateMissing({ onQueued, compact = false }: { onQueued?: () => void; compact?: boolean }) {
  const features = useFeatures();
  const [queued, setQueued] = useState<number | null>(null);
  const ask = useMutation({
    mutationFn: () => api.estimateReplacements({ missing: "value" }),
    onSuccess: (r) => {
      setQueued(r.queued);
      onQueued?.();
    },
  });
  if (!features?.textAi) return null;
  const button = (
    <button type="button" className="btn btn-soft btn-primary btn-sm btn-wrap" disabled={ask.isPending || queued !== null} onClick={() => ask.mutate()}>
      {ask.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--sparkles] size-4" />}
      <Trans>Estimate values with AI</Trans>
    </button>
  );
  const result =
    queued !== null ? (
      <p className="text-sm" role="status">
        {queued
          ? plural(queued, { one: "Asked about # thing — its estimate appears under To confirm in a minute or two.", other: "Asked about # things — their estimates appear under To confirm over the next few minutes." })
          : t`Every thing without a value has an estimate already — they're under To confirm.`}
      </p>
    ) : null;
  if (ask.isError) return <div className="alert alert-soft alert-error text-sm">{ask.error.message}</div>;
  if (compact)
    return (
      <div className="flex flex-wrap items-center gap-2">
        {button}
        {result}
      </div>
    );
  return (
    <section className="card">
      <div className="card-body gap-2 p-4">
        <h2 className="font-semibold">
          <Trans>Things without a value</Trans>
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>AI can estimate what each would cost to replace new, from what it is — up to 50 at a time. Each waits here for you to use or not.</Trans>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {button}
          {result}
        </div>
      </div>
    </section>
  );
}
