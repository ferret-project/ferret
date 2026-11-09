import { tn } from "./i18n";
import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Collections (server: lib/collections.ts): coins, Barbies, baseball cards — things kept as a set.
 *
 *   #/collections            every collection: what's owned, the want list, what it's worth
 *   #/collection/<id>        one: what you have and what you're looking for (?show=wanted), as photo tiles or a table
 *                            whose columns are its template's fields; "+ Add" puts something in it (had or wanted)
 *
 * The want list is things not owned yet (`wanted`): the server leaves them out of totals, the insurance report and
 * search; "Got it" moves one into what you have.
 */
import type { CollectionSummary, CustomFieldValues, ItemListing } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CustomFieldInputs } from "./Catalog";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { navigateTo } from "./lib/navigate";
import { COLLECTIONS_HREF, collectionHref, itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { BarSearch } from "./Nav";
import { templateIcon, useTemplates } from "./Templates";
import { money, currencySymbol, toCents } from "./lib/money";

export const collectionsKey = (householdId: string) => ["collections", householdId];
export function useCollections(householdId: string) {
  return useQuery({ queryKey: collectionsKey(householdId), queryFn: async () => (await api.collections()).data });
}

const things = (n: number) => tn(n, "{v0} thing", "{v0} things", { v0: n.toLocaleString(locale()) });
/** Owned ÷ everything on its list, when there's a want list. */
const complete = (c: CollectionSummary) => (c.wanted ? Math.round((c.owned / (c.owned + c.wanted)) * 100) : null);

function Bar({ title, back, actions }: { title: string; back: string; actions?: React.ReactNode }) {
  return (
    <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
      <div className="navbar-start w-full min-w-0 items-center gap-2">
        <a href={back} className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
          <span className="icon-[tabler--arrow-left] size-5" />
        </a>
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        <HelpLink page="guide/collections.html" label={translateText("Collections")} />
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
        title={translateText("Collections")}
        back="#/"
        actions={
          canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              {translateText("Collection")}</button>
          )
        }
      />
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {collections.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {collections.data?.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--stack-2] size-10 text-primary" />
              <h2 className="text-lg font-semibold">{translateText("Start a collection")}</h2>
              <p className="max-w-md text-sm text-base-content/70">
                {translateText("Coins, dolls, trading cards, records — keep them together, with the details that matter for each kind (year, grade, edition…), what they're worth, and a want list of the ones you're still looking for.")}</p>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                  {translateText("Start a collection")}</button>
              )}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.data?.map((c) => {
            const t = templates.data?.find((x) => x.id === c.templateId);
            const pct = complete(c);
            return (
              <a key={c.id} href={collectionHref(c.id)} className="card shadow-none transition-colors hover:bg-base-100/70">
                <div className="card-body flex-row items-center gap-4 p-4">
                  {c.photoId ? (
                    <img src={api.thumbnailUrl(c.photoId)} alt="" className="size-16 shrink-0 rounded-box object-cover" />
                  ) : (
                    <span className="flex size-16 shrink-0 items-center justify-center rounded-box bg-primary/10 text-primary">
                      <span className={`${t ? templateIcon(t) : "icon-[tabler--stack-2]"} size-7`} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-semibold text-base-content">{c.name}</h2>
                    <p className="text-sm text-base-content/70">
                      {things(c.owned)}
                      {c.wanted > 0 && translateText(" · {v0} wanted", { v0: c.wanted })}
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
  const items = useQuery({
    queryKey: ["items", householdId, "collection", id, show],
    queryFn: () => api.listItems(undefined, { collectionId: id, wanted: show === "wanted" ? "only" : undefined, sort: "name", dir: "asc", limit: 200 }),
  });
  const [view, setView] = useState<"grid" | "table">(() => {
    try {
      return localStorage.getItem("ferret.collectionView") === "table" ? "table" : "grid";
    } catch {
      return "grid";
    }
  });
  const pickView = (v: "grid" | "table") => {
    setView(v);
    try {
      localStorage.setItem("ferret.collectionView", v);
    } catch {
      // this visit only
    }
  };
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: collectionsKey(householdId) }), qc.invalidateQueries({ queryKey: ["items", householdId] })]);
  const got = useMutation({ mutationFn: (itemId: string) => api.updateItem(itemId, { wanted: false }), onSuccess: refresh });

  const c = collection.data;
  const template = templates.data?.find((t) => t.id === c?.templateId);
  const fields = template?.fields ?? [];
  const pct = c ? complete(c) : null;

  return (
    <div className="min-h-dvh bg-base-200">
      <Bar
        title={c?.name ?? translateText("Collection")}
        back={COLLECTIONS_HREF}
        actions={
          canEdit &&
          c && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              {translateText("Add")}</button>
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
                    {template ? template.name : translateText("Collection")}
                  </p>
                  {c.description && <p className="mt-1 max-w-prose text-base-content/80">{c.description}</p>}
                </div>
                {canEdit && (
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => setEditing(true)}>
                    <span className="icon-[tabler--pencil] size-4" />
                    {translateText("Edit")}</button>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-3 @container sm:grid-cols-4">
                <Stat label={translateText("Have")} value={things(c.owned)} detail={c.pieces > c.owned ? translateText("{v0} pieces with duplicates", { v0: c.pieces }) : undefined} />
                <Stat label={translateText("Worth")} value={money(c.valueCents)} detail={c.costCents ? translateText("paid {v0}", { v0: money(c.costCents) }) : undefined} />
                <Stat label={translateText("Wanted")} value={things(c.wanted)} />
                {pct !== null && <Stat label={translateText("Complete")} value={`${pct}%`} />}
              </dl>
              {pct !== null && <Completion percent={pct} className="h-2" />}
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="join" role="tablist" aria-label={translateText("Show")}>
            <a href={collectionHref(id)} role="tab" aria-selected={show === "owned"} className={`btn join-item btn-sm ${show === "owned" ? "btn-primary" : "btn-soft"}`}>
              {translateText("Have ")}{c ? `(${c.owned})` : ""}
            </a>
            <a href={collectionHref(id, "wanted")} role="tab" aria-selected={show === "wanted"} className={`btn join-item btn-sm ${show === "wanted" ? "btn-primary" : "btn-soft"}`}>
              {translateText("Want list ")}{c ? `(${c.wanted})` : ""}
            </a>
          </div>
          <div className="join" role="radiogroup" aria-label={translateText("View")}>
            <button type="button" role="radio" aria-checked={view === "grid"} className={`btn join-item btn-sm ${view === "grid" ? "btn-primary" : "btn-soft"}`} onClick={() => pickView("grid")} aria-label={translateText("Photos")}>
              <span className="icon-[tabler--layout-grid] size-4" />
            </button>
            <button type="button" role="radio" aria-checked={view === "table"} className={`btn join-item btn-sm ${view === "table" ? "btn-primary" : "btn-soft"}`} onClick={() => pickView("table")} aria-label={translateText("Table")}>
              <span className="icon-[tabler--table] size-4" />
            </button>
          </div>
        </div>

        {items.isPending && <span className="loading loading-spinner mx-auto my-8 text-primary" />}
        {items.data?.data.length === 0 && (
          <p className="py-10 text-center text-base-content/70">
            {show === "wanted" ? translateText("Nothing on the want list — add the ones you're still looking for.") : translateText("Nothing in it yet — add the first one.")}
          </p>
        )}
        {items.data && items.data.data.length > 0 && view === "grid" && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {items.data.data.map((it) => (
              <li key={it.id} className="card overflow-hidden shadow-none">
                <a href={itemHref(it.id)} className="block">
                  {it.photoId ? (
                    <img src={api.thumbnailUrl(it.photoId)} alt="" className={`aspect-square w-full object-cover ${it.wanted ? "opacity-60 grayscale" : ""}`} />
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
                  <th>{translateText("Name")}</th>
                  {fields.map((f) => (
                    <th key={f.key}>{f.label}</th>
                  ))}
                  <th className="text-end">{translateText("Qty")}</th>
                  <th className="text-end">{translateText("Worth")}</th>
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
                          {translateText("Got it")}</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    <span className={`progress flex w-full ${className}`} role="progressbar" aria-label={translateText("{v0}% complete", { v0: percent })} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
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
        {translateText("Got it")}</button>
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
    <Modal id="collection-dialog" title={collection ? translateText("Edit {v0}", { v0: collection.name }) : translateText("Start a collection")} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-4">
          <div>
            <label className="label-text" htmlFor="collection-name">
              {translateText("Name")}</label>
            <input id="collection-name" name="name" className="input" defaultValue={collection?.name} placeholder={translateText("e.g. Morgan silver dollars")} maxLength={80} required autoFocus />
          </div>
          <div>
            <label className="label-text" htmlFor="collection-template">
              {translateText("What it's of")}</label>
            <select id="collection-template" name="templateId" className="select" defaultValue={collection?.templateId ?? ""}>
              <option value="">{translateText("Anything (no template)")}</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="helper-text">
              {translateText("The template's details (a coin's year, mint mark, grade…) are the collection's columns, and what you add starts from it.")}{!templates.data?.length && translateText(" Add templates under Categories & tags.")}
            </p>
          </div>
          <div>
            <label className="label-text" htmlFor="collection-description">{tr("About it {v0}", { v0: <span className="text-base-content/70">{translateText("(optional)")}</span> })}</label>
            <textarea id="collection-description" name="description" className="textarea" rows={2} maxLength={2000} defaultValue={collection?.description ?? ""} />
          </div>
        </div>
        {collection && (
          <div className="rounded-box bg-base-200 p-3 text-sm">
            {!confirmRemove ? (
              <button type="button" className="btn btn-text btn-error btn-sm" onClick={() => setConfirmRemove(true)}>
                {translateText("Remove this collection")}</button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span>{tr("Remove it? The {v0} you have stay in Ferret", { v0: collection.owned })}{collection.wanted ? translateText("; the {v0} on the want list go to Recently deleted", { v0: collection.wanted }) : ""}.
                </span>
                <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  {translateText("Remove")}</button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmRemove(false)}>
                  {translateText("Keep")}</button>
              </div>
            )}
          </div>
        )}
        {(save.isError || remove.isError) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {collection ? translateText("Save") : translateText("Start it")}
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
  const template = templates.data?.find((t) => t.id === collection.templateId);
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
    <Modal id="add-to-collection" title={translateText("Add to {v0}", { v0: collection.name })} onClose={props.onClose}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <div className="join w-full" role="radiogroup" aria-label={translateText("Have it or want it")}>
          <button type="button" role="radio" aria-checked={!wanted} className={`btn join-item grow ${!wanted ? "btn-primary" : "btn-soft"}`} onClick={() => setWanted(false)}>
            {translateText("I have it")}</button>
          <button type="button" role="radio" aria-checked={wanted} className={`btn join-item grow ${wanted ? "btn-primary" : "btn-soft"}`} onClick={() => setWanted(true)}>
            {translateText("I'm looking for it")}</button>
        </div>
        <div>
          <label className="label-text" htmlFor="collect-name">
            {translateText("What is it?")}</label>
          <input id="collect-name" name="name" className="input" required maxLength={200} autoFocus placeholder={template?.name === "Coin" ? translateText("e.g. 1881-S Morgan dollar") : translateText("Its name")} />
        </div>
        {template && <CustomFieldInputs fields={template.fields} values={custom} onChange={setCustom} />}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="collect-quantity">
              {translateText("How many")}</label>
            <input id="collect-quantity" name="quantity" type="number" min={1} defaultValue={1} className="input" />
          </div>
          <div>
            <label className="label-text" htmlFor="collect-value">
              {wanted ? translateText("Usually goes for") : translateText("Worth (each)")}
            </label>
            <div className="input">
              <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
              <input id="collect-value" name="value" className="grow" inputMode="decimal" />
            </div>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={another} onChange={(e) => setAnother(e.target.checked)} />
          {translateText("Add another after this one")}</label>
        {added && (
          <div className="alert alert-soft alert-success text-sm" role="status">{tr("Added {v0}.", { v0: added })}</div>
        )}
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={props.onClose}>
            {added ? translateText("Done") : translateText("Cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            {wanted ? translateText("Add to the want list") : translateText("Add it")}
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
          {translateText("Collection")}</label>
        <select
          id="item-collection"
          className="select"
          value={props.collectionId ?? ""}
          onChange={(e) => props.onChange({ collectionId: e.target.value || null, wanted: e.target.value ? props.wanted : false })}
        >
          <option value="">{translateText("None")}</option>
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
          {translateText("On the want list (don't have it yet)")}</label>
      )}
    </div>
  );
}

/** On a thing's page: which collection it's in, and — on the want list — "Got it". */
export function CollectionBanner({ householdId, item }: { householdId: string; item: Pick<ItemListing, "id" | "collectionId" | "wanted"> }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const collections = useCollections(householdId);
  const got = useMutation({
    mutationFn: () => api.updateItem(item.id, { wanted: false }),
    onSuccess: () => Promise.all(["item", "items", "collections", "overview"].map((k) => qc.invalidateQueries({ queryKey: [k, householdId] }))),
  });
  if (!item.collectionId) return null;
  const c = collections.data?.find((x) => x.id === item.collectionId);
  if (!item.wanted) {
    return (
      <a href={collectionHref(item.collectionId)} className="tap badge badge-soft badge-primary gap-1 self-start">
        <span className="icon-[tabler--stack-2] size-4" />
        {c?.name ?? translateText("Collection")}
      </a>
    );
  }
  return (
    <div className="alert alert-soft alert-info flex flex-wrap items-center gap-3" role="status">
      <span className="icon-[tabler--heart] size-5 shrink-0" />
      <span className="grow">{tr("On the want list for {v0} — not one of your things yet.", { v0: <a href={collectionHref(item.collectionId, "wanted")} className="link">{c?.name ?? translateText("its collection")}</a> })}</span>
      {canEdit && (
        <button type="button" className="btn btn-primary btn-sm" disabled={got.isPending} onClick={() => got.mutate()}>
          <span className="icon-[tabler--check] size-4" />
          {translateText("Got it")}</button>
      )}
    </div>
  );
}
