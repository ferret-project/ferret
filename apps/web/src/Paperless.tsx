/**
 * Paperless-ngx (server: lib/paperless.ts).
 * - `#/paperless` — the inbox: documents tagged for Ferret in the household's Paperless, each added as a new thing,
 *   attached to one (a matching thing is offered), or dismissed; "Sorted" shows what was done before.
 * - `PaperlessCard` — Settings → Household: connect (address, API token, tag, copy or link), owners/admins only.
 * - `AttachFromPaperless` — a thing's page: search Paperless and attach any document.
 */
import type { PaperlessConnection, PaperlessDocument } from "@ferret/shared";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { api, type PaperlessResult } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { navigateTo } from "./lib/navigate";
import { itemHref, settingsHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { TopBar } from "./Nav";

const refreshAll = (qc: ReturnType<typeof useQueryClient>, householdId: string) => {
  for (const k of ["paperless-docs", "attention", "items", "overview"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
};

export function PaperlessInbox({ householdId }: { householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const qc = useQueryClient();
  const [tab, setTab] = useState<"new" | "done">("new");
  const docs = useQuery({ queryKey: ["paperless-docs", householdId, tab], queryFn: () => api.paperlessDocuments(tab) });
  const sync = useMutation({ mutationFn: api.syncPaperless, onSuccess: () => refreshAll(qc, householdId) });
  const [adding, setAdding] = useState<PaperlessDocument | null>(null);
  const [attaching, setAttaching] = useState<PaperlessDocument | null>(null);
  const [done, setDone] = useState<PaperlessResult | null>(null);
  const dismiss = useMutation({ mutationFn: api.dismissPaperless, onSuccess: () => refreshAll(qc, householdId) });
  const restore = useMutation({ mutationFn: api.restorePaperless, onSuccess: () => refreshAll(qc, householdId) });
  const list = docs.data?.data ?? [];
  const finished = (r: PaperlessResult) => {
    setAdding(null);
    setAttaching(null);
    setDone(r);
    refreshAll(qc, householdId);
  };

  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar
        title={<Trans>From Paperless</Trans>}
        back="#/"
        help={<HelpLink page="guide/paperless.html" label={t`From Paperless`} />}
      />
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {docs.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {docs.isError && <div className="alert alert-soft alert-error">{docs.error.message}</div>}
        {docs.data && !docs.data.connected && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--file-text] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Paperless isn't connected</Trans></h2>
              <p className="max-w-md text-sm text-base-content/70">
                <Trans>
                  Connect your Paperless-ngx and tag receipts and manuals there for Ferret: each one comes here, to add as a new thing or put
                  on one you have.
                </Trans>
              </p>
              <a href={settingsHref("household")} className="btn btn-primary btn-sm">
                <Trans>Connect in Settings</Trans>
              </a>
            </div>
          </div>
        )}
        {docs.data?.connected && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="tablist" className="tabs tabs-box tabs-sm">
                <button type="button" role="tab" className={`tab ${tab === "new" ? "tab-active" : ""}`} aria-selected={tab === "new"} onClick={() => setTab("new")}>
                  <Trans>To sort</Trans>
                </button>
                <button type="button" role="tab" className={`tab ${tab === "done" ? "tab-active" : ""}`} aria-selected={tab === "done"} onClick={() => setTab("done")}>
                  <Trans>Sorted</Trans>
                </button>
              </div>
              {canEdit && (
                <button type="button" className="btn btn-soft btn-sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
                  {sync.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--refresh] size-4" />}
                  <Trans>Check now</Trans>
                </button>
              )}
            </div>
            {sync.data && (
              <div className={`alert alert-soft text-sm ${sync.data.connection?.lastError ? "alert-error" : "alert-info"}`}>
                {sync.data.connection?.lastError ??
                  (sync.data.added ? plural(sync.data.added, { one: "# new document", other: "# new documents" }) : t`Nothing new in Paperless.`)}
              </div>
            )}
            {sync.isError && <div className="alert alert-soft alert-error text-sm">{sync.error.message}</div>}
            {done && (
              <div className="alert alert-soft alert-success flex-wrap text-sm" role="status">
                <span className="icon-[tabler--circle-check] size-5" />
                <span className="min-w-0 flex-1">
                  {done.copied ? <Trans>Added to {done.item.name}, with its file.</Trans> : <Trans>Linked to {done.item.name}.</Trans>}
                  {done.note && <span className="block text-base-content/70">{done.note}</span>}
                </span>
                <a href={itemHref(done.item.id)} className="btn btn-soft btn-success btn-sm">
                  <Trans>Open</Trans>
                </a>
              </div>
            )}
            {(dismiss.isError || restore.isError) && <div className="alert alert-soft alert-error text-sm">{(dismiss.error ?? restore.error)?.message}</div>}
            {list.length === 0 && (
              <div className="card">
                <div className="card-body items-center gap-2 text-center">
                  <span className="icon-[tabler--inbox] size-10 text-primary" />
                  <p className="max-w-md text-sm text-base-content/70">
                    {tab === "new" ? (
                      <Trans>Nothing to sort. Tag a document in Paperless and it comes here within ten minutes.</Trans>
                    ) : (
                      <Trans>Nothing sorted yet.</Trans>
                    )}
                  </p>
                </div>
              </div>
            )}
            {list.map((d) => (
              <DocumentCard key={d.id} doc={d}>
                {canEdit && d.status === "new" && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="btn btn-text btn-sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(d.id)}>
                      <Trans>Dismiss</Trans>
                    </button>
                    <button type="button" className={`btn btn-sm ${d.match ? "btn-primary" : "btn-soft"}`} onClick={() => setAttaching(d)}>
                      <span className="icon-[tabler--paperclip] size-4" />
                      {d.match ? <Trans>Put on {d.match.name}…</Trans> : <Trans>Put on a thing…</Trans>}
                    </button>
                    <button type="button" className={`btn btn-sm ${d.match ? "btn-soft" : "btn-primary"}`} onClick={() => setAdding(d)}>
                      <span className="icon-[tabler--plus] size-4" />
                      <Trans>New thing…</Trans>
                    </button>
                  </div>
                )}
                {d.status !== "new" && (
                  <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-base-content/70">
                    {d.status === "dismissed" ? (
                      <>
                        <span><Trans>Dismissed</Trans></span>
                        {canEdit && (
                          <button type="button" className="btn btn-text btn-sm" disabled={restore.isPending} onClick={() => restore.mutate(d.id)}>
                            <Trans>Back to the inbox</Trans>
                          </button>
                        )}
                      </>
                    ) : d.item ? (
                      <a href={itemHref(d.item.id)} className="link link-primary tap">
                        {d.status === "added" ? <Trans>Added as {d.item.name}</Trans> : <Trans>On {d.item.name}</Trans>}
                      </a>
                    ) : (
                      <span><Trans>Its thing was deleted</Trans></span>
                    )}
                  </div>
                )}
              </DocumentCard>
            ))}
          </>
        )}
      </main>
      {adding && <AddDialog householdId={householdId} doc={adding} onClose={() => setAdding(null)} onDone={finished} />}
      {attaching && <AttachDialog householdId={householdId} doc={attaching} onClose={() => setAttaching(null)} onDone={finished} />}
    </div>
  );
}

