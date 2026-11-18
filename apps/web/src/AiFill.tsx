/**
 * "Let AI fill in" (server: lib/ai-fill.ts): the household's switches (Settings → Household), the server's defaults
 * (Settings → Server), an item's card of what the AI filled in (Looks right / Undo), and the household-wide list
 * (#/ai-filled). Off unless switched on; only empty fields, only what the model read plainly.
 */
import type { AiFill, AiFillEntry, AiFillKind, ItemListing } from "@ferret/shared";
import { aiFillKinds } from "@ferret/shared/utils";
import { aiFillKindWords } from "./lib/words";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { money } from "./lib/money";
import { itemHref } from "./lib/route";
import { TopBar } from "./Nav";
import { FileThumb } from "./FileThumb";
import { flattenCategories, useCategories } from "./Catalog";

/** The household's category paths by id (a category the AI filled in is shown by name). */
function useCategoryPaths(householdId: string) {
  const categories = useCategories(householdId);
  return new Map(flattenCategories(categories.data ?? []).map((c) => [c.id, c.path]));
}
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

const label = (field: string) => (LABELS[field] ? t(LABELS[field]) : field);
const LABELS: Record<string, MessageDescriptor> = {
  name: msg`Name`,
  brand: msg`Brand`,
  model: msg`Model`,
  serialNumber: msg`Serial number`,
  barcode: msg`Barcode`,
  purchaseDate: msg`Purchase date`,
  purchasePriceCents: msg`Price paid`,
  returnBy: msg`Return by`,
  categoryId: msg`Category`,
  warranty: msg`Warranty until`,
};

const show = (field: string, value: string | number, categories?: Map<string, string>) =>
  field === "categoryId"
    ? (categories?.get(String(value)) ?? t`A category since removed`)
    : field === "purchasePriceCents" ? money(Number(value), true) : /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : String(value);

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
          <Trans>Let AI fill in</Trans>
          <HelpLink page="guide/ai.html#let-ai-fill-in" label={t`Let AI fill in`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>Normally what the AI reads from photos and receipts waits as a suggestion for you to apply. Switch a kind on and it fills
          in by itself — only empty fields, only what it read plainly, each marked until someone checks it, and each can be undone.</Trans>
        </p>
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
                    <span className="block font-medium">{aiFillKindWords(k).label}</span>
                    <span className="block text-sm text-base-content/70">{aiFillKindWords(k).hint}</span>
                  </span>
                </label>
                {chosen && s.aiFill[k] !== s.aiFillDefaults[k] && canManage && (
                  <button type="button" className="tap link link-hover ms-14 self-start text-xs text-base-content/70" onClick={() => save.mutate({ [k]: null })}>
                    {s.aiFillDefaults[k] ? t`Use the server's default (on)` : t`Use the server's default (off)`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-base-content/70">
          <Trans>Never by itself: merging duplicates, values or replacement costs, renaming what you named, marking things gone, or
          maintenance schedules — those always wait for you. <a className="tap link link-primary" href="#/ai-filled">See what it filled in</a></Trans>
        </p>
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
          <Trans>Let AI fill in, by default</Trans>
          <HelpLink page="guide/ai.html#let-ai-fill-in" label={t`Let AI fill in`} />
        </h2>
        <p className="text-sm text-base-content/70">
          <Trans>For households on this server that haven't chosen for themselves (Settings → Household). Off unless you switch a kind on.</Trans>
        </p>
        {aiFillKinds.map((k) => (
          <label key={k} className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" className="switch switch-primary mt-0.5" checked={defaults.data[k]} disabled={save.isPending} onChange={(e) => save.mutate({ [k]: e.target.checked })} />
            <span className="min-w-0">
              <span className="block font-medium">{aiFillKindWords(k).label}</span>
              <span className="block text-sm text-base-content/70">{aiFillKindWords(k).hint}</span>
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
  const paths = useCategoryPaths(householdId);
  const canEdit = useCanEdit(householdId);
  const { confirm, undo, busy, error } = useAiFillActions(householdId, item.id);
  const fills = Object.entries(item.aiFilled ?? {}) as [string, AiFill][];
  if (!fills.length) return null;
  return (
    <section className="card border border-primary/20" aria-label={t`Filled in by AI`}>
      <div className="card-body gap-2 p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="badge badge-soft badge-primary badge-sm"><Trans>AI</Trans></span>
          {plural(fills.length, { one: "Filled in by AI — check it", other: "Filled in by AI — check these" })}
        </h2>
        <ul className="divide-base-content/10 flex flex-col divide-y">
          {fills.map(([field, f]) => (
            <li key={field} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="w-28 shrink-0 text-sm text-base-content/70">{label(field)}</span>
              {f.attachmentId && <FileThumb attachmentId={f.attachmentId} filename={f.from} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{show(field, f.value, paths)}</span>
                {f.from && <span className="block truncate text-xs text-base-content/70"><Trans>from {ph({ from: f.from })}</Trans></span>}
              </span>
              {canEdit && (
                <span className="flex gap-1">
                  <button type="button" className="btn btn-text btn-primary btn-sm" disabled={busy} onClick={() => confirm.mutate({ itemId: item.id, field })} aria-label={t`${ph({ field: label(field) })} looks right`}>
                    <Trans>Looks right</Trans>
                  </button>
                  <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => undo.mutate({ itemId: item.id, field })} aria-label={t`Undo ${ph({ field: label(field) })}`}>
                    <Trans>Undo</Trans>
                  </button>
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
  const paths = useCategoryPaths(householdId);
  const canEdit = useCanEdit(householdId);
  const list = useQuery({ queryKey: ["ai-fills", householdId], queryFn: api.aiFills });
  const { confirm, undo, busy, error } = useAiFillActions(householdId);
  const rows = list.data?.data ?? [];
  const byItem = new Map<string, AiFillEntry[]>();
  for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar
        title={<Trans>Filled in by AI</Trans>}
        back="#/"
        help={<HelpLink page="guide/ai.html#let-ai-fill-in" label={t`Let AI fill in`} />}
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {list.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {list.isError && <div className="alert alert-soft alert-error">{list.error.message}</div>}
        {error && <div className="alert alert-soft alert-error">{error.message}</div>}
        {list.data && rows.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--sparkles] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Nothing to check</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>When the household lets AI fill in (Settings → Household), what it fills in waits here until someone says it looks right.</Trans>
              </p>
              <Trans><a href="#/settings" className="btn btn-soft btn-primary btn-sm">
                Settings
              </a></Trans>
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
                    <span className="w-28 shrink-0 text-sm text-base-content/70">{e.field in LABELS ? label(e.field) : e.label}</span>
                    {e.attachmentId && <FileThumb attachmentId={e.attachmentId} filename={e.from} />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{show(e.field, e.value, paths)}</span>
                      <span className="block truncate text-xs text-base-content/70">
                        {e.from ? t`from ${ph({ from: e.from })} · ${ph({ date: new Date(e.at).toLocaleDateString() })}` : new Date(e.at).toLocaleDateString()}
                      </span>
                    </span>
                    {canEdit && (
                      <span className="flex gap-1">
                        <button type="button" className="btn btn-text btn-primary btn-sm" disabled={busy} onClick={() => confirm.mutate(e)}>
                          <Trans>Looks right</Trans>
                        </button>
                        <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => undo.mutate(e)}>
                          <Trans>Undo</Trans>
                        </button>
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
