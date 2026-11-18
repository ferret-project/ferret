/**
 * "Add from photos": snap (or pick) photos and each becomes an item — "New
 * item" until someone applies what the vision model reads off it on the
 * item's page (model output is never applied by itself). One photo opens its
 * item; several stay in the list to review one by one — or, picked as "all of one thing" (its front, its label, its
 * receipt), they make one item together, which opens; the AI reads them together.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
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

  async function add(files: File[], oneThing = false) {
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
