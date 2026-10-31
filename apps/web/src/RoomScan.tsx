/**
 * Room scans (server: lib/room-scans.ts): photograph a room — or the inside of a box — once (up to five photos for a
 * big room), and the vision model lists what's in it. Review the list: everything starts ticked; untick what you
 * don't want, fix names, counts and categories, and tap an empty spot on a photo to add something it missed. "Add N
 * things" makes them in that room or box, each with its own photo cut from the room's (where the model said where it
 * was). Nothing the model says is saved until then.
 *
 *   #/room-scan/new?in=<room> | ?box=<box>   take the photos
 *   #/room-scan/<id>                         waiting, then the review (the bell says when it's ready)
 */
import type { RoomScan, RoomScanCandidate } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { flattenCategories, useCategories } from "./Catalog";
import { PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { navigateTo } from "./lib/navigate";
import { findLocation, usePlaces } from "./lib/places";
import { usePlan } from "./PlanUsage";
import { itemHref, placeHref, roomScanHref, scanRoomHref } from "./lib/route";

const MAX_PHOTOS = 5;

export function RoomScanScreen({ householdId, id, locationId, boxId }: { householdId: string; id: string; locationId: string | null; boxId: string | null }) {
  const canEdit = useCanEdit(householdId);
  const scan = useQuery({
    queryKey: ["roomscan", householdId, id],
    queryFn: () => api.roomScan(id),
    enabled: id !== "new",
    // Being looked at: ask again every few seconds until it's ready.
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 3000 : false),
  });
  const back = scan.data?.containerItemId
    ? itemHref(scan.data.containerItemId)
    : (scan.data?.locationId ?? locationId)
      ? placeHref((scan.data?.locationId ?? locationId)!)
      : boxId
        ? itemHref(boxId)
        : "#/";
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 px-4 backdrop-blur-md">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href={back} className="btn btn-text btn-sm btn-square" aria-label="Back">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{scan.data?.placeName ? `Scan of ${scan.data.placeName.split(" › ").at(-1)}` : "Scan a room"}</h1>
          <HelpLink page="guide/room-scan.html" label="Room scans" />
        </div>
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!canEdit && <div className="alert alert-soft alert-info">You can look around, but not add things, in this household.</div>}
        {canEdit && id === "new" && <Start householdId={householdId} locationId={locationId} boxId={boxId} />}
        {scan.isPending && id !== "new" && <span className="loading loading-spinner mx-auto my-12 text-primary" />}
        {scan.isError && <div className="alert alert-soft alert-error">{scan.error.message}</div>}
        {scan.data && canEdit && <ScanView householdId={householdId} scan={scan.data} back={back} />}
      </main>
    </div>
  );
}

