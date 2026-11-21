/**
 * Graded coins and cards on a thing's page (server: lib/graded.ts): the certificate number on its slab, checked with
 * PCGS (coins) or PSA (cards) — the grade, how many are graded the same and higher, and PCGS's price guide value,
 * offered as its value. Shown for coins and trading cards, and for anything already graded.
 */
import type { GradedInfo, GradingService, Item } from "@ferret/shared";
import { formatMoney } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { useFeatures } from "./lib/features";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

// not translated (names of services)
const NAMES: Record<GradingService, string> = { pcgs: "PCGS", psa: "PSA" };

function Facts({ info }: { info: GradedInfo }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium break-words">{info.name}</p>
      <p className="text-sm">
        <span className="badge badge-soft badge-primary me-2">{NAMES[info.by]} {info.grade}</span>
        {info.population != null && (
          <span className="text-base-content/70">
            {info.popHigher != null
              ? t`${ph({ n: info.population.toLocaleString() })} graded the same, ${ph({ higher: info.popHigher.toLocaleString() })} higher`
              : t`${ph({ n: info.population.toLocaleString() })} graded the same`}
          </span>
        )}
      </p>
    </div>
  );
}

export function GradedCard({ item, canEdit }: { item: Item; canEdit: boolean }) {
  const qc = useQueryClient();
  const services = useFeatures()?.graded ?? [];
  const graded = item.graded;
  const looksGradable = Boolean(item.card || item.collectible?.kind === "coin");
  const got = useQuery({ queryKey: ["item-graded", item.id, graded?.by, graded?.cert], queryFn: () => api.itemGraded(item.id), enabled: Boolean(graded), staleTime: 10 * 60_000 });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["item", item.householdId, item.id] });
  const apply = useMutation({ mutationFn: (patch: Parameters<typeof api.updateItem>[1]) => api.updateItem(item.id, patch), onSuccess: refresh });
  const [adding, setAdding] = useState(false);
  if (!graded && (!looksGradable || !services.length || !canEdit)) return null;
  const info = got.data?.info;
  const price = got.data?.price;
  return (
    <section className="card border border-primary/20" aria-labelledby="item-graded-title">
      <div className="card-body gap-3 p-4">
        <h2 id="item-graded-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--certificate] size-5 text-primary" />
          <Trans>Graded</Trans>
        </h2>
        {graded ? (
          <>
            {got.isPending && <span className="loading loading-spinner loading-sm text-primary" />}
            {info ? <Facts info={info} /> : got.isSuccess && <p className="text-sm text-base-content/70">{t`${ph({ service: NAMES[graded.by] })} certificate ${ph({ cert: graded.cert })} — its details can't be fetched right now.`}</p>}
            {price && (
              <p>
                <span className="font-medium">{formatMoney(price.cents, price.currency, { exact: true })}</span>{" "}
                <span className="text-sm text-base-content/70">
                  {price.original ? t`PCGS price guide (${ph({ dollars: formatMoney(price.original.cents, price.original.currency, { exact: true }) })})` : t`PCGS price guide`}
                </span>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {canEdit && price && price.cents !== item.valueCents && (
                <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={apply.isPending} onClick={() => apply.mutate({ valueCents: price.cents })}>
                  {item.valueCents == null ? t`Use ${ph({ price: formatMoney(price.cents, price.currency, { exact: true }) })} as its value` : t`Update its value to ${ph({ price: formatMoney(price.cents, price.currency, { exact: true }) })}`}
                </button>
              )}
              {info?.url && (
                <a className="btn btn-text btn-sm" href={info.url} target="_blank" rel="noreferrer noopener">
                  <span className="icon-[tabler--external-link] size-4" />
                  {t`On ${ph({ service: NAMES[graded.by] })}`}
                </a>
              )}
              {canEdit && (
                <button type="button" className="btn btn-text btn-sm" disabled={apply.isPending} onClick={() => confirm(t`Forget this certificate? The thing stays as it is.`) && apply.mutate({ graded: null })}>
                  <Trans>Not graded</Trans>
                </button>
              )}
            </div>
          </>
        ) : adding ? (
          <AddCert services={services} onSave={(g) => apply.mutate({ graded: g }, { onSuccess: () => setAdding(false) })} onCancel={() => setAdding(false)} busy={apply.isPending} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-base-content/70">
              {services.includes("pcgs") ? (
                <Trans>In a slab? Its certificate number gives the grade and how rare it is — and for a coin, PCGS's price guide.</Trans>
              ) : (
                <Trans>In a slab? Its certificate number gives the grade and how rare it is.</Trans>
              )}
            </p>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setAdding(true)}><Trans>Add its certificate</Trans></button>
          </div>
        )}
        {apply.isError && <p className="text-sm text-error">{apply.error.message}</p>}
      </div>
    </section>
  );
}

/** Type the certificate number, check it with the service, then save it on the thing. */
function AddCert({ services, onSave, onCancel, busy }: { services: GradingService[]; onSave: (g: { by: GradingService; cert: string }) => void; onCancel: () => void; busy: boolean }) {
  const [by, setBy] = useState<GradingService>(services[0]!);
  const [cert, setCert] = useState("");
  const check = useMutation({ mutationFn: () => api.gradedCert(by, cert.trim()) });
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (cert.trim()) check.mutate();
        }}
      >
        {services.length > 1 && (
          <select className="select w-auto" value={by} onChange={(e) => (setBy(e.target.value as GradingService), check.reset())} aria-label={t`Graded by`}>
            {services.map((s) => (
              <option key={s} value={s}>{NAMES[s]}</option>
            ))}
          </select>
        )}
        <input className="input min-w-0 flex-1 font-mono" inputMode="numeric" value={cert} onChange={(e) => (setCert(e.target.value), check.reset())} placeholder={t`Certificate number`} aria-label={t`Certificate number`} />
        <button className="btn btn-soft btn-primary" disabled={check.isPending || !cert.trim()}>
          {check.isPending ? <span className="loading loading-spinner loading-sm" /> : <Trans>Check</Trans>}
        </button>
        <button type="button" className="btn btn-text" onClick={onCancel}><Trans>Cancel</Trans></button>
      </form>
      {check.isError && <p className="text-sm text-error">{check.error.message}</p>}
      {check.data && (
        <div className="flex flex-col gap-2 rounded-box bg-base-200 p-3">
          <Facts info={check.data} />
          <button type="button" className="btn btn-primary btn-sm w-fit" disabled={busy} onClick={() => onSave({ by, cert: check.data.cert })}>
            <Trans>That's it — save</Trans>
          </button>
        </div>
      )}
    </div>
  );
}
