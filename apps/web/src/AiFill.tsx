import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * "Let AI fill in" (server: lib/ai-fill.ts): the household's switches (Settings → Household), the server's defaults
 * (Settings → Server), an item's card of what the AI filled in (Looks right / Undo), and the household-wide list
 * (#/ai-filled). Off unless switched on; only empty fields, only what the model read plainly.
 */
import type { AiFill, AiFillEntry, AiFillKind, ItemListing } from "@ferret/shared";
import { AI_FILL_KIND_NAMES, aiFillKinds } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { money } from "./lib/money";
import { itemHref } from "./lib/route";
import { BarSearch } from "./Nav";

const LABELS: Record<string, string> = {
  get name() { return translateText("Name"); },
  get brand() { return translateText("Brand"); },
  get model() { return translateText("Model"); },
  get serialNumber() { return translateText("Serial number"); },
  get barcode() { return translateText("Barcode"); },
  get purchaseDate() { return translateText("Purchase date"); },
  get purchasePriceCents() { return translateText("Price paid"); },
  get returnBy() { return translateText("Return by"); },
  get warranty() { return translateText("Warranty until"); },
};

const show = (field: string, value: string | number) =>
  field === "purchasePriceCents" ? money(Number(value), true) : /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00`).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" }) : String(value);

/** Settings → Household: which kinds fill in by themselves (owners and admins change them). */
export function AiFillCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["household-settings", householdId], queryFn: api.householdSettings });
  const save = useMutation({
    mutationFn: (aiFill: Partial<Record<AiFillKind, boolean | null>>) => api.setHouseholdSettings({ aiFill }),
    onSuccess: (data) => qc.setQueryData(["household-settings", householdId], data),
  });
  const s = settings.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="ai-fill-title">
      <div className="card-body gap-3">
        <h2 id="ai-fill-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--sparkles] size-5 text-primary" />
          {translateText("Let AI fill in")}<HelpLink page="guide/ai.html#let-ai-fill-in" label={translateText("Let AI fill in")} />
        </h2>
        <p className="text-sm text-base-content/70">
          {translateText("Normally what the AI reads from photos and receipts waits as a suggestion for you to apply. Switch a kind on and it fills in by itself — only empty fields, only what it read plainly, each marked until someone checks it, and each can be undone.")}</p>
        <ul className="flex flex-col gap-3">
          {aiFillKinds.map((k) => {
            const chosen = s.aiFillChosen.includes(k);
            return (
              <li key={k} className="flex flex-col gap-1">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="switch switch-primary mt-0.5"
                    checked={s.aiFill[k]}
                    disabled={!canManage || save.isPending}
                    onChange={(e) => save.mutate({ [k]: e.target.checked })}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{AI_FILL_KIND_NAMES[k].label}</span>
                    <span className="block text-sm text-base-content/70">{AI_FILL_KIND_NAMES[k].hint}</span>
                  </span>
                </label>
                {chosen && s.aiFill[k] !== s.aiFillDefaults[k] && canManage && (
                  <button type="button" className="tap link link-hover ms-14 self-start text-xs text-base-content/70" onClick={() => save.mutate({ [k]: null })}>
                    {translateText("Use the server's default (")}{s.aiFillDefaults[k] ? translateText("on") : translateText("off")})
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-base-content/70">{tr("Never by itself: merging duplicates, values or replacement costs, renaming what you named, marking things gone, or maintenance schedules — those always wait for you. {v0}", { v0: <a className="tap link link-primary" href="#/ai-filled">{translateText("See what it filled in")}</a> })}</p>
        {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
      </div>
    </section>
  );
}

/** Settings → Server: the defaults for this server's households (each can still choose for itself). */
export function ServerAiFillCard() {
  const qc = useQueryClient();
  const defaults = useQuery({ queryKey: ["server-ai-fill"], queryFn: api.serverAiFill });
  const save = useMutation({
    mutationFn: api.setServerAiFill,
    onSuccess: (data) => {
      qc.setQueryData(["server-ai-fill"], data);
      void qc.invalidateQueries({ queryKey: ["household-settings"] });
    },
  });
  if (!defaults.data) return null;
  return (
    <section className="card" aria-labelledby="server-ai-fill-title">
      <div className="card-body gap-3">
        <h2 id="server-ai-fill-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--sparkles] size-5 text-primary" />
          {translateText("Let AI fill in, by default")}<HelpLink page="guide/ai.html#let-ai-fill-in" label={translateText("Let AI fill in")} />
        </h2>
        <p className="text-sm text-base-content/70">
          {translateText("For households on this server that haven't chosen for themselves (Settings → Household). Off unless you switch a kind on.")}</p>
        {aiFillKinds.map((k) => (
          <label key={k} className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" className="switch switch-primary mt-0.5" checked={defaults.data[k]} disabled={save.isPending} onChange={(e) => save.mutate({ [k]: e.target.checked })} />
            <span className="min-w-0">
              <span className="block font-medium">{AI_FILL_KIND_NAMES[k].label}</span>
              <span className="block text-sm text-base-content/70">{AI_FILL_KIND_NAMES[k].hint}</span>
            </span>
          </label>
        ))}
        {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
      </div>
    </section>
  );
}

function useAiFillActions(householdId: string, itemId?: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["ai-fills", householdId] });
    void qc.invalidateQueries({ queryKey: ["items"] });
    void qc.invalidateQueries({ queryKey: ["item"] });
    if (itemId) void qc.invalidateQueries({ queryKey: ["warranties"] });
    void qc.invalidateQueries({ queryKey: ["history"] });
  };
  const confirm = useMutation({ mutationFn: (e: { itemId: string; field: string }) => api.confirmAiFill(e.itemId, e.field), onSuccess: done });
  const undo = useMutation({ mutationFn: (e: { itemId: string; field: string }) => api.undoAiFill(e.itemId, e.field), onSuccess: done });
  return { confirm, undo, busy: confirm.isPending || undo.isPending, error: confirm.error ?? undo.error };
}

/** On an item's page: what the AI filled in by itself, until someone checks it. */
export function AiFilledCard({ item, householdId }: { item: ItemListing; householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const { confirm, undo, busy, error } = useAiFillActions(householdId, item.id);
  const fills = Object.entries(item.aiFilled ?? {}) as [string, AiFill][];
  if (!fills.length) return null;
  return (
    <section className="card border border-primary/20" aria-label={translateText("Filled in by AI")}>
      <div className="card-body gap-2 p-4">
        <h2 className="flex items-center gap-2 font-semibold">{tr("{v0}Filled in by AI — check ", { v0: <span className="badge badge-soft badge-primary badge-sm">{translateText("AI")}</span> })}{fills.length === 1 ? translateText("it") : translateText("these")}
        </h2>
        <ul className="divide-base-content/10 flex flex-col divide-y">
          {fills.map(([field, f]) => (
            <li key={field} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="w-28 shrink-0 text-sm text-base-content/70">{LABELS[field] ?? field}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{show(field, f.value)}</span>
                {f.from && <span className="block truncate text-xs text-base-content/70">{tr("from {v0}", { v0: f.from })}</span>}
              </span>
              {canEdit && (
                <span className="flex gap-1">
                  <button type="button" className="btn btn-text btn-primary btn-sm" disabled={busy} onClick={() => confirm.mutate({ itemId: item.id, field })} aria-label={translateText("{v0} looks right", { v0: LABELS[field] ?? field })}>
                    {translateText("Looks right")}</button>
                  <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => undo.mutate({ itemId: item.id, field })} aria-label={translateText("Undo {v0}", { v0: LABELS[field] ?? field })}>
                    {translateText("Undo")}</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {error && <div className="alert alert-soft alert-error text-sm">{error.message}</div>}
      </div>
    </section>
  );
}

/** #/ai-filled: everything the AI filled in that nobody has checked yet, newest first. */
export function AiFilled({ householdId }: { householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const list = useQuery({ queryKey: ["ai-fills", householdId], queryFn: api.aiFills });
  const { confirm, undo, busy, error } = useAiFillActions(householdId);
  const rows = list.data?.data ?? [];
  const byItem = new Map<string, AiFillEntry[]>();
  for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{translateText("Filled in by AI")}</h1>
          <HelpLink page="guide/ai.html#let-ai-fill-in" label={translateText("Let AI fill in")} />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {list.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {error && <div className="alert alert-soft alert-error">{error.message}</div>}
        {list.data && rows.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--sparkles] size-10 text-primary" />
              <h2 className="text-lg font-semibold">{translateText("Nothing to check")}</h2>
              <p className="max-w-sm text-sm text-base-content/70">
                {translateText("When the household lets AI fill in (Settings → Household), what it fills in waits here until someone says it looks right.")}</p>
              <a href="#/settings" className="btn btn-soft btn-primary btn-sm">
                {translateText("Settings")}</a>
            </div>
          </div>
        )}
        {[...byItem.entries()].map(([itemId, entries]) => (
          <section key={itemId} className="card">
            <div className="card-body gap-2 p-4">
              <a href={itemHref(itemId)} className="tap link link-hover font-semibold">
                {entries[0]!.itemName}
              </a>
              <ul className="divide-base-content/10 flex flex-col divide-y">
                {entries.map((e) => (
                  <li key={e.field} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="w-28 shrink-0 text-sm text-base-content/70">{LABELS[e.field] ?? e.label}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{show(e.field, e.value)}</span>
                      <span className="block truncate text-xs text-base-content/70">
                        {e.from ? translateText("from {v0} · ", { v0: e.from }) : ""}
                        {new Date(e.at).toLocaleDateString(locale())}
                      </span>
                    </span>
                    {canEdit && (
                      <span className="flex gap-1">
                        <button type="button" className="btn btn-text btn-primary btn-sm" disabled={busy} onClick={() => confirm.mutate(e)}>
                          {translateText("Looks right")}</button>
                        <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => undo.mutate(e)}>
                          {translateText("Undo")}</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