/** Pick the room (unless it came with one), take or choose 1–5 photos, and send them. */
function Start({ householdId, locationId, boxId }: { householdId: string; locationId: string | null; boxId: string | null }) {
  const [room, setRoom] = useState<string | null>(locationId);
  const [photos, setPhotos] = useState<File[]>([]);
  const places = usePlaces(householdId);
  const plan = usePlan(householdId);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const start = useMutation({
    mutationFn: () => api.startRoomScan(photos, boxId ? { containerItemId: boxId } : { locationId: room! }),
    onSuccess: (s) => navigateTo(roomScanHref(s.id)),
  });
  const urls = usePreviews(photos);
  const add = (files: FileList | null) => {
    const picked = Array.from(files ?? []); // now: the input is cleared straight after
    setPhotos((p) => [...p, ...picked].slice(0, MAX_PHOTOS));
  };
  const roomName = room ? findLocation(places.data, room)?.node.name : null;

  if (me.data && !me.data.features.roomScan) {
    return <div className="alert alert-soft alert-info">Room scans need the vision model, which isn't set up on this server.</div>;
  }
  if (plan.data?.plan && !plan.data.plan.limits.ai) {
    return <div className="alert alert-soft alert-info">Room scans use AI, which isn't part of the {plan.data.plan.name} plan.</div>;
  }
  return (
    <section className="card">
      <div className="card-body gap-4">
        <p className="text-base-content/80">
          Photograph {boxId ? "what's in the box" : roomName ? <>{roomName}</> : "a room"} — one wide photo, or up to {MAX_PHOTOS} for a big room. Ferret
          lists what it sees for you to check; nothing is added until you say.
        </p>
        {!boxId && (
          <PlacePicker householdId={householdId} id="scan-room" name="room" label="Which room?" value={room} onChange={setRoom} noneLabel="Choose a room" />
        )}
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {urls.map((url, i) => (
              <li key={url} className="relative">
                <img src={url} alt={`Photo ${i + 1}`} className="aspect-square w-full rounded-field object-cover" />
                <button
                  type="button"
                  className="btn btn-circle btn-xs absolute end-1 top-1"
                  aria-label={`Remove photo ${i + 1}`}
                  onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                >
                  <span className="icon-[tabler--x] size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {photos.length < MAX_PHOTOS && (
            <>
              <button type="button" className="btn btn-soft btn-primary" onClick={() => camera.current?.click()}>
                <span className="icon-[tabler--camera] size-5" />
                {photos.length ? "Take another" : "Take a photo"}
              </button>
              <button type="button" className="btn btn-soft" onClick={() => library.current?.click()}>
                <span className="icon-[tabler--photo] size-5" />
                Choose photos
              </button>
            </>
          )}
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (add(e.target.files), (e.target.value = ""))} />
          <input ref={library} type="file" accept="image/*" multiple hidden onChange={(e) => (add(e.target.files), (e.target.value = ""))} />
        </div>
        {start.isError && <div className="alert alert-soft alert-error">{start.error.message}</div>}
        <button
          type="button"
          className="btn btn-primary self-start"
          disabled={!photos.length || (!room && !boxId) || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--sparkles] size-5" />}
          Find things
        </button>
      </div>
    </section>
  );
}

/** Object URLs for picked photos, released when they're gone. */
function usePreviews(files: File[]) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = files.map((f) => URL.createObjectURL(f));
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  return urls;
}

function ScanView({ householdId, scan, back }: { householdId: string; scan: RoomScan; back: string }) {
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.dismissRoomScan(scan.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["attention"] });
      navigateTo(back);
    },
  });
  if (scan.status === "pending") {
    return (
      <div className="card">
        <div className="card-body items-center gap-3 py-12 text-center" role="status">
          <span className="loading loading-dots loading-lg text-primary" />
          <p className="font-medium">Looking at {scan.photos === 1 ? "the photo" : `the ${scan.photos} photos`}…</p>
          <p className="max-w-sm text-sm text-base-content/70">This can take a few minutes. You can leave — the bell says when it's ready to review.</p>
        </div>
      </div>
    );
  }
  if (scan.status === "failed") {
    return (
      <div className="alert alert-soft alert-error flex flex-wrap items-center gap-3" role="alert">
        <span className="grow">{scan.error ?? "Couldn't look at the photos."}</span>
        <a href={scanRoomHref({ locationId: scan.locationId, containerItemId: scan.containerItemId })} className="btn btn-sm btn-soft">
          Try again
        </a>
        <button type="button" className="btn btn-sm btn-text" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
          Dismiss
        </button>
      </div>
    );
  }
  if (scan.status === "done") {
    return (
      <section className="card">
        <div className="card-body gap-3">
          <h2 className="font-semibold">
            Added {scan.items.length} {scan.items.length === 1 ? "thing" : "things"} from this scan
          </h2>
          <ul className="flex flex-wrap gap-2">
            {scan.items.map((i) => (
              <li key={i.id}>
                <a href={itemHref(i.id)} className="badge badge-soft badge-primary tap">
                  {i.name}
                </a>
              </li>
            ))}
          </ul>
          <Photos scan={scan} rows={[]} />
        </div>
      </section>
    );
  }
  return <Review householdId={householdId} scan={scan} back={back} onDismiss={() => dismiss.mutate()} />;
}

