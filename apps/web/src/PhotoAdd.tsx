/**
 * "Add from photos": snap (or pick) photos and each becomes an item — "New
 * item" until someone applies what the vision model reads off it on the
 * item's page (model output is never applied by itself). One photo opens its
 * item; several stay in the list to review one by one.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { navigateTo } from "./lib/navigate";

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

  async function add(files: File[]) {
    setError(null);
    setProgress({ done: 0, total: files.length });
    const made: string[] = [];
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
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["items", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["places", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["overview", props.householdId] }),
    ]);
    if (made.length === 1 && files.length === 1) navigateTo(itemHref(made[0]!));
  }

  return (
    <>
      <button
        type="button"
        className={`btn btn-wrap btn-soft btn-primary ${props.className ?? ""}`}
        disabled={progress !== null}
        onClick={() => input.current?.click()}
      >
        {progress ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--camera-plus] size-5" />}
        {progress ? `Adding ${progress.done + 1} of ${progress.total}…` : "Add from photos"}
      </button>
      {/* No `capture`: iPhone then offers the camera or the library, and several photos at once. */}
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void add(files);
        }}
      />
      {error && <p className="w-full text-sm text-error">{error}</p>}
    </>
  );
}