function DocumentCard({ doc, children }: { doc: PaperlessDocument; children?: React.ReactNode }) {
  const [broken, setBroken] = useState(false);
  return (
    <section className="card">
      <div className="card-body gap-3 p-4">
        <div className="flex gap-3">
          {broken ? (
            <span className="flex h-20 w-16 shrink-0 items-center justify-center rounded-field bg-base-200">
              <span className="icon-[tabler--file-text] size-6 text-base-content/40" />
            </span>
          ) : (
            <img src={api.paperlessThumbnailUrl(doc.id)} alt="" loading="lazy" onError={() => setBroken(true)} className="h-20 w-16 shrink-0 rounded-field border border-base-content/10 bg-base-200 object-cover object-top" />
          )}
          <div className="min-w-0 flex-1 text-sm">
            <h2 className="font-semibold text-base-content">{doc.title}</h2>
            <p className="text-base-content/70">{[doc.correspondent, doc.created ? new Date(`${doc.created}T12:00:00`).toLocaleDateString() : null].filter(Boolean).join(" · ")}</p>
            {doc.excerpt && <p className="mt-1 line-clamp-2 text-base-content/70">{doc.excerpt}</p>}
            <a href={doc.url} target="_blank" rel="noopener noreferrer" className="link link-primary tap mt-1 inline-flex items-center gap-1">
              <Trans>Open in Paperless</Trans>
              <span className="icon-[tabler--external-link] size-3.5" />
            </a>
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}

function AddDialog({ householdId, doc, onClose, onDone }: { householdId: string; doc: PaperlessDocument; onClose: () => void; onDone: (r: PaperlessResult) => void }) {
  const [name, setName] = useState(doc.title);
  const [locationId, setLocationId] = useState<string | null>(null);
  const add = useMutation({ mutationFn: () => api.addFromPaperless(doc.id, { name: name.trim() || undefined, locationId }), onSuccess: onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <Modal id="paperless-add" title={t`New thing from a document`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-base-content/70">
          <Trans>The document goes on the new thing, and Ferret reads it for the details (price, date, model…) to suggest.</Trans>
        </p>
        <div>
          <label className="label-text" htmlFor="paperless-add-name">
            <Trans>Name</Trans>
          </label>
          <input id="paperless-add-name" className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required />
        </div>
        <PlacePicker householdId={householdId} id="paperless-add-place" name="locationId" label={t`Where it's kept`} value={locationId} onChange={setLocationId} noneLabel={t`Not sure yet`} />
        {add.isError && <div className="alert alert-soft alert-error text-sm">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Add</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

function AttachDialog({ householdId, doc, onClose, onDone }: { householdId: string; doc: PaperlessDocument; onClose: () => void; onDone: (r: PaperlessResult) => void }) {
  const [choice, setChoice] = useState<Choice | null>(doc.match ? { id: doc.match.id, label: doc.match.name } : null);
  const attach = useMutation({ mutationFn: (itemId: string) => api.attachFromPaperless(doc.id, itemId), onSuccess: onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (choice) attach.mutate(choice.id);
  };
  return (
    <Modal id="paperless-attach" title={t`Put a document on a thing`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm font-medium">{doc.title}</p>
        <ItemPicker householdId={householdId} id="paperless-attach-item" name="itemId" label={t`Which thing?`} value={choice} onChange={setChoice} />
        {attach.isError && <div className="alert alert-soft alert-error text-sm">{attach.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={!choice || attach.isPending}>
            {attach.isPending && <span className="loading loading-spinner loading-sm" />}
            <Trans>Put it on</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

/** A thing's page: search the household's Paperless and attach a document (it needn't have the tag). */
export function AttachFromPaperless({ householdId, itemId, onClose }: { householdId: string; itemId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const found = useQuery({ queryKey: ["paperless-search", householdId, asked], queryFn: () => api.searchPaperless(asked), enabled: asked.length > 0 });
  const attach = useMutation({
    mutationFn: (id: number) => api.attachFromPaperless(id, itemId),
    onSuccess: () => {
      for (const k of ["item", "attachments", "files", "paperless-docs", "history"]) void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(query.trim());
  };
  return (
    <Modal id="paperless-search" title={t`Attach from Paperless`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex gap-2" role="search">
          <label className="sr-only" htmlFor="paperless-search-q">
            <Trans>Search Paperless</Trans>
          </label>
          <input id="paperless-search-q" type="search" className="input grow" placeholder={t`Search Paperless`} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          <button type="submit" className="btn btn-primary" disabled={!query.trim()}>
            <Trans>Search</Trans>
          </button>
        </form>
        {found.isFetching && <span className="loading loading-spinner mx-auto text-primary" />}
        {found.isError && <div className="alert alert-soft alert-error text-sm">{found.error.message}</div>}
        {attach.isError && <div className="alert alert-soft alert-error text-sm">{attach.error.message}</div>}
        {found.data && found.data.data.length === 0 && (
          <p className="text-sm text-base-content/70">
            <Trans>Nothing in Paperless matches that.</Trans>
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {found.data?.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-box border border-base-content/10 p-3">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{d.title}</p>
                <p className="text-base-content/70">{[d.correspondent, d.created].filter(Boolean).join(" · ")}</p>
              </div>
              {d.item?.id === itemId ? (
                <span className="badge badge-soft badge-success">
                  <Trans>On this thing</Trans>
                </span>
              ) : (
                <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={attach.isPending} onClick={() => attach.mutate(d.id)}>
                  <Trans>Attach</Trans>
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** Settings → Household: connect the household's Paperless-ngx. Owners and admins only. */
export function PaperlessCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["paperless", householdId], queryFn: api.paperless, enabled: canManage });
  const [editing, setEditing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const off = useMutation({
    mutationFn: api.disconnectPaperless,
    onSuccess: () => {
      setConfirmOff(false);
      void qc.invalidateQueries({ queryKey: ["paperless", householdId] });
      refreshAll(qc, householdId);
    },
  });
  if (!canManage || !state.data?.available) return null;
  const c = state.data.connection;
  return (
    <section className="card" aria-labelledby="paperless-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <h2 id="paperless-title" className="card-title flex items-center gap-2 text-base">
              <span className="icon-[tabler--file-text] size-5 text-primary" />
              <Trans>Paperless-ngx</Trans>
              <HelpLink page="guide/paperless.html" label={t`Paperless-ngx`} />
            </h2>
            <p className="text-sm text-base-content/70">
              <Trans>Documents you tag in your Paperless come to Ferret, to add as new things or put on ones you have. Ferret only reads Paperless.</Trans>
            </p>
          </div>
          {!c && !editing && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>
              <Trans>Connect…</Trans>
            </button>
          )}
        </div>
        {c && !editing && <ConnectionSummary connection={c} />}
        {c && !editing && (
          <div className="flex flex-wrap justify-end gap-2">
            {confirmOff ? (
              <>
                <span className="self-center text-sm"><Trans>Disconnect? Files already copied stay on their things.</Trans></span>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmOff(false)}>
                  <Trans>Keep</Trans>
                </button>
                <button type="button" className="btn btn-error btn-soft btn-sm" disabled={off.isPending} onClick={() => off.mutate()}>
                  <Trans>Disconnect</Trans>
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmOff(true)}>
                  <Trans>Disconnect…</Trans>
                </button>
                <button type="button" className="btn btn-soft btn-sm" onClick={() => setEditing(true)}>
                  <Trans>Change…</Trans>
                </button>
                <button type="button" className="btn btn-soft btn-primary btn-sm" onClick={() => navigateTo("#/paperless")}>
                  <Trans>Open the inbox</Trans>
                </button>
              </>
            )}
          </div>
        )}
        {off.isError && <div className="alert alert-soft alert-error text-sm">{off.error.message}</div>}
        {editing && (
          <ConnectForm
            householdId={householdId}
            connection={c}
            local={state.data.local}
            onDone={() => {
              setEditing(false);
              void qc.invalidateQueries({ queryKey: ["paperless", householdId] });
              refreshAll(qc, householdId);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
    </section>
  );
}

function ConnectionSummary({ connection: c }: { connection: PaperlessConnection }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-base-content/70"><Trans>Address</Trans></dt>
        <dd className="min-w-0 break-words" title={c.url}>{c.host}</dd>
        <dt className="text-base-content/70"><Trans>Signed in as</Trans></dt>
        <dd>{c.user ?? "—"}</dd>
        <dt className="text-base-content/70"><Trans>Watches the tag</Trans></dt>
        <dd>{c.tag}</dd>
        <dt className="text-base-content/70"><Trans>Files</Trans></dt>
        <dd>{c.copyFiles ? <Trans>Copied into Ferret, with a link back</Trans> : <Trans>Linked only</Trans>}</dd>
        <dt className="text-base-content/70"><Trans>Last checked</Trans></dt>
        <dd>{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : <Trans>Not yet</Trans>}</dd>
      </dl>
      {c.lastError && <div className="alert alert-soft alert-error text-sm">{c.lastError}</div>}
    </div>
  );
}

function ConnectForm(props: { householdId: string; connection: PaperlessConnection | null; local: boolean; onDone: () => void; onCancel: () => void }) {
  const c = props.connection;
  const [url, setUrl] = useState(c?.url ?? "");
  const [token, setToken] = useState("");
  const [tag, setTag] = useState(c?.tag ?? "ferret");
  const [copyFiles, setCopyFiles] = useState(c?.copyFiles ?? true);
  const save = useMutation({ mutationFn: () => api.connectPaperless({ url: url.trim(), token: token.trim() || undefined, tag: tag.trim() || "ferret", copyFiles }), onSuccess: props.onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label className="label-text" htmlFor="paperless-url">
          <Trans>Paperless's address</Trans>
        </label>
        <input id="paperless-url" type="url" inputMode="url" className="input" placeholder="https://paperless.example.com" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <span className="helper-text">
          {props.local ? (
            <Trans>The address Ferret's server reaches it at — on your network is fine.</Trans>
          ) : (
            <Trans>An address on the internet: only whoever runs this Ferret can connect it to one on its own network.</Trans>
          )}
        </span>
      </div>
      <div>
        <label className="label-text" htmlFor="paperless-token">
          <Trans>API token</Trans>
        </label>
        <input
          id="paperless-token"
          type="password"
          autoComplete="off"
          className="input font-mono"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required={!c}
          placeholder={c ? t`Leave empty to keep the one saved` : ""}
        />
        <span className="helper-text">
          <Trans>In Paperless: your name → My profile → API auth token. A Paperless user who can only view documents is enough.</Trans>
        </span>
      </div>
      <div>
        <label className="label-text" htmlFor="paperless-tag">
          <Trans>Tag to watch</Trans>
        </label>
        <input id="paperless-tag" className="input" value={tag} maxLength={128} onChange={(e) => setTag(e.target.value)} required />
        <span className="helper-text">
          <Trans>Documents with this tag in Paperless come to Ferret's inbox. Make the tag in Paperless first.</Trans>
        </span>
      </div>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="checkbox checkbox-primary mt-0.5" checked={copyFiles} onChange={(e) => setCopyFiles(e.target.checked)} />
        <span className="text-sm">
          <Trans>Copy files into Ferret</Trans>
          <span className="block text-base-content/70">
            <Trans>Ferret reads them for details and keeps them in its backups. Off: things only get a link to the document in Paperless.</Trans>
          </span>
        </span>
      </label>
      {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-text" onClick={props.onCancel}>
          <Trans>Cancel</Trans>
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending && <span className="loading loading-spinner loading-sm" />}
          {c ? <Trans>Save</Trans> : <Trans>Connect</Trans>}
        </button>
      </div>
    </form>
  );
}

/** "Attach from Paperless" on a thing's page — only when the household has connected its Paperless. */
export function PaperlessAttachButton({ householdId, itemId, onAttached }: { householdId: string; itemId: string; onAttached: () => void }) {
  const state = useQuery({ queryKey: ["paperless", householdId], queryFn: api.paperless, staleTime: 5 * 60_000 });
  const [open, setOpen] = useState(false);
  if (!state.data?.connection) return null;
  return (
    <>
      <button type="button" className="btn btn-text btn-sm self-start" onClick={() => setOpen(true)}>
        <span className="icon-[tabler--file-text] size-4" />
        <Trans>Attach from Paperless</Trans>
      </button>
      {open && (
        <AttachFromPaperless
          householdId={householdId}
          itemId={itemId}
          onClose={() => {
            setOpen(false);
            onAttached();
          }}
        />
      )}
    </>
  );
}
