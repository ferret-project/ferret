/**
 * Item lifecycle: things you no longer have — sold, given away, donated, thrown out, lost, stolen. They leave lists, totals,
 * search, the insurance report and reminders (server: itemScope), but keep their page and history, and can be brought
 * back. GoneDialog marks one; GoneBanner sits on its page; Past (#/past) lists them, with lost and stolen things
 * downloadable for a claim, and donations listed by year (Donations, #/donations/:year: print or CSV).
 */
import { BarSearch } from "./Nav";
import type { ItemDisposition, ItemListing } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { donationsHref, itemHref, PAST_HREF } from "./lib/route";
import { authClient } from "./lib/auth";
import { DialogActions, Modal } from "./Modal";
import { money, currencySymbol, toCents } from "./lib/money";
import { conditionWord } from "./lib/words";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

export const DISPOSITIONS: { value: ItemDisposition; label: MessageDescriptor; past: MessageDescriptor; icon: string; amount?: MessageDescriptor }[] = [
  { value: "sold", label: msg`Sold it`, past: msg`Sold`, icon: "icon-[tabler--cash]", amount: msg`Sold for` },
  { value: "given", label: msg`Gave it away`, past: msg`Given away`, icon: "icon-[tabler--gift]" },
  { value: "donated", label: msg`Donated it`, past: msg`Donated`, icon: "icon-[tabler--heart-handshake]", amount: msg`Worth when given` },
  { value: "discarded", label: msg`Threw it out`, past: msg`Thrown out`, icon: "icon-[tabler--trash-x]" },
  { value: "lost", label: msg`Lost it`, past: msg`Lost`, icon: "icon-[tabler--map-pin-question]", amount: msg`Insurance paid` },
  { value: "stolen", label: msg`It was stolen`, past: msg`Stolen`, icon: "icon-[tabler--shield-x]", amount: msg`Insurance paid` },
];
const byValue = (v: ItemDisposition | null | undefined) => DISPOSITIONS.find((d) => d.value === v);
const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Every query that lists or totals things: a thing leaving (or coming back) changes them all. */
function useRefreshAll(householdId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ["item", "items", "places", "overview", "attention", "maintenance", "shopping", "categories", "tags", "past"].map((k) =>
        qc.invalidateQueries({ queryKey: [k, householdId] }),
      ),
    );
}

