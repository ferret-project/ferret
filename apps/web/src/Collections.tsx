/**
 * Collections (server: lib/collections.ts): coins, Barbies, baseball cards — things kept as a set.
 *
 *   #/collections            every collection: what's owned, the want list, what it's worth
 *   #/collection/<id>        one: what you have and what you're looking for (?show=wanted), as photo tiles or a table
 *                            whose columns are its template's fields; "+ Add" puts something in it (had or wanted);
 *                            100 at a time, and the tiles crop photos square or show them whole (per device)
 *
 * The want list is things not owned yet (`wanted`): the server leaves them out of totals, the insurance report and
 * search; "Got it" moves one into what you have.
 */
import type { CollectionSummary, CustomFieldValues, ItemListing } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { CustomFieldInputs } from "./Catalog";
import { Pager } from "./Everything";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { navigateTo } from "./lib/navigate";
import { COLLECTIONS_HREF, collectionHref, itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { BarSearch } from "./Nav";
import { templateIcon, useTemplates } from "./Templates";
import { money, currencySymbol, toCents } from "./lib/money";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

export const collectionsKey = (householdId: string) => ["collections", householdId];
export function useCollections(householdId: string) {
  return useQuery({ queryKey: collectionsKey(householdId), queryFn: async () => (await api.collections()).data });
}

/** A collection's things a page at a time (a big one — cards, coins — runs to thousands). */
const COLLECTION_PAGE = 100;

/** A per-device choice kept in localStorage (private windows: this visit only). */
function useDeviceChoice<T extends string>(key: string, values: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return values.includes(v as T) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const pick = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // this visit only
    }
  };
  return [value, pick] as const;
}

const things = (n: number) => plural(n, { one: "# thing", other: "# things" });
/** Owned ÷ everything on its list, when there's a want list. */
const complete = (c: CollectionSummary) => (c.wanted ? Math.round((c.owned / (c.owned + c.wanted)) * 100) : null);

function Bar({ title, back, actions }: { title: string; back: string; actions?: React.ReactNode }) {
  return (
    <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
      <div className="navbar-start w-full min-w-0 items-center gap-2">
        <a href={back} className="btn btn-text btn-sm btn-square" aria-label={t`Back`}>
          <span className="icon-[tabler--arrow-left] size-5" />
        </a>
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        <HelpLink page="guide/collections.html" label={t`Collections`} />
      </div>
      <BarSearch />
      {actions && <div className="ms-2 flex shrink-0 items-center gap-2">{actions}</div>}
    </nav>
  );
}

