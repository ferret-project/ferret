/**
 * Bike Index on a bike's page (server: lib/bikes.ts): whether a bike with its serial number is reported stolen there
 * — worth knowing about one bought second-hand — and links to register it, or to report it once it's marked stolen.
 * Ferret never acts on anyone's Bike Index account: those are links to bikeindex.org.
 */
import type { Item } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const REGISTER = "https://bikeindex.org/bikes/new";
const REPORT = "https://bikeindex.org/bikes/new?stolen=true";

export function BikeIndexCard({ item }: { item: Item }) {
  const check = useQuery({
    queryKey: ["item-bike-index", item.id, item.serialNumber, item.name],
    queryFn: () => api.itemBikeIndex(item.id),
    staleTime: 10 * 60_000,
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 3000 : false),
  });
  const s = check.data;
  if (!s || s.status === "off") return null;
  const stolenHere = item.disposition === "stolen";
  if (s.status === "pending" || (s.status === "none" && !stolenHere)) return null;
  return (
    <section className={`card border ${s.status === "stolen" ? "border-error/40" : "border-base-content/10"}`} aria-labelledby="bike-index-title">
      <div className="card-body gap-2 p-4">
        <h2 id="bike-index-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className={`icon-[tabler--bike] size-5 ${s.status === "stolen" ? "text-error" : "text-primary"}`} />
          {/* The registry's name. */}
          {/* not translated */}
          Bike Index
        </h2>
        {s.status === "stolen" &&
          s.reports?.map((r) => (
            <div key={r.id} className="alert alert-soft alert-error flex flex-col items-start gap-1">
              <p className="font-medium">
                {stolenHere ? <Trans>Reported stolen on Bike Index.</Trans> : <Trans>A bike with this serial number is reported stolen on Bike Index.</Trans>}
              </p>
              <p className="text-sm">
                {[[r.maker, r.model, r.year].filter(Boolean).join(" "), r.location, r.stolenOn ? t`stolen ${ph({ when: formatDate(r.stolenOn) })}` : null].filter(Boolean).join(" · ")}
              </p>
              <a className="link tap text-sm" href={r.url} target="_blank" rel="noreferrer noopener">{t`See the report`}</a>
            </div>
          ))}
        {s.status === "clear" && !stolenHere && <p className="text-sm text-base-content/80"><Trans>Not reported stolen on Bike Index.</Trans></p>}
        {stolenHere && s.status !== "stolen" && (
          <p className="text-sm text-base-content/80">
            <Trans>Report it on Bike Index too: bike shops, police and buyers check it, which is how stolen bikes come back.</Trans>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {stolenHere && s.status !== "stolen" ? (
            <a className="btn btn-soft btn-primary btn-sm" href={REPORT} target="_blank" rel="noreferrer noopener">{t`Report it stolen on Bike Index`}</a>
          ) : (
            !stolenHere && s.status === "clear" && (
              <a className="btn btn-text btn-sm" href={REGISTER} target="_blank" rel="noreferrer noopener">
                <span className="icon-[tabler--external-link] size-4" />
                {t`Register it on Bike Index`}
              </a>
            )
          )}
        </div>
      </div>
    </section>
  );
}
