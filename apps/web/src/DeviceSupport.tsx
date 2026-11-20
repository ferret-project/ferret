/**
 * A device's software support on its page (endoflife.date, lib/support.ts on the server): when it stops getting
 * security updates. A match is only a suggestion — "Is this a Google Pixel 6 Pro?" — until someone says yes; then
 * the bell warns 90 days before the updates stop.
 */
import type { Item, SupportInfo } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/api";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const dateText = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

function When({ s }: { s: SupportInfo }) {
  if (!s.eolFrom) return <Trans>No end date announced yet.</Trans>;
  return s.ended ? <Trans>Security updates stopped on {ph({ date: dateText(s.eolFrom) })}.</Trans> : <Trans>Security updates until {ph({ date: dateText(s.eolFrom) })}.</Trans>;
}

export function DeviceSupport({ item, canEdit }: { item: Item; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ["item-support", item.id, item.name, item.brand, item.model];
  const status = useQuery({ queryKey: key, queryFn: () => api.itemSupport(item.id), staleTime: 10 * 60_000, refetchInterval: (q) => (q.state.data?.status === "pending" ? 5000 : false) });
  const done = (data: Awaited<ReturnType<typeof api.itemSupport>>) => {
    qc.setQueryData(key, data);
    void qc.invalidateQueries({ queryKey: ["attention"] });
  };
  const track = useMutation({ mutationFn: (s: SupportInfo) => api.trackSupport(item.id, { product: s.product, release: s.release }), onSuccess: done });
  const untrack = useMutation({ mutationFn: () => api.untrackSupport(item.id), onSuccess: done });
  const s = status.data;
  if (!s?.support || (s.status !== "tracked" && s.status !== "suggested")) return null;
  if (s.status === "suggested" && !canEdit) return null;
  const busy = track.isPending || untrack.isPending;
  return (
    <section className={`card border ${s.status === "tracked" && s.support.ended ? "border-warning/40" : "border-primary/20"}`} aria-labelledby="item-support-title">
      <div className="card-body gap-2 p-4">
        <h2 id="item-support-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--device-mobile-cog] size-5 text-primary" />
          <Trans>Software updates</Trans>
        </h2>
        {s.status === "suggested" ? (
          <>
            <p className="text-sm text-base-content/80">
              <Trans>Is this a {ph({ device: s.support.label })}?</Trans> <When s={s.support} />
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={busy} onClick={() => track.mutate(s.support!)}>
                <Trans>Yes — remind me before updates stop</Trans>
              </button>
              <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => untrack.mutate()}>
                <Trans>It isn't</Trans>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-base-content/80">
              {s.support.label}: <When s={s.support} />
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <a className="link tap text-sm" href={s.support.url} target="_blank" rel="noreferrer noopener">endoflife.date{/* not translated */}</a>
              {canEdit && (
                <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => untrack.mutate()}>
                  <Trans>Stop tracking</Trans>
                </button>
              )}
            </div>
          </>
        )}
        {(track.isError || untrack.isError) && <p className="text-sm text-error">{(track.error ?? untrack.error)?.message}</p>}
        {s.status === "suggested" && <p className="text-xs text-base-content/70">{t`From endoflife.date — check it's the right model before saying yes.`}</p>}
      </div>
    </section>
  );
}
