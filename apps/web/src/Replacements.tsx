/**
 * Lifespans and the replacement forecast (server: lib/lifespans.ts) — always worded as estimates: a line on a thing's
 * page ("A refrigerator lasts about 13 years · likely due around 2034 · about $1,500 to replace"), and #/replacements:
 * what's past its typical life, then year by year, with what replacing it might cost.
 */
import type { ForecastYear, ItemLifespan } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { money } from "./lib/money";
import { CATEGORIES_HREF, itemHref, REPLACEMENTS_HREF } from "./lib/route";
import { lifespanKindWord } from "./lib/words";
import { BarSearch } from "./Nav";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** "A refrigerator lasts about 13 years", "Things in Appliances last about 10 years", "Expected to last 3 years". */
export function lifespanText(l: ItemLifespan) {
  const years = l.years;
  if (l.source === "item") return t`Expected to last ${years} years`;
  if (l.source === "category") return t`Things in ${ph({ category: l.from ?? "" })} last about ${years} years`;
  const kind = lifespanKindWord(l.kind ?? "", l.from ?? "");
  return t`Typical life of a ${kind}: about ${years} years`;
}

/** "Likely due around 2034" or "Past its typical life". */
export function dueText(l: ItemLifespan) {
  const year = String(l.dueYear);
  return l.past ? t`Past its typical life (since about ${year})` : t`Likely due around ${year}`;
}

/** On a thing's page: how long it should last, when it's likely due, and what replacing it might cost. */
export function LifespanLine({ lifespan: l }: { lifespan: ItemLifespan | null | undefined }) {
  if (!l) return null;
  const cost = l.costCents != null ? t`about ${ph({ amount: money(l.costCents) })} to replace` : null;
  return (
    <p className={`flex items-start gap-1 text-sm ${l.past ? "text-warning" : "text-base-content/80"}`}>
      <span className="icon-[tabler--hourglass] mt-0.5 size-4 shrink-0" />
      <span>
        {[lifespanText(l), dueText(l), cost].filter(Boolean).join(" · ")}{" "}
        <a href={REPLACEMENTS_HREF} className="tap link link-hover whitespace-nowrap text-base-content/70">
          <Trans>(an estimate)</Trans>
        </a>
      </span>
    </p>
  );
}

function YearRow({ label, y, max }: { label: string; y: ForecastYear; max: number }) {
  return (
    <li className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 text-base-content">{label}</span>
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-base-200" aria-hidden>
        <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (y.cents / Math.max(max, 1)) * 100)}%` }} />
      </span>
      <span className="w-24 shrink-0 text-end font-medium text-base-content">{y.cents ? money(y.cents) : "—"}</span>
      <span className="w-20 shrink-0 text-end text-base-content/70">{plural(y.items, { one: "# thing", other: "# things" })}</span>
    </li>
  );
}

/** The dashboard's card: past their typical life, and the next five years. */
export function ReplacementsCard({ past, years }: { past: ForecastYear; years: ForecastYear[] }) {
  const shown = years.filter((y) => y.items);
  if (!past.items && !shown.length) return null;
  const max = Math.max(past.cents, ...years.map((y) => y.cents));
  return (
    <ul className="flex flex-col gap-2">
      {past.items > 0 && <YearRow label={t`Past typical life`} y={past} max={max} />}
      {shown.map((y) => (
        <YearRow key={y.year} label={String(y.year)} y={y} max={max} />
      ))}
    </ul>
  );
}

/** #/replacements */
export function Replacements({ householdId }: { householdId: string }) {
  const forecast = useQuery({ queryKey: ["replacements", householdId], queryFn: () => api.replacements(10) });
  const f = forecast.data;
  const groups = f
    ? [
        { key: "past", label: t`Past their typical life`, y: f.past, items: f.items.filter((i) => i.lifespan.past) },
        ...f.years.filter((y) => y.items).map((y) => ({ key: String(y.year), label: String(y.year), y, items: f.items.filter((i) => !i.lifespan.past && i.lifespan.dueYear === y.year) })),
      ].filter((g) => g.items.length)
    : [];
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={t`Back`}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold"><Trans>Coming up for replacement</Trans></h1>
          <HelpLink page="guide/replacements.html" label={t`Coming up for replacement`} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-sm text-base-content/70">
          <Trans>
            When things are likely to wear out, from how long each kind usually lasts and when it was bought (or added). These are
            estimates to plan with — plenty of things last much longer. Set how long something lasts on it, or on its{" "}
            <a href={CATEGORIES_HREF} className="link link-primary">category</a>.
          </Trans>
        </p>
        {forecast.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {forecast.isError && <div className="alert alert-soft alert-error">{forecast.error.message}</div>}
        {f && !groups.length && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--hourglass] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Nothing due in the next ten years</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>Things Ferret knows the typical life of — appliances, electronics, the water heater, the roof — show up here as they get older.</Trans>
              </p>
            </div>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.key} className="card">
            <div className="card-body gap-2 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className={`font-semibold ${g.key === "past" ? "text-warning" : "text-base-content"}`}>{g.label}</h2>
                <span className="text-sm text-base-content/70">
                  {[g.y.cents ? t`about ${ph({ amount: money(g.y.cents) })}` : null, g.y.unpriced ? plural(g.y.unpriced, { one: "# without a price", other: "# without a price" }) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <ul className="flex flex-col">
                {g.items.map((i) => (
                  <li key={i.id}>
                    <a href={itemHref(i.id)} className="flex min-h-12 items-center gap-3 rounded-field px-2 py-1.5 hover:bg-base-200">
                      {i.photoId ? (
                        <img src={api.thumbnailUrl(i.photoId)} alt="" loading="lazy" className="size-10 shrink-0 rounded-field object-cover" />
                      ) : (
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40">
                          <span className="icon-[tabler--box] size-5" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base-content">{i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name}</span>
                        <span className="block truncate text-xs text-base-content/70">
                          {[lifespanText(i.lifespan), i.lifespan.sinceFrom === "bought" ? t`bought ${ph({ year: i.lifespan.since.slice(0, 4) })}` : t`added ${ph({ year: i.lifespan.since.slice(0, 4) })}`].join(" · ")}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-base-content/80">{i.lifespan.costCents != null ? money(i.lifespan.costCents) : ""}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
        {f && f.unknown > 0 && (
          <p className="text-sm text-base-content/70">
            {plural(f.unknown, {
              one: "# thing has no typical life Ferret knows. Give its category one, or set it on the thing, to include it.",
              other: "# things have no typical life Ferret knows. Give their categories one, or set it on the things, to include them.",
            })}
          </p>
        )}
      </main>
    </div>
  );
}
