/**
 * "Add from photos": snap (or pick) photos. With the vision model they go to the inbox (Inbox.tsx, server lib/inbox.ts)
 * to be read before anything is added — one entry per photo, or one for "all of one thing" (its front, its label, its
 * receipt) — and the inbox opens. Without it there's nothing to read, so each becomes a "New item" at once, as before:
 * one photo opens its item; several stay in the list — or, as "all of one thing", make one item, which opens.
 *
 * "From a receipt" (AddFromReceipt): a photo or PDF of one receipt, invoice or order, to the inbox the same way; its
 * things are added from there. Offered when the server can read receipts.
 */
import { useRef, useState } from "react";
import { api } from "./lib/api";
import { INBOX_HREF, itemHref } from "./lib/route";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { navigateTo } from "./lib/navigate";
import { Modal } from "./Modal";
import { Trans } from "@lingui/react/macro";
import { t, ph } from "@lingui/core/macro";

export function AddFromPhotos(props: {
  householdId: string;
  /** Where the new items go: a room or a box. */
  locationId?: string | null;
  containerItemId?: string;
  categoryId?: string | null;
  tags?: string[];
  className?: string;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Several picked: one thing or several? */
  const [choosing, setChoosing] = useState<File[] | null>(null);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const reads = Boolean(me.data?.features.photoAi);

  /** To the inbox, to be read first: one entry per photo, or one for all of them. */
  async function toInbox(files: File[], oneThing: boolean) {
    setError(null);
    setProgress({ done: 0, total: files.length });
    const groups = oneThing ? [files] : files.map((f) => [f]);
    let sent = 0;
    for (const group of groups) {
      try {
        const entry = await api.startInbox({
          kind: "photos",
          locationId: props.containerItemId ? null : (props.locationId ?? null),
          containerItemId: props.containerItemId ?? null,
          categoryId: props.categoryId ?? null,
          tags: props.tags ?? [],
        });
        let uploaded = 0;
        for (const file of group) {
          try {
            await api.uploadInboxFile(entry.id, file, "photo");
            uploaded++;
          } catch (err) {
            setError(`${file.name}: ${(err as Error).message}`);
          }
          setProgress((p) => p && { ...p, done: p.done + 1 });
        }
        if (!uploaded) await api.discardInbox(entry.id).catch(() => {}); // no photo, no entry
        else sent++;
      } catch (err) {
        setError((err as Error).message);
      }
    }
    setProgress(null);
    await qc.invalidateQueries({ queryKey: ["inbox", props.householdId] });
    await qc.invalidateQueries({ queryKey: ["inbox-count", props.householdId] });
    if (sent) navigateTo(INBOX_HREF);
  }

  async function add(files: File[], oneThing = false) {
    if (reads) return toInbox(files, oneThing);
    setError(null);
    setProgress({ done: 0, total: files.length });
    const made: string[] = [];
    if (oneThing) {
      try {
        const created = await api.createItem({
          name: "New item",
          locationId: props.containerItemId ? undefined : (props.locationId ?? null),
          containerItemId: props.containerItemId,
          categoryId: props.categoryId ?? null,
          tags: props.tags ?? [],
          origin: "photos",
        });
        let uploaded = 0;
        for (const file of files) {
          try {
            await api.uploadAttachment(created.id, file, "photo", () => {});
            uploaded++;
          } catch (err) {
            setError(`${file.name}: ${(err as Error).message}`);
          }
          setProgress((p) => p && { ...p, done: p.done + 1 });
        }
        if (!uploaded) await api.deleteItem(created.id).catch(() => {}); // no photo, no item
        else made.push(created.id);
      } catch (err) {
        setError((err as Error).message);
      }
      setProgress(null);
      await refresh();
      if (made.length) navigateTo(itemHref(made[0]!));
      return;
    }
    for (const file of files) {
      try {
        const created = await api.createItem({
          name: "New item",
          locationId: props.containerItemId ? undefined : (props.locationId ?? null),
          containerItemId: props.containerItemId,
          categoryId: props.categoryId ?? null,
          tags: props.tags ?? [],
          origin: "photos",
        });
        try {
          await api.uploadAttachment(created.id, file, "photo", () => {});
        } catch (err) {
          await api.deleteItem(created.id).catch(() => {}); // no photo, no item
          throw err;
        }
        made.push(created.id);
      } catch (err) {
        setError(`${file.name}: ${(err as Error).message}`);
      }
      setProgress((p) => p && { ...p, done: p.done + 1 });
    }
    setProgress(null);
    await refresh();
    if (made.length === 1 && files.length === 1) navigateTo(itemHref(made[0]!));
  }

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["items", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["places", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["overview", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["attention", props.householdId] }),
    ]);

  return (
    <>
      <button
        type="button"
        className={`btn btn-wrap btn-soft btn-primary ${props.className ?? ""}`}
        disabled={progress !== null}
        onClick={() => input.current?.click()}
      >
        {progress ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--camera-plus] size-5" />}
        {progress ? t`Adding ${ph({ number: progress.done + 1 })} of ${ph({ total: progress.total })}…` : t`Add from photos`}
      </button>
      {/* No `capture`: iPhone then offers the camera or the library, and several photos at once. */}
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length > 1) setChoosing(files);
          else if (files.length) void add(files);
        }}
      />
      {error && <p className="w-full text-sm text-error">{error}</p>}
      {choosing && (
        <Modal id="photos-one-or-many" title={t`${ph({ count: choosing.length })} photos`} onClose={() => setChoosing(null)}>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              className="btn btn-soft btn-primary btn-wrap h-auto justify-start gap-3 py-3 text-start"
              onClick={() => {
                const files = choosing;
                setChoosing(null);
                void add(files);
              }}
            >
              <span className="icon-[tabler--layout-grid] size-6 shrink-0" />
              <span>
                <span className="block font-semibold">
                  <Trans>Each is a different thing</Trans>
                </span>
                <span className="block text-sm font-normal">{t`${ph({ count: choosing.length })} new things, one photo each`}</span>
              </span>
            </button>
            <button
              type="button"
              className="btn btn-soft btn-primary btn-wrap h-auto justify-start gap-3 py-3 text-start"
              onClick={() => {
                const files = choosing;
                setChoosing(null);
                void add(files, true);
              }}
            >
              <span className="icon-[tabler--photo-plus] size-6 shrink-0" />
              <span>
                <span className="block font-semibold">
                  <Trans>All of one thing</Trans>
                </span>
                <span className="block text-sm font-normal">
                  <Trans>Its front, its label, its receipt — one new thing, read together</Trans>
                </span>
              </span>
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** "From a receipt": one receipt, invoice or order (a photo or a PDF) to the inbox, where its things are added. */
export function AddFromReceipt(props: { householdId: string; locationId?: string | null; containerItemId?: string | null; categoryId?: string | null; tags?: string[]; className?: string }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(file: File) {
    setError(null);
    setBusy(true);
    try {
      const entry = await api.startInbox({
        kind: "receipt",
        locationId: props.containerItemId ? null : (props.locationId ?? null),
        containerItemId: props.containerItemId ?? null,
        categoryId: props.categoryId ?? null,
        tags: props.tags ?? [],
      });
      try {
        await api.uploadInboxFile(entry.id, file, "document");
      } catch (err) {
        await api.discardInbox(entry.id).catch(() => {}); // no receipt, no entry
        throw err;
      }
      await qc.invalidateQueries({ queryKey: ["inbox", props.householdId] });
      await qc.invalidateQueries({ queryKey: ["inbox-count", props.householdId] });
      navigateTo(INBOX_HREF);
    } catch (err) {
      setError(`${file.name}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={props.className ?? "btn btn-soft"}
        title={t`A photo or PDF of a receipt, invoice or order: Ferret reads it, then you add the things on it`}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? <span className="loading loading-spinner size-6" /> : <span className="icon-[tabler--receipt] size-6" />}
        <span>{busy ? t`Adding…` : t`From a receipt`}</span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/*,application/pdf"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void add(file);
        }}
      />
      {error && <p className="col-span-3 text-sm text-error">{error}</p>}
    </>
  );
}
