import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Item lifecycle: things you no longer have — sold, given away, thrown out, lost, stolen. They leave lists, totals,
 * search, the insurance report and reminders (server: itemScope), but keep their page and history, and can be brought
 * back. GoneDialog marks one; GoneBanner sits on its page; Past (#/past) lists them, with lost and stolen things
 * downloadable for a claim.
 */
import { BarSearch } from "./Nav";
import type { ItemDisposition, ItemListing } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { money, currencySymbol, toCents } from "./lib/money";

export const DISPOSITIONS: { value: ItemDisposition; label: string; past: string; icon: string; amount?: string }[] = [
  { value: "sold", get label() { return translateText("Sold it"); }, get past() { return translateText("Sold"); }, icon: "icon-[tabler--cash]", get amount() { return translateText("Sold for"); } },
  { value: "given", get label() { return translateText("Gave it away"); }, get past() { return translateText("Given away"); }, icon: "icon-[tabler--gift]" },
  { value: "discarded", get label() { return translateText("Threw it out"); }, get past() { return translateText("Thrown out"); }, icon: "icon-[tabler--trash-x]" },
  { value: "lost", get label() { return translateText("Lost it"); }, get past() { return translateText("Lost"); }, icon: "icon-[tabler--map-pin-question]", get amount() { return translateText("Insurance paid"); } },
  { value: "stolen", get label() { return translateText("It was stolen"); }, get past() { return translateText("Stolen"); }, icon: "icon-[tabler--shield-x]", get amount() { return translateText("Insurance paid"); } },
];
const byValue = (v: ItemDisposition | null | undefined) => DISPOSITIONS.find((d) => d.value === v);
const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(locale(), { month: "short", day: "numeric", year: "numeric" });

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
    mutationFn: (patch: { disposition: ItemDisposition; disposedOn: string; disposalCents: number | null; disposalNote: string | null }) => api.updateItem(item.id, patch),
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
    });
  }
  return (
    <Modal id="item-gone" title={translateText("No longer have {v0}?", { v0: item.name })} onClose={onClose}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <fieldset>
          <legend className="label-text mb-2">{translateText("What happened")}</legend>
          <div className="@container">
            <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
              {DISPOSITIONS.map((d) => (
                <label key={d.value} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-field border px-3 ${what === d.value ? "border-primary bg-primary/10" : "border-base-content/15"}`}>
                  <input type="radio" name="what" className="radio radio-primary radio-sm" checked={what === d.value} onChange={() => setWhat(d.value)} />
                  <span className={`${d.icon} size-5 text-base-content/70`} />
                  {d.label}
                </label>
              ))}
            </div>
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="gone-when">
              {translateText("When")}</label>
            <input id="gone-when" name="when" type="date" className="input" defaultValue={today()} max={today()} required />
          </div>
          {kind.amount && (
            <div>
              <label className="label-text" htmlFor="gone-amount">
                {kind.amount}
              </label>
              <div className="input">
                <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
                <input id="gone-amount" name="amount" className="grow" inputMode="decimal" placeholder={translateText("optional")} />
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="label-text" htmlFor="gone-note">
            {translateText("Note")}</label>
          <input
            id="gone-note"
            name="note"
            className="input"
            maxLength={2000}
            placeholder={what === "stolen" ? translateText("e.g. from the garage — police report 26-1234") : what === "sold" ? translateText("e.g. to a neighbour, on Marketplace") : translateText("optional")}
          />
        </div>
        <p className="text-sm text-base-content/70">
          {translateText("It leaves your lists, totals and the insurance report, and its maintenance stops — but it keeps its page, photos and history, and you can bring it back.")}</p>
        {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {kind.past}
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
          {kind.past}
          {item.disposedOn ? translateText(" on {v0}", { v0: formatDate(item.disposedOn) }) : ""}
          {item.disposalCents != null ? (kind.value === "sold" ? translateText(" — sale price: {v0}", { v0: money(item.disposalCents) }) : translateText(" — insurance paid: {v0}", { v0: money(item.disposalCents) })) : ""}
        </p>
        {item.disposalNote && <p className="text-sm">{item.disposalNote}</p>}
        <p className="text-sm">{translateText("Not in your lists or totals any more.")}</p>
      </div>
      {canEdit && (
        <button type="button" className="btn btn-soft btn-sm" disabled={back.isPending} onClick={() => back.mutate()}>
          {translateText("Bring it back")}</button>
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
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{translateText("Past things")}</h1>
          <HelpLink page="guide/past-things.html" label={translateText("Past things")} />
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
              <h2 className="text-lg font-semibold">{translateText("Nothing here yet")}</h2>
              <p className="max-w-sm text-sm text-base-content/70">
                {translateText("When you sell, give away, throw out, lose or have something stolen, mark it on its page (Edit → No longer have it?). It leaves your lists and totals and comes here.")}</p>
            </div>
          </div>
        )}
        {lostOrStolen.length > 0 && (
          <div className="alert alert-soft alert-info flex flex-wrap items-center gap-3">
            <span className="icon-[tabler--file-spreadsheet] size-6 shrink-0" />
            <p className="min-w-0 flex-1 text-sm">{tr("{v0} lost or stolen ", { v0: lostOrStolen.length })}{lostOrStolen.length === 1 ? translateText("thing") : translateText("things")} {translateText("— the list an insurer asks for, with what happened and when.")}</p>
            <a className="btn btn-soft btn-info btn-sm" href="/api/v1/export/items.csv?gone=lost" download>
              {translateText("Download for a claim (CSV)")}</a>
          </div>
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
                  {d.past}
                  <span className="badge badge-soft">{group.length}</span>
                  {d.amount && total > 0 && <span className="ms-auto text-sm font-normal text-base-content/70">{money(total)}</span>}
                </h2>
                <ul className="divide-y divide-base-content/10">
                  {group.map((i) => (
                    <li key={i.id}>
                      <a href={itemHref(i.id)} className="flex min-h-11 items-center gap-3 py-2 hover:bg-base-200">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{i.name}</span>
                          {i.disposalNote && <span className="block truncate text-sm text-base-content/70">{i.disposalNote}</span>}
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