// ── #/collections ───────────────────────────────────────────────────────────
export function CollectionsScreen({ householdId }: { householdId: string }) {
  const collections = useCollections(householdId);
  const templates = useTemplates(householdId);
  const canEdit = useCanEdit(householdId);
  const [adding, setAdding] = useState(false);
  return (
    <div className="min-h-dvh bg-base-200">
      <Bar
        title={t`Collections`}
        back="#/"
        actions={
          canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              <Trans>Collection</Trans>
            </button>
          )
        }
      />
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {collections.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {collections.data?.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--stack-2] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Start a collection</Trans></h2>
              <p className="max-w-md text-sm text-base-content/70">
                <Trans>Coins, dolls, trading cards, records — keep them together, with the details that matter for each kind (year,
                grade, edition…), what they're worth, and a want list of the ones you're still looking for.</Trans>
              </p>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                  <Trans>Start a collection</Trans>
                </button>
              )}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.data?.map((c) => {
            const tpl = templates.data?.find((x) => x.id === c.templateId);
            const pct = complete(c);
            return (
              <a key={c.id} href={collectionHref(c.id)} className="card shadow-none transition-colors hover:bg-base-100/70">
                <div className="card-body flex-row items-center gap-4 p-4">
                  {c.photoId ? (
                    <img src={api.thumbnailUrl(c.photoId)} alt="" className="size-16 shrink-0 rounded-box object-cover" />
                  ) : (
                    <span className="flex size-16 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
                      <span className={`${tpl ? templateIcon(tpl) : "icon-[tabler--stack-2]"} size-7`} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold text-base-content">{c.name}</h2>
                    <p className="text-sm text-base-content/70">
                      {things(c.owned)}
                      {c.wanted > 0 && t` · ${ph({ wanted: c.wanted })} wanted`}
                    </p>
                    {c.valueCents > 0 && <p className="text-sm font-medium text-base-content">{money(c.valueCents)}</p>}
                    {pct !== null && <Completion percent={pct} className="mt-1 h-1.5" />}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </main>
      {adding && (
        <CollectionDialog
          householdId={householdId}
          onClose={() => setAdding(false)}
          onSaved={(c) => {
            setAdding(false);
            navigateTo(collectionHref(c.id));
          }}
        />
      )}
    </div>
  );
}

// ── #/collection/:id ────────────────────────────────────────────────────────
export function CollectionScreen({ householdId, id, show }: { householdId: string; id: string; show: "owned" | "wanted" }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const collection = useQuery({ queryKey: [...collectionsKey(householdId), id], queryFn: () => api.collection(id) });
  const templates = useTemplates(householdId);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [id, show]);
  const items = useQuery({
    queryKey: ["items", householdId, "collection", id, show, page],
    queryFn: () =>
      api.listItems(undefined, { collectionId: id, wanted: show === "wanted" ? "only" : undefined, sort: "name", dir: "asc", limit: COLLECTION_PAGE, offset: page * COLLECTION_PAGE }),
    placeholderData: (previous) => previous, // keep the page showing while the next one loads
  });
  const total = items.data?.total ?? 0;
  const [view, pickView] = useDeviceChoice("ferret.collectionView", ["grid", "table"] as const, "grid");
  // Photo tiles: cropped square (tidy) or the whole photo fitted in the square (nothing cut off).
  const [fit, pickFit] = useDeviceChoice("ferret.collectionPhotoFit", ["crop", "whole"] as const, "crop");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: collectionsKey(householdId) }), qc.invalidateQueries({ queryKey: ["items", householdId] })]);
  const got = useMutation({ mutationFn: (itemId: string) => api.updateItem(itemId, { wanted: false }), onSuccess: refresh });

  const c = collection.data;
  const template = templates.data?.find((tpl) => tpl.id === c?.templateId);
  const fields = template?.fields ?? [];
  const pct = c ? complete(c) : null;

  return (
    <div className="min-h-dvh bg-base-200">
      <Bar
        title={c?.name ?? t`Collection`}
        back={COLLECTIONS_HREF}
        actions={
          canEdit &&
          c && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              <Trans>Add</Trans>
            </button>
          )
        }
      />
      <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {collection.isError && <div className="alert alert-soft alert-error">{collection.error.message}</div>}
        {c && (
          <section className="card">
            <div className="card-body gap-3 p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-base-content/70">
                    <span className={`${template ? templateIcon(template) : "icon-[tabler--stack-2]"} size-4`} />
                    {template ? template.name : t`Collection`}
                  </p>
                  {c.description && <p className="mt-1 max-w-prose text-base-content/80">{c.description}</p>}
                </div>
                {canEdit && (
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => setEditing(true)}>
                    <span className="icon-[tabler--pencil] size-4" />
                    <Trans>Edit</Trans>
                  </button>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-3 @container sm:grid-cols-4">
                <Stat label={t`Have`} value={things(c.owned)} detail={c.pieces > c.owned ? t`${ph({ pieces: c.pieces })} pieces with duplicates` : undefined} />
                <Stat label={t`Worth`} value={money(c.valueCents)} detail={c.costCents ? t`paid ${ph({ amount: money(c.costCents) })}` : undefined} />
                <Stat label={t`Wanted`} value={things(c.wanted)} />
                {pct !== null && <Stat label={t`Complete`} value={`${pct}%`} />}
              </dl>
              {pct !== null && <Completion percent={pct} className="h-2" />}
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="join" role="tablist" aria-label={t`Show`}>
            <a href={collectionHref(id)} role="tab" aria-selected={show === "owned"} className={`btn join-item btn-sm ${show === "owned" ? "btn-primary" : "btn-soft"}`}>
              <Trans>Have</Trans> {c ? `(${c.owned})` : ""}
            </a>
            <a href={collectionHref(id, "wanted")} role="tab" aria-selected={show === "wanted"} className={`btn join-item btn-sm ${show === "wanted" ? "btn-primary" : "btn-soft"}`}>
              <Trans>Want list</Trans> {c ? `(${c.wanted})` : ""}
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {view === "grid" && (
              <button
                type="button"
                className={`btn btn-sm ${fit === "whole" ? "btn-primary" : "btn-soft"}`}
                aria-pressed={fit === "whole"}
                onClick={() => pickFit(fit === "whole" ? "crop" : "whole")}
                title={fit === "whole" ? t`Showing whole photos — tap to crop them square` : t`Show whole photos, not cropped`}
              >
                <span className={`${fit === "whole" ? "icon-[tabler--arrows-minimize]" : "icon-[tabler--arrows-maximize]"} size-4`} />
                <Trans>Whole photos</Trans>
              </button>
            )}
            <div className="join" role="radiogroup" aria-label={t`View`}>
              <button type="button" role="radio" aria-checked={view === "grid"} className={`btn join-item btn-sm ${view === "grid" ? "btn-primary" : "btn-soft"}`} onClick={() => pickView("grid")} aria-label={t`Photos`}>
                <span className="icon-[tabler--layout-grid] size-4" />
              </button>
              <button type="button" role="radio" aria-checked={view === "table"} className={`btn join-item btn-sm ${view === "table" ? "btn-primary" : "btn-soft"}`} onClick={() => pickView("table")} aria-label={t`Table`}>
                <span className="icon-[tabler--table] size-4" />
              </button>
            </div>
          </div>
        </div>

        {items.isPending && <span className="loading loading-spinner mx-auto my-8 text-primary" />}
        {items.data?.data.length === 0 && (
          <p className="py-10 text-center text-base-content/70">
            {show === "wanted" ? t`Nothing on the want list — add the ones you're still looking for.` : t`Nothing in it yet — add the first one.`}
          </p>
        )}
        {items.data && items.data.data.length > 0 && view === "grid" && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {items.data.data.map((it) => (
              <li key={it.id} className="card overflow-hidden shadow-none">
                <a href={itemHref(it.id)} className="block">
                  {it.photoId ? (
                    <img src={api.thumbnailUrl(it.photoId)} alt="" className={`aspect-square w-full ${fit === "whole" ? "bg-base-300 object-contain" : "object-cover"} ${it.wanted ? "opacity-60 grayscale" : ""}`} />
                  ) : (
                    <span className="flex aspect-square w-full items-center justify-center bg-base-300 text-base-content/40">
                      <span className={`${template ? templateIcon(template) : "icon-[tabler--photo]"} size-10`} />
                    </span>
                  )}
                  <div className="p-3">
                    <p className="line-clamp-2 text-sm font-medium text-base-content">{it.name}</p>
                    <p className="text-xs text-base-content/70">
                      {[fields[0] && it.customFields?.[fields[0].key], it.quantity > 1 && `×${it.quantity}`, it.valueCents != null && money(it.valueCents * Math.max(it.quantity, 1))]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </a>
                {it.wanted && canEdit && <GotIt onClick={() => got.mutate(it.id)} busy={got.isPending} />}
              </li>
            ))}
          </ul>
        )}
        {items.data && items.data.data.length > 0 && view === "table" && (
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th><Trans>Name</Trans></th>
                  {fields.map((f) => (
                    <th key={f.key}>{f.label}</th>
                  ))}
                  <th className="text-end"><Trans>Qty</Trans></th>
                  <th className="text-end"><Trans>Worth</Trans></th>
                  {show === "wanted" && canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {items.data.data.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <a href={itemHref(it.id)} className="link link-hover font-medium">
                        {it.name}
                      </a>
                    </td>
                    {fields.map((f) => (
                      <td key={f.key}>
                        {it.customFields?.[f.key] ?? <span className="text-base-content/40">—</span>}
                        {f.unit && it.customFields?.[f.key] != null ? ` ${f.unit}` : ""}
                      </td>
                    ))}
                    <td className="text-end">{it.quantity}</td>
                    <td className="text-end">{it.valueCents != null ? money(it.valueCents * Math.max(it.quantity, 1)) : "—"}</td>
                    {show === "wanted" && canEdit && (
                      <td className="text-end">
                        <button type="button" className="btn btn-soft btn-primary btn-xs" disabled={got.isPending} onClick={() => got.mutate(it.id)}>
                          <Trans>Got it</Trans>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > COLLECTION_PAGE && (
          <Pager page={page} pages={Math.ceil(total / COLLECTION_PAGE)} total={total} onPage={setPage} size={COLLECTION_PAGE} />
        )}
      </main>
      {editing && c && <CollectionDialog householdId={householdId} collection={c} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), void refresh())} />}
      {adding && c && <AddToCollection householdId={householdId} collection={c} wanted={show === "wanted"} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), void refresh())} />}
    </div>
  );
}

