/**
 * ENERGY STAR on a thing's page (server: lib/energy.ts): its certified energy use a year, how it compares with the
 * US standard, and a link to ENERGY STAR's product finder. Shown only when the server admin switched look-ups on and
 * the thing's brand and model (or barcode) matched.
 */
import type { EnergyStarMatch, Item } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** "645 kWh a year · 10% less than the US standard" or "96% AFUE". */
export function energyLine(m: EnergyStarMatch) {
  return [
    m.kwhPerYear ? t`${ph({ kwh: m.kwhPerYear.toLocaleString() })} kWh a year` : null,
    m.percentBetter ? t`${ph({ percent: m.percentBetter })}% less than the US standard` : m.federalKwhPerYear && m.kwhPerYear && m.kwhPerYear < m.federalKwhPerYear ? t`the US standard allows ${ph({ kwh: m.federalKwhPerYear.toLocaleString() })}` : null,
    m.afue ? t`${ph({ afue: m.afue })}% efficient (AFUE)` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function EnergyCard({ item }: { item: Item }) {
  const asks = Boolean((item.brand && item.model) || item.barcode);
  const energy = useQuery({
    queryKey: ["item-energy", item.id, item.brand, item.model, item.barcode],
    queryFn: () => api.itemEnergy(item.id),
    enabled: asks,
    staleTime: 10 * 60_000,
    // Being looked up: look again until it's in.
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 4000 : false),
  });
  const m = energy.data?.status === "found" ? energy.data.matches?.[0] : undefined;
  if (!m) return null;
  return (
    <section className="card border border-success/30" aria-labelledby="item-energy-title">
      <div className="card-body gap-2 p-4">
        <h2 id="item-energy-title" className="flex flex-wrap items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--bolt] size-5 text-success" />
          {/* The programme's own name. */}
          {/* not translated */}
          ENERGY STAR
          {m.mostEfficient && <span className="badge badge-soft badge-success">{t`Most efficient`}</span>}
        </h2>
        <p className="text-sm text-base-content/80">{[m.kind, m.type].filter(Boolean).join(" · ")}</p>
        {energyLine(m) && <p className="font-medium">{energyLine(m)}</p>}
        <p className="text-xs text-base-content/70">
          <Trans>Certified as {ph({ brand: m.brand })} {ph({ model: m.model })} — the asterisks stand for any letter (a colour or version).</Trans>
        </p>
        <a className="link tap w-fit text-sm" href={m.url} target="_blank" rel="noreferrer noopener">
          <span className="icon-[tabler--external-link] me-1 size-4 align-[-0.15em]" />
          {t`On ENERGY STAR`}
        </a>
      </div>
    </section>
  );
}
