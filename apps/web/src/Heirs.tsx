/**
 * #/heirs — the personal property list (server: lib/heirs.ts): things grouped by who should have them one day (an
 * item's "heir"), each with a photo and what identifies it, and a signature and date line per person. A page to print
 * and keep with other papers — not a legal document (rules differ by place; the help says to ask a lawyer). Owners
 * and admins only: it says who gets what.
 */
import { BarSearch } from "./Nav";
import { today } from "@ferret/shared/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { authClient, useRole } from "./lib/auth";
import { money } from "./lib/money";
import { itemHref } from "./lib/route";
import { HelpLink } from "./HelpLink";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export function Heirs({ householdId, householdName }: { householdId: string; householdName: string }) {
  const role = useRole(householdId);
  const allowed = role === "owner" || role === "admin";
  const list = useQuery({ queryKey: ["heirs", householdId], queryFn: api.heirs, enabled: allowed });
  const { data: session } = authClient.useSession();
  const [photos, setPhotos] = useState(true);
  const [values, setValues] = useState(false);
  const groups = list.data?.data ?? [];
  return (
    <div className="min-h-dvh bg-base-200 print:bg-white">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4 print:hidden">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={t`Back`}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold"><Trans>Personal property list</Trans></h1>
          <HelpLink page="guide/personal-property-list.html" label={t`Personal property list`} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] print:max-w-none print:p-0">
        {role != null && !allowed && (
          <div className="alert alert-soft alert-info"><Trans>Only the household's owner and admins can see who should have what.</Trans></div>
        )}
        {allowed && (
          <section className="card print:hidden">
            <div className="card-body gap-4 p-4 sm:p-6">
              <p className="text-sm text-base-content/70">
                <Trans>Everything you've said someone should have one day (Edit → "Goes to (heir)"), grouped by person, with what identifies each thing. Print it to keep with your other papers. It's a list for your family, not a will — the rules differ from place to place, so ask a lawyer how to make your wishes count.</Trans>
              </p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <label className="flex h-11 items-center gap-2">
                  <input type="checkbox" className="switch switch-primary" checked={photos} onChange={(e) => setPhotos(e.target.checked)} />
                  <span className="label-text text-base"><Trans>Photos</Trans></span>
                </label>
                <label className="flex h-11 items-center gap-2">
                  <input type="checkbox" className="switch switch-primary" checked={values} onChange={(e) => setValues(e.target.checked)} />
                  <span className="label-text text-base"><Trans>Values</Trans></span>
                </label>
              </div>
              <div>
                <button type="button" className="btn btn-wrap btn-primary" disabled={!groups.length} onClick={() => window.print()}>
                  <span className="icon-[tabler--printer] size-5" />
                  <Trans>Print or save as PDF</Trans>
                </button>
              </div>
            </div>
          </section>
        )}
        {list.isPending && allowed && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {list.data && groups.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--users] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Nobody named yet</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>On a thing's page, Edit → "Goes to (heir)" — then it's listed here under that person.</Trans>
              </p>
            </div>
          </div>
        )}
        {groups.length > 0 && (
          <article className="rounded-box bg-white p-6 text-black shadow-sm print:rounded-none print:p-0 print:shadow-none sm:p-10">
            <header className="border-b border-gray-300 pb-4">
              <p className="text-sm text-gray-600"><Trans>🐾 Ferret · Personal property list</Trans></p>
              <h2 className="mt-1 text-2xl font-bold">{householdName}</h2>
              <p className="mt-1 text-sm text-gray-600">
                <Trans>Prepared {ph({ date: longDate(today()) })}</Trans>
                {session?.user.name ? t` by ${ph({ name: session.user.name })}` : ""}
              </p>
              <p className="mt-2 text-sm text-gray-600">
                {plural(groups.length, { one: "# person", other: "# people" })} · {plural(groups.reduce((n, g) => n + g.items.length, 0), { one: "# thing", other: "# things" })}
              </p>
            </header>
            {groups.map((g, i) => (
              <section key={g.heir} className={`pt-6 ${i ? "print:break-before-page" : ""}`} aria-labelledby={`heir-${i}`}>
                <h3 id={`heir-${i}`} className="flex flex-wrap items-baseline gap-x-3 text-xl font-semibold">
                  {g.heir}
                  <span className="text-sm font-normal text-gray-600">
                    {plural(g.items.length, { one: "# thing", other: "# things" })}
                    {values && g.valueCents > 0 ? ` · ${money(g.valueCents)}` : ""}
                  </span>
                </h3>
                <ul className="mt-2 divide-y divide-gray-200">
                  {g.items.map((it) => (
                    <li key={it.id} className="flex break-inside-avoid gap-3 py-2">
                      {photos && (
                        <div className="size-16 shrink-0 overflow-hidden rounded bg-gray-100">
                          {it.photoId && <img src={api.thumbnailUrl(it.photoId)} alt="" className="size-full object-cover" loading="lazy" />}
                        </div>
                      )}
                      <div className="min-w-0 flex-1 text-[10pt]">
                        <a href={itemHref(it.id)} className="font-semibold print:no-underline">{it.quantity > 1 ? `${it.quantity} × ${it.name}` : it.name}</a>
                        {(it.brand || it.model) && <p className="text-gray-700">{[it.brand, it.model].filter(Boolean).join(" ")}</p>}
                        {it.description && <p className="line-clamp-2 text-gray-700">{it.description}</p>}
                        <p className="text-gray-600">
                          {[it.serialNumber && t`Serial ${ph({ serial: it.serialNumber })}`, it.place && t`Kept in ${ph({ place: it.box ? `${it.place} › ${it.box}` : it.place })}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      {values && <div className="shrink-0 text-end text-[10pt]">{it.valueCents != null ? money(it.valueCents) : ""}</div>}
                    </li>
                  ))}
                </ul>
                <div className="mt-6 grid break-inside-avoid grid-cols-1 gap-6 text-sm text-gray-700 sm:grid-cols-2 print:grid-cols-2">
                  <div>
                    <div className="h-8 border-b border-gray-500" />
                    <Trans>Signature</Trans>
                  </div>
                  <div>
                    <div className="h-8 border-b border-gray-500" />
                    <Trans>Date</Trans>
                  </div>
                </div>
              </section>
            ))}
            <p className="mt-8 text-xs text-gray-600">
              <Trans>A list of wishes kept in Ferret, not a legal document. Whether it counts, and how to make it count, depends on where you live — ask a lawyer.</Trans>
            </p>
          </article>
        )}
      </main>
    </div>
  );
}