interface Row extends RoomScanCandidate {
  key: number;
  checked: boolean;
}

/** The photos, with a numbered outline round each thing found; tap an empty spot to add something there. */
function Photos({ scan, rows, active, onPick, onAdd }: { scan: RoomScan; rows: Row[]; active?: number | null; onPick?: (key: number) => void; onAdd?: (photo: number, x: number, y: number) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: scan.photos }, (_, n) => (
        <div key={n} className="relative overflow-hidden rounded-box bg-base-300">
          <img
            src={api.roomScanPhotoUrl(scan.id, n)}
            alt={`Photo ${n + 1} of the room`}
            className={`block w-full ${onAdd ? "cursor-crosshair" : ""}`}
            onClick={(e) => {
              if (!onAdd) return;
              const r = e.currentTarget.getBoundingClientRect();
              onAdd(n, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
            }}
          />
          {rows.map((row, i) =>
            row.photo === n && row.box ? (
              <button
                key={row.key}
                type="button"
                aria-label={`${i + 1}: ${row.name || "new thing"}`}
                className={`absolute rounded-sm border-2 ${row.checked ? (active === row.key ? "border-warning" : "border-primary") : "border-dashed border-white/70"}`}
                style={{ left: `${row.box[0] * 100}%`, top: `${row.box[1] * 100}%`, width: `${row.box[2] * 100}%`, height: `${row.box[3] * 100}%` }}
                onClick={() => onPick?.(row.key)}
              >
                <span className={`absolute -top-0.5 -left-0.5 rounded-br-sm px-1 text-xs font-semibold ${row.checked ? "bg-primary text-primary-content" : "bg-black/60 text-white"}`}>{i + 1}</span>
              </button>
            ) : null,
          )}
        </div>
      ))}
    </div>
  );
}

