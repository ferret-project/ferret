/**
 * A vehicle's fuel economy on its page (server: lib/fuel-economy.ts): EPA's entries for its decoded make, model and
 * year to confirm one of (the VIN's engine first), then its miles per gallon and what a year's fuel costs. Shown only
 * when the server admin switched fuel economy look-ups on and the thing has a decoded VIN.
 */
import type { ItemFuelEconomyStatus, ItemListing } from "@ferret/shared";
import { formatMoney } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/api";
import { currentCurrency, money } from "./lib/money";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** "about $2,395 a year at Colorado's price this week ($3.51 a gallon)" — the reason beside the amount. */
function costReason(cost: NonNullable<ItemFuelEconomyStatus["cost"]>) {
  const price = cost.unitCents == null ? "" : cost.unit === "kWh" ? `${cost.unitCents.toFixed(1)}¢` : formatMoney(Math.round(cost.unitCents), "USD", { exact: true });
  const miles = cost.miles.toLocaleString();
  const state = cost.state ?? "";
  const week = cost.asOf ?? "";
  if (cost.source === "epa") return t`EPA's estimate at US average prices, for ${ph({ miles })} miles a year`;
  if (cost.unit === "kWh") {
    return cost.state
      ? t`at ${ph({ state })}'s average home electricity rate (${ph({ price })} a kWh in ${ph({ year: week })}), for ${ph({ miles })} miles a year`
      : t`at the US average home electricity rate (${ph({ price })} a kWh in ${ph({ year: week })}), for ${ph({ miles })} miles a year`;
  }
  if (cost.source === "state") return t`at ${ph({ state })}'s average price the week of ${ph({ week })} (${ph({ price })} a gallon), for ${ph({ miles })} miles a year`;
  if (cost.source === "region") return t`at the average price in ${ph({ state })}'s region the week of ${ph({ week })} (${ph({ price })} a gallon), for ${ph({ miles })} miles a year`;
  return t`at the US average price the week of ${ph({ week })} (${ph({ price })} a gallon), for ${ph({ miles })} miles a year`;
}

export function FuelEconomyCard({ item, canEdit }: { item: ItemListing; canEdit: boolean }) {
  const qc = useQueryClient();
  const v = item.vehicle;
  const decoded = v?.status === "found" && Boolean(v.make && v.model && v.year);
  const key = ["item-fuel-economy", item.id, v?.vin, v?.year];
  const fuel = useQuery({
    queryKey: key,
    queryFn: () => api.itemFuelEconomy(item.id),
    enabled: decoded,
    staleTime: 10 * 60_000,
    // Being looked up: look again until it's in. EPA's estimate may only be until this week's prices arrive (fetched
    // in the background on the first view): look a couple more times.
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 3000 : q.state.data?.cost?.source === "epa" && q.state.dataUpdateCount < 3 ? 6000 : false),
  });
  const choose = useMutation({ mutationFn: (id: string | null) => api.chooseFuelEconomy(item.id, id), onSuccess: (data) => qc.setQueryData(key, data) });
  const clear = useMutation({ mutationFn: () => api.clearFuelEconomy(item.id), onSuccess: (data) => qc.setQueryData(key, data) });
  const d = fuel.data;
  if (!decoded || !d || d.status === "off" || d.status === "none") return null;
  if (d.status === "choose" && !canEdit) return null;
  const busy = choose.isPending || clear.isPending;
  const error = choose.error ?? clear.error;

  return (
    <section className="card border border-primary/20" aria-labelledby="item-fuel-title">
      <div className="card-body gap-3 p-4">
        <h2 id="item-fuel-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--gas-station] size-5 text-primary" />
          <Trans>Fuel economy</Trans>
        </h2>

        {d.status === "pending" && (
          <p className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs text-primary" />
            <Trans>Looking it up on fueleconomy.gov…</Trans>
          </p>
        )}

        {d.status === "choose" && d.options && (
          <>
            <p className="text-sm text-base-content/80">
              <Trans>Which one is it? fueleconomy.gov lists these for a {ph({ year: v!.year ?? "" })} {ph({ make: v!.make ?? "" })} {ph({ model: v!.model ?? "" })}:</Trans>
            </p>
            <ul className="flex flex-col divide-y divide-base-content/10">
              {d.options.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-base-content">{o.text}</span>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
                      {o.model}
                      {o.likely && <span className="badge badge-soft badge-success badge-sm">{t`Same engine as the VIN`}</span>}
                    </span>
                  </span>
                  <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={busy} onClick={() => choose.mutate(o.id)}>
                    <Trans>This one</Trans>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="tap link link-hover w-fit text-sm text-base-content/70" disabled={busy} onClick={() => choose.mutate(null)}>
              <Trans>None of these</Trans>
            </button>
          </>
        )}

        {d.status === "found" && d.vehicle && (
          <>
            <FuelFigures status={d} />
            <p className="text-xs text-base-content/70">
              <Trans>EPA's figures for the {ph({ year: d.vehicle.year })} {ph({ make: d.vehicle.make })} {ph({ entry: d.vehicle.text })} — what you get depends on how and where you drive.</Trans>
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a className="link tap w-fit text-sm" href={d.vehicle.url} target="_blank" rel="noreferrer noopener">
                <span className="icon-[tabler--external-link] me-1 size-4 align-[-0.15em]" />
                {t`On fueleconomy.gov`}
              </a>
              {canEdit && (
                <button type="button" className="tap link link-hover text-sm text-base-content/70" disabled={busy} onClick={() => clear.mutate()}>
                  <Trans>Not this one?</Trans>
                </button>
              )}
            </div>
          </>
        )}
        {error && <p className="text-sm text-error">{error.message}</p>}
      </div>
    </section>
  );
}

function FuelFigures({ status }: { status: ItemFuelEconomyStatus }) {
  const veh = status.vehicle!;
  const cost = status.cost;
  const electric = veh.fuel.toLowerCase().includes("electric");
  // Outside the US, litres per 100 km beside the miles per gallon (US gallons).
  const metric = currentCurrency() !== "USD" && !electric ? (235.215 / veh.combined).toFixed(1) : null;
  return (
    <>
      <p className="text-base-content">
        <span className="text-2xl font-semibold">{veh.combined}</span>{" "}
        <span className="font-medium">{electric ? t`MPGe combined` : t`mpg combined`}</span>
        {metric && <span className="text-sm text-base-content/70"> · {t`${ph({ litres: metric })} L/100 km`}</span>}
      </p>
      <p className="text-sm text-base-content/80">
        {[
          t`${ph({ city: veh.city })} city`,
          t`${ph({ highway: veh.highway })} highway`,
          veh.kwhPer100Miles ? t`${ph({ kwh: veh.kwhPer100Miles })} kWh per 100 miles` : null,
          veh.rangeMiles ? t`${ph({ range: veh.rangeMiles })} miles of range` : null,
          veh.fuel,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {cost && (
        <p className="text-sm">
          <span className="font-medium">{t`About ${ph({ cost: money(cost.cents) })} a year in fuel`}</span> <span className="text-base-content/70">{costReason(cost)}</span>
        </p>
      )}
    </>
  );
}