/** "What happened to it?" — then it's gone from lists and totals. */
export function GoneDialog({ item, householdId, onClose, onDone }: { item: ItemListing; householdId: string; onClose: () => void; onDone?: () => void }) {
  const refresh = useRefreshAll(householdId);
  const [what, setWhat] = useState<ItemDisposition>("sold");
  const save = useMutation({
    mutationFn: async ({ receipt, ...patch }: { disposition: ItemDisposition; disposedOn: string; disposalCents: number | null; disposalNote: string | null; disposedTo: string | null; receipt: File | null }) => {
      const saved = await api.updateItem(item.id, patch);
      // A donation's receipt goes on the item with its other documents.
      if (receipt) await api.uploadAttachment(item.id, receipt, "document", () => {});
      return saved;
    },
    onSuccess: async () => {
      await refresh();
      onDone?.();
      onClose();
    },
  });
  const kind = byValue(what)!;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({
      disposition: what,
      disposedOn: String(f.get("when")),
      disposalCents: kind.amount ? toCents(f.get("amount")) : null,
      disposalNote: String(f.get("note") || "").trim() || null,
      disposedTo: what === "donated" ? String(f.get("to") || "").trim() || null : null,
      receipt: what === "donated" && f.get("receipt") instanceof File && (f.get("receipt") as File).size > 0 ? (f.get("receipt") as File) : null,
    });
  }
  return (
    <Modal id="item-gone" title={t`No longer have ${ph({ name: item.name })}?`} onClose={onClose}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <fieldset>
          <legend className="label-text mb-2"><Trans>What happened</Trans></legend>
          <div className="@container">
            <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
              {DISPOSITIONS.map((d) => (
                <label key={d.value} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-field border px-3 ${what === d.value ? "border-primary bg-primary/10" : "border-base-content/15"}`}>
                  <input type="radio" name="what" className="radio radio-primary radio-sm" checked={what === d.value} onChange={() => setWhat(d.value)} />
                  <span className={`${d.icon} size-5 text-base-content/70`} />
                  {t(d.label)}
                </label>
              ))}
            </div>
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="gone-when">
              <Trans>When</Trans>
            </label>
            <input id="gone-when" name="when" type="date" className="input" defaultValue={today()} max={today()} required />
          </div>
          {kind.amount && (
            <div>
              <label className="label-text" htmlFor="gone-amount">
                {t(kind.amount)}
              </label>
              <div className="input">
                <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
                <input id="gone-amount" name="amount" className="grow" inputMode="decimal" placeholder="optional" />
              </div>
            </div>
          )}
        </div>
        {what === "donated" && (
          <>
            <div>
              <label className="label-text" htmlFor="gone-to">
                <Trans>Given to</Trans>
              </label>
              <input id="gone-to" name="to" className="input" maxLength={200} placeholder={t`e.g. the charity or organisation`} />
            </div>
            <div>
              <label className="label-text" htmlFor="gone-receipt">
                <Trans>Receipt (optional)</Trans>
              </label>
              <input id="gone-receipt" name="receipt" type="file" className="input" accept="image/*,application/pdf" />
            </div>
          </>
        )}
        <div>
          <label className="label-text" htmlFor="gone-note">
            <Trans>Note</Trans>
          </label>
          <input
            id="gone-note"
            name="note"
            className="input"
            maxLength={2000}
            placeholder={what === "stolen" ? t`e.g. from the garage — police report 26-1234` : what === "sold" ? t`e.g. to a neighbour, on Marketplace` : "optional"}
          />
        </div>
        <p className="text-sm text-base-content/70">
          <Trans>It leaves your lists, totals and the insurance report, and its maintenance stops — but it keeps its page, photos and
          history, and you can bring it back.</Trans>
        </p>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {t(kind.past)}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** On a gone thing's page: what happened, and "Bring it back". */
export function GoneBanner({ item, householdId }: { item: ItemListing; householdId: string }) {
  const refresh = useRefreshAll(householdId);
  const canEdit = useCanEdit(householdId);
  const back = useMutation({ mutationFn: () => api.updateItem(item.id, { disposition: null }), onSuccess: refresh });
  const kind = byValue(item.disposition);
  if (!kind) return null;
  return (
    <div className="alert alert-soft alert-warning flex flex-wrap items-center gap-3" role="status">
      <span className={`${kind.icon} size-6 shrink-0`} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {t(kind.past)}
          {item.disposedOn ? t` on ${ph({ formatDate: formatDate(item.disposedOn) })}` : ""}
          {item.disposedTo ? t` to ${ph({ to: item.disposedTo })}` : ""}
          {item.disposalCents != null
            ? kind.value === "sold"
              ? t` — for ${ph({ amount: money(item.disposalCents) })}`
              : kind.value === "donated"
                ? t` — worth ${ph({ amount: money(item.disposalCents) })}`
                : t` — insurance paid ${ph({ amount: money(item.disposalCents) })}`
            : ""}
        </p>
        {item.disposalNote && <p className="text-sm">{item.disposalNote}</p>}
        <p className="text-sm"><Trans>Not in your lists or totals any more.</Trans></p>
      </div>
      {canEdit && (
        <button type="button" className="btn btn-soft btn-sm" disabled={back.isPending} onClick={() => back.mutate()}>
          <Trans>Bring it back</Trans>
        </button>
      )}
      {back.isError && <p className="w-full text-sm text-error">{back.error.message}</p>}
    </div>
  );
}

/** #/past — things you no longer have, by what happened; lost and stolen things can be downloaded for a claim. */
export function Past({ householdId }: { householdId: string }) {
  const past = useQuery({ queryKey: ["past", householdId], queryFn: () => api.listItems(undefined, { gone: true, limit: 200 }) });
  const items = past.data?.data ?? [];
  const lostOrStolen = items.filter((i) => i.disposition === "lost" || i.disposition === "stolen");
  const donated = useQuery({ queryKey: ["past", householdId, "donations"], queryFn: () => api.donations() });
  const years = donated.data?.years ?? [];
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={t`Back`}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold"><Trans>Past things</Trans></h1>
          <HelpLink page="guide/past-things.html" label={t`Past things`} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {past.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {past.isError && <div className="alert alert-soft alert-error">{past.error.message}</div>}
        {past.data && items.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--history] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Nothing here yet</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>When you sell, give away, donate, throw out, lose or have something stolen, mark it on its page (Edit → No longer have
                it?). It leaves your lists and totals and comes here.</Trans>
              </p>
            </div>
          </div>
        )}
        {lostOrStolen.length > 0 && (
          <div className="alert alert-soft alert-info flex flex-wrap items-center gap-3">
            <span className="icon-[tabler--file-spreadsheet] size-6 shrink-0" />
            <p className="min-w-0 flex-1 text-sm">
              {plural(lostOrStolen.length, { one: "# lost or stolen thing — the list an insurer asks for, with what happened and when.", other: "# lost or stolen things — the list an insurer asks for, with what happened and when." })}
            </p>
            <Trans><a className="btn btn-soft btn-info btn-sm" href="/api/v1/export/items.csv?gone=lost" download>
              Download for a claim (CSV)
            </a></Trans>
          </div>
        )}
        {years.length > 0 && (
          <section className="card" aria-labelledby="past-donation-years">
            <div className="card-body gap-2 p-4 sm:p-6">
              <h2 id="past-donation-years" className="card-title flex items-center gap-2 text-base">
                <span className="icon-[tabler--receipt] size-5 text-primary" />
                <Trans>Donations by year</Trans>
              </h2>
              <p className="text-sm text-base-content/70">
                <Trans>What you gave, to whom and what it was worth — to print or download for your records. Whether any of it is tax-deductible is for you or your accountant to decide.</Trans>
              </p>
              <ul className="divide-y divide-base-content/10">
                {years.map((y) => (
                  <li key={y.year}>
                    <a href={donationsHref(y.year)} className="flex min-h-11 items-center gap-3 py-2 hover:bg-base-200">
                      <span className="flex-1 font-medium">{y.year}</span>
                      <span className="text-sm text-base-content/70">{plural(y.count, { one: "# thing", other: "# things" })}</span>
                      <span className="w-24 text-end text-sm">{money(y.valueCents)}</span>
                      <span className="icon-[tabler--chevron-right] size-4 text-base-content/40" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
        {DISPOSITIONS.map((d) => {
          const group = items.filter((i) => i.disposition === d.value);
          if (!group.length) return null;
          const total = group.reduce((n, i) => n + (i.disposalCents ?? 0), 0);
          return (
            <section key={d.value} className="card" aria-labelledby={`past-${d.value}`}>
              <div className="card-body gap-2 p-4 sm:p-6">
                <h2 id={`past-${d.value}`} className="card-title flex items-center gap-2 text-base">
                  <span className={`${d.icon} size-5 text-primary`} />
                  {t(d.past)}
                  <span className="badge badge-soft">{group.length}</span>
                  {d.amount && total > 0 && <span className="ms-auto text-sm font-normal text-base-content/70">{money(total)}</span>}
                </h2>
                <ul className="divide-y divide-base-content/10">
                  {group.map((i) => (
                    <li key={i.id}>
                      <a href={itemHref(i.id)} className="flex min-h-11 items-center gap-3 py-2 hover:bg-base-200">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{i.name}</span>
                          {(i.disposedTo || i.disposalNote) && (
                            <span className="block truncate text-sm text-base-content/70">{[i.disposedTo, i.disposalNote].filter(Boolean).join(" — ")}</span>
                          )}
                        </span>
                        <span className="shrink-0 text-end text-sm text-base-content/70">
                          {i.disposedOn ? formatDate(i.disposedOn) : ""}
                          {i.disposalCents != null && <span className="block">{money(i.disposalCents)}</span>}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}

/** #/donations/:year — one year's donations on a page that prints (or as a CSV). Records only; no tax advice. */
export function Donations({ year, householdId, householdName }: { year: number; householdId: string; householdName: string }) {
  const list = useQuery({ queryKey: ["past", householdId, "donations", year], queryFn: () => api.donations(year) });
  const { data: session } = authClient.useSession();
  const rows = list.data?.data ?? [];
  const total = rows.reduce((n, r) => n + (r.valueCents ?? 0), 0);
  const charities = [...new Set(rows.map((r) => r.charity ?? t`Not recorded`))];
  return (
    <div className="min-h-dvh bg-base-200 print:bg-white">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4 print:hidden">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href={PAST_HREF} className="btn btn-text btn-sm btn-square" aria-label={t`Back`}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{t`Donations in ${year}`}</h1>
          <HelpLink page="guide/past-things.html#donations" label={t`Donations`} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] print:max-w-none print:p-0">
        <section className="card print:hidden">
          <div className="card-body flex-row flex-wrap gap-3 p-4 sm:p-6">
            <button type="button" className="btn btn-wrap btn-primary" disabled={!rows.length} onClick={() => window.print()}>
              <span className="icon-[tabler--printer] size-5" />
              <Trans>Print or save as PDF</Trans>
            </button>
            <a className="btn btn-wrap btn-soft btn-primary" href={api.donationsCsvUrl(year)} download>
              <span className="icon-[tabler--file-spreadsheet] size-5" />
              <Trans>Download spreadsheet (CSV)</Trans>
            </a>
          </div>
        </section>
        {list.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {list.data && (
          <article className="rounded-box bg-white p-6 text-black shadow-sm print:rounded-none print:p-0 print:shadow-none sm:p-10">
            <header className="border-b border-gray-300 pb-4">
              <p className="text-sm text-gray-600"><Trans>🐾 Ferret · Donations</Trans></p>
              <h2 className="mt-1 text-2xl font-bold">{t`${householdName} — donations in ${year}`}</h2>
              <p className="mt-1 text-sm text-gray-600">
                <Trans>Prepared {ph({ date: formatDate(today()) })}</Trans>
                {session?.user.name ? t` by ${ph({ name: session.user.name })}` : ""}
              </p>
              <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
                <div>
                  <dt className="text-xs text-gray-600"><Trans>Things given</Trans></dt>
                  <dd className="text-xl font-semibold">{rows.length}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600"><Trans>Worth when given</Trans></dt>
                  <dd className="text-xl font-semibold">{money(total)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-600"><Trans>Given to</Trans></dt>
                  <dd className="text-xl font-semibold">{charities.length}</dd>
                </div>
              </dl>
            </header>
            {rows.length === 0 ? (
              <p className="py-6 text-gray-600"><Trans>Nothing was marked donated in this year.</Trans></p>
            ) : (
              <div className="overflow-x-auto">
                <table className="mt-4 w-full text-left text-[9.5pt]">
                  <thead>
                    <tr className="border-b border-gray-300 text-gray-600">
                      <th className="py-1 pe-2 font-medium"><Trans>Date</Trans></th>
                      <th className="py-1 pe-2 font-medium"><Trans>Given to</Trans></th>
                      <th className="py-1 pe-2 font-medium"><Trans>What</Trans></th>
                      <th className="py-1 pe-2 font-medium"><Trans>Condition</Trans></th>
                      <th className="py-1 pe-2 text-end font-medium"><Trans>Paid</Trans></th>
                      <th className="py-1 text-end font-medium"><Trans>Worth</Trans></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="break-inside-avoid border-t border-gray-200 align-top">
                        <td className="whitespace-nowrap py-1 pe-2">{r.donatedOn ? formatDate(r.donatedOn) : ""}</td>
                        <td className="py-1 pe-2">{r.charity ?? ""}</td>
                        <td className="py-1 pe-2">
                          <a href={itemHref(r.id)} className="font-medium print:no-underline">{r.quantity > 1 ? `${r.quantity} × ${r.name}` : r.name}</a>
                          {(r.brand || r.model) && <span className="block text-gray-600">{[r.brand, r.model].filter(Boolean).join(" ")}</span>}
                          {r.note && <span className="block text-gray-600">{r.note}</span>}
                          {r.documents > 0 && <span className="block text-gray-600">{plural(r.documents, { one: "Receipt or document on file", other: "# receipts or documents on file" })}</span>}
                        </td>
                        <td className="py-1 pe-2">{r.condition ? conditionWord(r.condition) : ""}</td>
                        <td className="whitespace-nowrap py-1 pe-2 text-end text-gray-600">{r.purchasePriceCents != null ? money(r.purchasePriceCents) : ""}</td>
                        <td className="whitespace-nowrap py-1 text-end font-semibold">{r.valueCents != null ? money(r.valueCents) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-400">
                      <td colSpan={5} className="py-1 pe-2 font-semibold"><Trans>Total</Trans></td>
                      <td className="py-1 text-end font-semibold">{money(total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="mt-6 text-xs text-gray-600">
              <Trans>A record of what was given and what it was worth as entered in Ferret. It isn't a receipt from the organisation, and it says nothing about what's deductible.</Trans>
            </p>
          </article>
        )}
      </main>
    </div>
  );
}