/** How complete a collection is (FlyonUI's progress: a track and its bar). */
function Completion({ percent, className }: { percent: number; className: string }) {
  return (
    <span className={`progress flex w-full ${className}`} role="progressbar" aria-label={t`${percent}% complete`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <span className={`progress-bar ${percent === 100 ? "progress-success" : "progress-primary"}`} style={{ width: `${percent}%` }} />
    </span>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <dt className="text-sm text-base-content/70">{label}</dt>
      <dd className="text-lg font-semibold text-base-content">{value}</dd>
      {detail && <dd className="text-xs text-base-content/70">{detail}</dd>}
    </div>
  );
}

function GotIt({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <div className="px-3 pb-3">
      <button type="button" className="btn btn-soft btn-primary btn-sm w-full" disabled={busy} onClick={onClick}>
        <span className="icon-[tabler--check] size-4" />
        <Trans>Got it</Trans>
      </button>
    </div>
  );
}

/** Start or change a collection: its name, what it's of (a template), a few words about it. */
function CollectionDialog(props: { householdId: string; collection?: CollectionSummary; onClose: () => void; onSaved: (c: CollectionSummary) => void }) {
  const { collection, householdId, onClose } = props;
  const templates = useTemplates(householdId);
  const qc = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useMutation({
    mutationFn: (input: { name: string; description: string | null; templateId: string | null }) =>
      collection ? api.updateCollection(collection.id, input) : api.createCollection(input),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: collectionsKey(householdId) });
      props.onSaved(c);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCollection(collection!.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: collectionsKey(householdId) });
      navigateTo(COLLECTIONS_HREF);
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({
      name: String(f.get("name")).trim(),
      description: String(f.get("description") ?? "").trim() || null,
      templateId: String(f.get("templateId") ?? "") || null,
    });
  }
  return (
    <Modal id="collection-dialog" title={collection ? t`Edit ${ph({ name: collection.name })}` : t`Start a collection`} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div>
            <label className="label-text" htmlFor="collection-name">
              <Trans>Name</Trans>
            </label>
            <input id="collection-name" name="name" className="input" defaultValue={collection?.name} placeholder={t`e.g. Morgan silver dollars`} maxLength={80} required autoFocus />
          </div>
          <div>
            <label className="label-text" htmlFor="collection-template">
              <Trans>What it's of</Trans>
            </label>
            <select id="collection-template" name="templateId" className="select" defaultValue={collection?.templateId ?? ""}>
              <option value="">{t`Anything (no template)`}</option>
              {templates.data?.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
            <p className="helper-text">
              <Trans>The template's details (a coin's year, mint mark, grade…) are the collection's columns, and what you add starts from it.</Trans>
              {!templates.data?.length && t` Add templates under Categories & tags.`}
            </p>
          </div>
          <div>
            <label className="label-text" htmlFor="collection-description">
              <Trans>About it <span className="text-base-content/70">(optional)</span></Trans>
            </label>
            <textarea id="collection-description" name="description" className="textarea" rows={2} maxLength={2000} defaultValue={collection?.description ?? ""} />
          </div>
        </div>
        {collection && (
          <div className="rounded-box bg-base-200 p-3 text-sm">
            {!confirmRemove ? (
              <button type="button" className="btn btn-text btn-error btn-sm" onClick={() => setConfirmRemove(true)}>
                <Trans>Remove this collection</Trans>
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {collection.wanted
                    ? t`Remove it? The ${ph({ owned: collection.owned })} you have stay in Ferret; the ${ph({ wanted: collection.wanted })} on the want list go to Recently deleted.`
                    : t`Remove it? The ${ph({ owned: collection.owned })} you have stay in Ferret.`}
                </span>
                <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  <Trans>Remove</Trans>
                </button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmRemove(false)}>
                  <Trans>Keep</Trans>
                </button>
              </div>
            )}
          </div>
        )}
        {(save.isError || remove.isError) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {collection ? t`Save` : t`Start it`}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** "+ Add" on a collection: had or wanted, with its template's details. */
function AddToCollection(props: { householdId: string; collection: CollectionSummary; wanted: boolean; onClose: () => void; onSaved: () => void }) {
  const { collection, householdId } = props;
  const templates = useTemplates(householdId);
  const template = templates.data?.find((tpl) => tpl.id === collection.templateId);
  const [wanted, setWanted] = useState(props.wanted);
  const [custom, setCustom] = useState<CustomFieldValues>({});
  const [another, setAnother] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (input: { name: string; quantity: number; valueCents: number | null }) =>
      api.createItem({ ...input, collectionId: collection.id, wanted, customFields: custom }),
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const name = String(f.get("name")).trim();
    add.mutate(
      { name, quantity: Math.max(1, Number(f.get("quantity")) || 1), valueCents: toCents(f.get("value")) },
      {
        onSuccess: (made: ItemListing | { id: string }) => {
          if (another) {
            // Straight on to the next one (a stack of cards…): the same details kept, the name cleared.
            setAdded(name);
            (form.elements.namedItem("name") as HTMLInputElement).value = "";
            (form.elements.namedItem("name") as HTMLInputElement).focus();
            props.onSaved();
          } else {
            props.onSaved();
            navigateTo(itemHref(made.id));
          }
        },
      },
    );
  }
  return (
    <Modal id="add-to-collection" title={t`Add to ${ph({ name: collection.name })}`} onClose={props.onClose}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <div className="join w-full" role="radiogroup" aria-label={t`Have it or want it`}>
          <button type="button" role="radio" aria-checked={!wanted} className={`btn join-item grow ${!wanted ? "btn-primary" : "btn-soft"}`} onClick={() => setWanted(false)}>
            <Trans>I have it</Trans>
          </button>
          <button type="button" role="radio" aria-checked={wanted} className={`btn join-item grow ${wanted ? "btn-primary" : "btn-soft"}`} onClick={() => setWanted(true)}>
            <Trans>I'm looking for it</Trans>
          </button>
        </div>
        <div>
          <label className="label-text" htmlFor="collect-name">
            <Trans>What is it?</Trans>
          </label>
          <input id="collect-name" name="name" className="input" required maxLength={200} autoFocus placeholder={template?.name === "Coin" ? t`e.g. 1881-S Morgan dollar` : t`Its name`} />
        </div>
        {template && <CustomFieldInputs fields={template.fields} values={custom} onChange={setCustom} />}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="collect-quantity">
              <Trans>How many</Trans>
            </label>
            <input id="collect-quantity" name="quantity" type="number" min={1} defaultValue={1} className="input" />
          </div>
          <div>
            <label className="label-text" htmlFor="collect-value">
              {wanted ? t`Usually goes for` : t`Worth (each)`}
            </label>
            <div className="input">
              <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
              <input id="collect-value" name="value" className="grow" inputMode="decimal" />
            </div>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={another} onChange={(e) => setAnother(e.target.checked)} />
          <Trans>Add another after this one</Trans>
        </label>
        {added && (
          <div className="alert alert-soft alert-success text-sm" role="status">
            <Trans>Added {added}</Trans>.
          </div>
        )}
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={props.onClose}>
            {added ? t`Done` : t`Cancel`}
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            {wanted ? t`Add to the want list` : t`Add it`}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** The item editor's collection choice (collections are few: a plain select) and "on the want list". */
export function CollectionFields(props: {
  householdId: string;
  collectionId: string | null;
  wanted: boolean;
  onChange: (next: { collectionId: string | null; wanted: boolean }) => void;
}) {
  const collections = useCollections(props.householdId);
  if (!collections.data?.length && !props.collectionId) return null;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:items-end">
      <div>
        <label className="label-text" htmlFor="item-collection">
          <Trans>Collection</Trans>
        </label>
        <select
          id="item-collection"
          className="select"
          value={props.collectionId ?? ""}
          onChange={(e) => props.onChange({ collectionId: e.target.value || null, wanted: e.target.value ? props.wanted : false })}
        >
          <option value="">{t`None`}</option>
          {collections.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {props.collectionId && (
        <label className="flex h-11 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={props.wanted} onChange={(e) => props.onChange({ collectionId: props.collectionId, wanted: e.target.checked })} />
          <Trans>On the want list (don't have it yet)</Trans>
        </label>
      )}
    </div>
  );
}

/** On a thing's page: which collection it's in, and — on the want list — "Got it". */
/** An owned thing's collection, beside its category and tags: a link to the collection's grid. */
export function CollectionBadge({ householdId, collectionId }: { householdId: string; collectionId: string }) {
  const collections = useCollections(householdId);
  const name = collections.data?.find((x) => x.id === collectionId)?.name;
  return (
    <a href={collectionHref(collectionId)} className="tap badge badge-soft badge-accent gap-1">
      <span className="icon-[tabler--stack-2] size-3.5" />
      {name ? t`${name} collection` : t`Collection`}
    </a>
  );
}

export function CollectionBanner({ householdId, item }: { householdId: string; item: Pick<ItemListing, "id" | "collectionId" | "wanted"> }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const collections = useCollections(householdId);
  const got = useMutation({
    mutationFn: () => api.updateItem(item.id, { wanted: false }),
    onSuccess: () => Promise.all(["item", "items", "collections", "overview"].map((k) => qc.invalidateQueries({ queryKey: [k, householdId] }))),
  });
  // Owned things show their collection as a badge beside the category and tags (CollectionBadge).
  if (!item.collectionId || !item.wanted) return null;
  const c = collections.data?.find((x) => x.id === item.collectionId);
  return (
    <div className="alert alert-soft alert-info flex flex-wrap items-center gap-3" role="status">
      <span className="icon-[tabler--heart] size-5 shrink-0" />
      <span className="grow">
        <Trans>On the want list for</Trans> <a href={collectionHref(item.collectionId, "wanted")} className="link">{c?.name ?? t`its collection`}</a> <Trans>— not one of your things yet.</Trans>
      </span>
      {canEdit && (
        <button type="button" className="btn btn-primary btn-sm" disabled={got.isPending} onClick={() => got.mutate()}>
          <span className="icon-[tabler--check] size-4" />
          <Trans>Got it</Trans>
        </button>
      )}
    </div>
  );
}