function Review({ householdId, scan, back, onDismiss }: { householdId: string; scan: RoomScan; back: string; onDismiss: () => void }) {
  const qc = useQueryClient();
  const categories = flattenCategories(useCategories(householdId).data ?? []);
  const [rows, setRows] = useState<Row[]>(() => scan.candidates.map((c, key) => ({ ...c, key, checked: true })));
  const [active, setActive] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const nextKey = useRef(scan.candidates.length);
  const ticked = rows.filter((r) => r.checked && r.name.trim());
  const set = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = useMutation({
    mutationFn: async () => {
      setProgress("Adding them…");
      const { items } = await api.addFromRoomScan(scan.id, {
        items: ticked.map((r) => ({ name: r.name.trim(), quantity: Math.max(1, r.quantity || 1), categoryId: r.categoryId })),
      });
      // Each one's own photo, cut from the room's — a nice-to-have: one that fails leaves that thing without.
      const withBox = ticked.map((r, i) => ({ row: r, id: items[i]!.id })).filter((x) => x.row.box);
      const bitmaps = new Map<number, ImageBitmap | null>();
      for (const [done, { row, id }] of withBox.entries()) {
        setProgress(`Adding photos (${done + 1} of ${withBox.length})…`);
        try {
          if (!bitmaps.has(row.photo)) bitmaps.set(row.photo, await loadPhoto(scan.id, row.photo));
          const crop = await cut(bitmaps.get(row.photo) ?? null, row.box!);
          if (crop) await api.uploadCrop(id, crop);
        } catch {
          // carry on with the rest
        }
      }
      return items;
    },
    onSuccess: () => {
      for (const key of ["items", "places", "overview", "attention", "roomscan"]) void qc.invalidateQueries({ queryKey: [key] });
      navigateTo(back);
    },
    onSettled: () => setProgress(null),
  });

  function addAt(photo: number, x: number, y: number) {
    const size = 0.16;
    const key = nextKey.current++;
    const box: Row["box"] = [clamp(x - size / 2, 0, 1 - size), clamp(y - size / 2, 0, 1 - size), size, size];
    setRows((all) => [...all, { key, name: "", categoryId: null, quantity: 1, photo, box, checked: true }]);
    setActive(key);
    requestAnimationFrame(() => document.getElementById(`scan-name-${key}`)?.focus());
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (ticked.length) save.mutate();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <p className="text-sm text-base-content/70">
        {rows.length
          ? "Untick what you don't want and fix anything that's off. Missed something? Tap it on the photo."
          : "Ferret didn't spot anything it was sure of. Tap things on the photo to add them."}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Photos scan={scan} rows={rows} active={active} onPick={setActive} onAdd={addAt} />
        <ol className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <li
              key={r.key}
              className={`flex flex-wrap items-center gap-2 rounded-box bg-base-100 p-2 ${active === r.key ? "ring-2 ring-warning" : ""} ${r.checked ? "" : "opacity-60"}`}
              onFocus={() => setActive(r.key)}
            >
              <input
                type="checkbox"
                className="checkbox checkbox-primary"
                checked={r.checked}
                aria-label={`Add ${r.name || "this"}`}
                onChange={(e) => set(r.key, { checked: e.target.checked })}
              />
              <span className="badge badge-soft badge-sm w-7 justify-center">{i + 1}</span>
              <input
                id={`scan-name-${r.key}`}
                className="input input-sm min-w-0 grow basis-32"
                value={r.name}
                placeholder="What is it?"
                aria-label={`Name of thing ${i + 1}`}
                maxLength={200}
                onChange={(e) => set(r.key, { name: e.target.value })}
              />
              <label className="input input-sm w-20 gap-1" title="How many">
                <span className="text-base-content/70">×</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  className="grow"
                  value={r.quantity}
                  aria-label={`How many of thing ${i + 1}`}
                  onChange={(e) => set(r.key, { quantity: Number(e.target.value) || 1 })}
                />
              </label>
              {categories.length > 0 && (
                <select
                  className="select select-sm min-w-0 basis-40 grow"
                  value={r.categoryId ?? ""}
                  aria-label={`Category of thing ${i + 1}`}
                  onChange={(e) => set(r.key, { categoryId: e.target.value || null })}
                >
                  <option value="">No category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.path}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ol>
      </div>
      {save.isError && <div className="alert alert-soft alert-error">{save.error.message}</div>}
      <div className="sticky bottom-[var(--tabbar,0px)] -mx-4 flex flex-wrap items-center gap-2 border-t border-base-300 bg-base-200/95 px-4 py-3 backdrop-blur-md">
        <button type="submit" className="btn btn-primary btn-wrap" disabled={!ticked.length || save.isPending}>
          {save.isPending && <span className="loading loading-spinner loading-sm" />}
          {progress ?? `Add ${ticked.length} ${ticked.length === 1 ? "thing" : "things"}`}
        </button>
        {!confirmDiscard ? (
          <button type="button" className="btn btn-text" disabled={save.isPending} onClick={() => setConfirmDiscard(true)}>
            Discard scan
          </button>
        ) : (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            Discard it and add nothing?
            <button type="button" className="btn btn-error btn-sm" onClick={onDismiss}>
              Discard
            </button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmDiscard(false)}>
              Keep
            </button>
          </span>
        )}
      </div>
    </form>
  );
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

async function loadPhoto(scanId: string, n: number) {
  const res = await fetch(api.roomScanPhotoUrl(scanId, n), { credentials: "include" });
  if (!res.ok) return null;
  return createImageBitmap(await res.blob());
}

/** The thing's part of the photo, with a little room round it, as a JPEG (no bigger than 800 px). */
async function cut(photo: ImageBitmap | null, box: [number, number, number, number]) {
  if (!photo) return null;
  const pad = 0.04;
  const x = clamp(box[0] - pad, 0, 1) * photo.width;
  const y = clamp(box[1] - pad, 0, 1) * photo.height;
  const w = Math.min(photo.width - x, (box[2] + pad * 2) * photo.width);
  const h = Math.min(photo.height - y, (box[3] + pad * 2) * photo.height);
  if (w < 8 || h < 8) return null;
  const scale = Math.min(1, 800 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(photo, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}
