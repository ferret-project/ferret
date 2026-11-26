/**
 * `#/inbox` — read before adding (server: lib/inbox.ts). Photos from "+ Add → Add from photos", a receipt from "From a
 * receipt", and files shared to Ferret come here first and are read in the background. Each card, once read, is added
 * as a new thing (what the AI read filled in, to correct), put on a thing already in Ferret (one with the same barcode,
 * model or name is offered), its receipt's things added (ReceiptLines.tsx, "Already in Ferret" ones unticked), or
 * discarded. Nothing is added until then.
 *
 * Not every way of adding comes here: without the vision model "Add from photos" makes New items at once (nothing to
 * read), and "Walk through a room" stays quick capture, named afterwards (PhotoAdd.tsx, Walkthrough.tsx).
 */
import type { InboxEntry, Item } from "@ferret/shared";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { FileThumb } from "./FileThumb";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { TopBar } from "./Nav";
import { ReceiptLinesDialog } from "./ReceiptLines";

export const inboxKey = (householdId: string) => ["inbox", householdId];

const refreshAll = (qc: ReturnType<typeof useQueryClient>, householdId: string) => {
  for (const k of ["inbox", "inbox-count", "items", "places", "overview", "attention", "to-confirm"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
};

export function Inbox({ householdId }: { householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const qc = useQueryClient();
  const entries = useQuery({
    queryKey: inboxKey(householdId),
    queryFn: api.inbox,
    // Poll while something is still being read.
    refetchInterval: (q) => (q.state.data?.data.some((e) => e.status !== "ready") ? 3000 : false),
  });
  const [done, setDone] = useState<{ id: string; name: string; added: boolean }[] | null>(null);
  const finished = (made: { id: string; name: string }[], added: boolean) => {
    setDone(made.map((m) => ({ ...m, added })));
    refreshAll(qc, householdId);
  };
  const list = entries.data?.data ?? [];

  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar title={<Trans>Inbox</Trans>} back="#/" help={<HelpLink page="guide/adding-things.html#the-inbox" label={t`Inbox`} />} />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {entries.isPending && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {entries.isError && <div className="alert alert-soft alert-error">{entries.error.message}</div>}
        {done && done.length > 0 && (
          <div className="alert alert-soft alert-success flex-wrap text-sm" role="status">
            <span className="icon-[tabler--circle-check] size-5" />
            <span className="min-w-0 flex-1">
              {done.length === 1
                ? done[0]!.added
                  ? t`Added ${done[0]!.name}.`
                  : t`Put on ${done[0]!.name}.`
                : plural(done.length, { one: "Added # thing.", other: "Added # things." })}
            </span>
            {done.length === 1 && (
              <a href={itemHref(done[0]!.id)} className="btn btn-soft btn-success btn-sm">
                <Trans>Open</Trans>
              </a>
            )}
          </div>
        )}
        {entries.isSuccess && list.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-2 text-center">
              <span className="icon-[tabler--inbox] size-10 text-primary" />
              <p className="max-w-md text-sm text-base-content/70">
                <Trans>Nothing waiting. Photos and receipts you add with + Add come here to be read before they become things.</Trans>
              </p>
            </div>
          </div>
        )}
        {list.map((e) => (
          <EntryCard key={e.id} entry={e} householdId={householdId} canEdit={canEdit} onDone={finished} />
        ))}
      </main>
    </div>
  );
}

function EntryCard({ entry, householdId, canEdit, onDone }: { entry: InboxEntry; householdId: string; canEdit: boolean; onDone: (made: { id: string; name: string }[], added: boolean) => void }) {
  const p = entry.proposal;
  const reading = entry.status !== "ready";
  const couldntRead = !reading && entry.files.length > 0 && entry.files.every((f) => f.analysisStatus !== "done");
  const [name, setName] = useState<string | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null | undefined>(undefined);
  const [onto, setOnto] = useState(false);
  const [lines, setLines] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const shown = { name: name ?? p.name ?? "", brand: brand ?? p.brand ?? "", model: model ?? p.model ?? "" };
  const inBox = Boolean(entry.into.containerItemId) && place === undefined;

  const add = useMutation({
    mutationFn: () =>
      api.inboxAdd(entry.id, {
        name: shown.name.trim() || t`New item`,
        brand: shown.brand.trim() || null,
        model: shown.model.trim() || null,
        serialNumber: p.serialNumber,
        barcode: p.barcode,
        purchaseDate: p.purchaseDate,
        purchasePriceCents: p.purchasePriceCents,
        categoryId: p.categoryId,
        description: p.description,
        ...(place !== undefined && { locationId: place, containerItemId: null }),
      }),
    onSuccess: (item: Item) => onDone([{ id: item.id, name: item.name }], true),
  });
  const putOn = useMutation({ mutationFn: (itemId: string) => api.inboxOnto(entry.id, itemId), onSuccess: (r) => onDone([r], false) });
  const discard = useMutation({ mutationFn: () => api.discardInbox(entry.id), onSuccess: () => onDone([], false) });
  const error = add.error ?? putOn.error ?? discard.error;
  const receiptFile = entry.receipt ? entry.files.find((f) => f.id === entry.receipt!.attachmentId) : undefined;

  return (
    <section className="card" aria-busy={reading}>
      <div className="card-body gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {entry.files.map((f) => (
            <FileThumb key={f.id} attachmentId={f.id} filename={f.filename} className="size-16" />
          ))}
          <div className="min-w-0 flex-1 text-sm text-base-content/70">
            {reading ? (
              <span className="inline-flex items-center gap-2">
                <span className="loading loading-spinner loading-xs" />
                {entry.status === "empty" ? <Trans>Uploading…</Trans> : <Trans>Reading…</Trans>}
              </span>
            ) : couldntRead ? (
              <Trans>Ferret couldn't read this. Name it yourself, or put it on a thing.</Trans>
            ) : (
              p.description
            )}
            {entry.into.placeName && <span className="block">{t`Goes in ${entry.into.placeName}`}</span>}
            {entry.link && <span className="block truncate">{entry.link}</span>}
          </div>
        </div>

        {!reading && entry.receipt && (
          <p className="text-sm">
            {plural(entry.receipt.lines.length, { one: "A receipt with # thing on it.", other: "A receipt with # things on it." })}
          </p>
        )}

        {!reading && !entry.receipt && canEdit && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="label-text">
                <Trans>Name</Trans>
              </span>
              <input className="input" value={shown.name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t`New item`} />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="label-text">
                  <Trans>Brand</Trans>
                </span>
                <input className="input" value={shown.brand} maxLength={120} onChange={(e) => setBrand(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label-text">
                  <Trans>Model</Trans>
                </span>
                <input className="input" value={shown.model} maxLength={120} onChange={(e) => setModel(e.target.value)} />
              </label>
            </div>
            {inBox ? (
              <p className="text-sm text-base-content/70">
                {t`In ${entry.into.placeName ?? t`the box`}`}{" "}
                <button type="button" className="btn btn-text btn-xs tap" onClick={() => setPlace(null)}>
                  <Trans>Somewhere else…</Trans>
                </button>
              </p>
            ) : (
              <PlacePicker
                householdId={householdId}
                id={`inbox-place-${entry.id}`}
                name="place"
                label={t`Where is it?`}
                value={place === undefined ? entry.into.locationId : place}
                onChange={setPlace}
                noneLabel={t`Not in a place yet`}
              />
            )}
            {entry.matches.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-base-content/70">
                  <Trans>Already in Ferret?</Trans>
                </span>
                {entry.matches.map((m) => (
                  <button key={m.id} type="button" className="btn btn-soft btn-sm" disabled={putOn.isPending} onClick={() => putOn.mutate(m.id)}>
                    <span className="icon-[tabler--paperclip] size-4" />
                    {m.place ? t`Put on ${m.name} (${m.place})` : t`Put on ${m.name}`}
                  </button>
                ))}
              </div>
            )}
            <button type="submit" className="hidden" />
          </form>
        )}

        {error && <div className="alert alert-soft alert-error text-sm">{error.message}</div>}

        {canEdit && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className={`btn btn-sm me-auto ${confirmDiscard ? "btn-error" : "btn-text"}`}
              disabled={discard.isPending}
              onClick={() => (confirmDiscard ? discard.mutate() : setConfirmDiscard(true))}
            >
              {confirmDiscard ? <Trans>Discard it and its files</Trans> : <Trans>Discard</Trans>}
            </button>
            <button type="button" className="btn btn-soft btn-sm" disabled={reading} onClick={() => setOnto(true)}>
              <span className="icon-[tabler--paperclip] size-4" />
              <Trans>Put on a thing…</Trans>
            </button>
            {entry.receipt && receiptFile ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setLines(true)}>
                <span className="icon-[tabler--receipt] size-4" />
                {plural(entry.receipt.lines.length, { one: "Add the thing on it…", other: "Add the # things on it…" })}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={reading || add.isPending} onClick={() => add.mutate()}>
                {add.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--plus] size-4" />}
                <Trans>Add it</Trans>
              </button>
            )}
          </div>
        )}
      </div>
      {onto && <OntoDialog householdId={householdId} onClose={() => setOnto(false)} onPick={(id) => (setOnto(false), putOn.mutate(id))} />}
      {lines && receiptFile && (
        <ReceiptLinesDialog
          item={{ id: "", name: "New item", locationId: entry.into.locationId } as unknown as Item}
          receipt={receiptFile}
          householdId={householdId}
          onClose={() => setLines(false)}
          addLines={async (input) => {
            const made = await api.inboxLines(entry.id, input);
            onDone(made.items, true);
          }}
        />
      )}
    </section>
  );
}

function OntoDialog({ householdId, onClose, onPick }: { householdId: string; onClose: () => void; onPick: (itemId: string) => void }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  return (
    <Modal id="inbox-onto" title={t`Put on a thing`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice) onPick(choice.id);
        }}
      >
        <ItemPicker householdId={householdId} id="inbox-onto-item" name="itemId" label={t`Which thing?`} value={choice} onChange={setChoice} />
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={!choice}>
            <Trans>Put it there</Trans>
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}
