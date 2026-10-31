/**
 * Room-by-room walkthrough — for cataloguing a house: pick a room, photograph its things one after another (each photo
 * becomes a "New item" there, uploaded in the background while you keep going), then review them one at a time with
 * what the vision model read off the photo filled in. Nothing the model says is saved until you save it.
 *
 *   #/walkthrough                  pick a room
 *   #/walkthrough/<room>           photograph
 *   #/walkthrough/<room>/review    review the room's "New item"s
 */
import { Steps } from "./Steps";
import { PhotoViewer } from "./PhotoViewer";
import type { Attachment, ItemListing, ItemPatch } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PlacePicker } from "./Combobox";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { findLocation, usePlaces } from "./lib/places";
import { WALKTHROUGH_HREF, placeHref, walkthroughHref } from "./lib/route";
import { pendingSuggestions } from "./Suggestions";

/** What "Add from photos" and the walkthrough call a thing until someone names it (lib/attention.ts knows it too). */
const PLACEHOLDER = "New item";

export function Walkthrough({ householdId, locationId, step }: { householdId: string; locationId: string | null; step: "photos" | "review" }) {
  const places = usePlaces(householdId);
  const canEdit = useCanEdit(householdId);
  const room = locationId ? findLocation(places.data, locationId) : undefined;
  const title = !room ? "Walk through a room" : step === "review" ? `Review ${room.node.name}` : room.node.name;
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href={room ? placeHref(room.node.id) : "#/"} className="btn btn-text btn-sm btn-square" aria-label="Back">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <HelpLink page="guide/walkthrough.html" label="Walkthrough" />
        </div>
      </nav>
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!canEdit && <div className="alert alert-soft alert-info">You can look around, but not add things, in this household.</div>}
        {canEdit && places.data && (
          <Steps
            label="Walkthrough steps"
            steps={[
              { label: "Choose a room", href: WALKTHROUGH_HREF },
              { label: "Photograph", href: room ? walkthroughHref(room.node.id) : undefined },
              { label: "Review" },
            ]}
            current={!room ? 0 : step === "photos" ? 1 : 2}
          />
        )}
        {places.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {places.data && !room && <PickRoom householdId={householdId} />}
        {room && canEdit && step === "photos" && <Photograph householdId={householdId} locationId={room.node.id} roomName={room.node.name} />}
        {room && canEdit && step === "review" && <Review householdId={householdId} locationId={room.node.id} roomName={room.node.name} />}
      </main>
    </div>
  );
}

function PickRoom({ householdId }: { householdId: string }) {
  const [place, setPlace] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-body gap-4">
        <p className="text-base-content/80">
          Photograph a room's things one after another — each photo becomes an item there. Then go through them: Ferret reads
          each photo and suggests what it is.
        </p>
        <PlacePicker householdId={householdId} id="walk-room" name="room" label="Which room?" value={place} onChange={setPlace} noneLabel="Pick a room" />
        <a href={place ? walkthroughHref(place) : undefined} aria-disabled={!place} className={`btn btn-primary ${place ? "" : "btn-disabled"}`}>
          <span className="icon-[tabler--camera] size-5" />
          Start
        </a>
      </div>
    </section>
  );
}

interface Shot {
  key: number;
  preview: string;
  status: "uploading" | "done" | "failed";
  error?: string;
}

/** The camera loop: each photo is a "New item" in the room, uploaded one after another while you carry on. */
function Photograph({ householdId, locationId, roomName }: { householdId: string; locationId: string; roomName: string }) {
  const qc = useQueryClient();
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const queue = useRef(Promise.resolve());
  const nextKey = useRef(0);
  const waiting = useQuery({
    queryKey: ["items", householdId, "walkthrough", locationId],
    queryFn: () => api.listItems(undefined, { locationId, limit: 200 }),
    select: (r) => r.data.filter((i) => i.name === PLACEHOLDER).length,
  });
  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  function add(files: File[]) {
    for (const file of files) {
      const key = nextKey.current++;
      setShots((s) => [{ key, preview: URL.createObjectURL(file), status: "uploading" }, ...s]);
      const set = (patch: Partial<Shot>) => setShots((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      // One at a time, in order, so a slow connection doesn't stack up uploads.
      queue.current = queue.current.then(async () => {
        try {
          const created = await api.createItem({ name: PLACEHOLDER, locationId, origin: "walkthrough" });
          try {
            await api.uploadAttachment(created.id, file, "photo", () => {});
          } catch (err) {
            await api.deleteItem(created.id).catch(() => {}); // no photo, no item
            throw err;
          }
          set({ status: "done" });
          void qc.invalidateQueries({ queryKey: ["items", householdId] });
          void qc.invalidateQueries({ queryKey: ["attention", householdId] });
        } catch (err) {
          set({ status: "failed", error: (err as Error).message });
        }
      });
    }
  }

  const uploading = shots.filter((s) => s.status === "uploading").length;
  const toReview = waiting.data ?? 0;
  return (
    <>
      <section className="card">
        <div className="card-body items-center gap-4 text-center">
          <p className="text-base-content/80">One thing per photo. Keep going — they upload while you work.</p>
          <button type="button" className="btn btn-primary btn-lg btn-wrap w-full max-w-sm" onClick={() => camera.current?.click()}>
            <span className="icon-[tabler--camera] size-6" />
            Take a photo
          </button>
          <button type="button" className="btn btn-text btn-sm" onClick={() => library.current?.click()}>
            Or pick from your photos
          </button>
          {/* `capture`: straight to the camera, each time. */}
          <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ""))} />
          <input ref={library} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ""))} />
          <p className="text-sm text-base-content/70" aria-live="polite">
            {shots.length === 0
              ? `Nothing photographed in ${roomName} yet.`
              : `${shots.length} photographed${uploading ? ` · uploading ${uploading}…` : ""}`}
          </p>
        </div>
      </section>

      {shots.length > 0 && (
        <ul className="grid grid-cols-4 gap-2" aria-label="Photos so far">
          {shots.map((s) => (
            <li key={s.key} className="relative aspect-square overflow-hidden rounded-box bg-base-300">
              <img src={s.preview} alt="" className="size-full object-cover" />
              <span
                className={`absolute end-1 bottom-1 grid size-6 place-items-center rounded-full ${s.status === "failed" ? "bg-error text-error-content" : "bg-base-100/90"}`}
                title={s.status === "failed" ? s.error : s.status === "uploading" ? "Uploading" : "Added"}
              >
                {s.status === "uploading" && <span className="loading loading-spinner loading-xs" />}
                {s.status === "done" && <span className="icon-[tabler--check] size-4 text-success" />}
                {s.status === "failed" && <span className="icon-[tabler--x] size-4" />}
              </span>
            </li>
          ))}
        </ul>
      )}

      <a href={walkthroughHref(locationId, "review")} className={`btn btn-soft btn-primary ${toReview ? "" : "btn-disabled"}`} aria-disabled={!toReview}>
        <span className="icon-[tabler--list-check] size-5" />
        {toReview ? `Review ${toReview} ${toReview === 1 ? "thing" : "things"}` : "Nothing to review yet"}
      </a>
    </>
  );
}

/** One "New item" at a time: its photo, what the model read, a name to confirm, and the rest to tick. */
function Review({ householdId, locationId, roomName }: { householdId: string; locationId: string; roomName: string }) {
  const [skipped, setSkipped] = useState<string[]>([]);
  /** Saved or deleted here: off the queue straight away, before the list catches up. */
  const [handled, setHandled] = useState<string[]>([]);
  const [saved, setSaved] = useState(0);
  const list = useQuery({
    queryKey: ["items", householdId, "walkthrough", locationId],
    queryFn: () => api.listItems(undefined, { locationId, limit: 200 }),
    select: (r) => r.data.filter((i) => i.name === PLACEHOLDER).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });
  const queue = (list.data ?? []).filter((i) => !skipped.includes(i.id) && !handled.includes(i.id));
  const current = queue[0];

  if (list.isPending) return <span className="loading loading-spinner text-primary mx-auto my-12" />;
  if (!current) {
    return (
      <section className="card">
        <div className="card-body items-center gap-3 text-center">
          <span className="icon-[tabler--circle-check] size-10 text-success" />
          <h2 className="text-lg font-semibold">{saved ? `${saved} ${saved === 1 ? "thing" : "things"} named` : "Nothing left to review"}</h2>
          {skipped.length > 0 && (
            <p className="text-sm text-base-content/70">
              {skipped.length} skipped — they wait in the bell as "New item".
            </p>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <a href={walkthroughHref(locationId)} className="btn btn-soft btn-primary">
              <span className="icon-[tabler--camera] size-5" />
              Photograph more
            </a>
            <a href={placeHref(locationId)} className="btn btn-primary">
              See {roomName}
            </a>
          </div>
        </div>
      </section>
    );
  }
  return (
    <>
      <p className="text-sm text-base-content/70" aria-live="polite">
        {queue.length} to go{saved ? ` · ${saved} done` : ""}
      </p>
      <ReviewCard
        key={current.id}
        item={current}
        householdId={householdId}
        onSaved={() => {
          setSaved((n) => n + 1);
          setHandled((h) => [...h, current.id]);
        }}
        onDeleted={() => setHandled((h) => [...h, current.id])}
        onSkip={() => setSkipped((s) => [...s, current.id])}
      />
    </>
  );
}

const FIELD_LABELS: Record<string, string> = { brand: "Brand", model: "Model", serialNumber: "Serial", barcode: "Barcode", purchaseDate: "Purchased", purchasePriceCents: "Price paid" };

function ReviewCard({
  item,
  householdId,
  onSaved,
  onDeleted,
  onSkip,
}: {
  item: ItemListing;
  householdId: string;
  onSaved: () => void;
  onDeleted: () => void;
  onSkip: () => void;
}) {
  const qc = useQueryClient();
  const files = useQuery({
    queryKey: ["attachments", householdId, item.id],
    queryFn: () => api.listAttachments(item.id),
    // Still being read: look again until it's done.
    refetchInterval: (q) => (q.state.data?.data.some((a) => a.analysisStatus === "pending") ? 3000 : false),
  });
  const photos: Attachment[] = (files.data?.data ?? []).filter((a) => a.kind === "photo");
  const reading = photos.some((a) => a.analysisStatus === "pending");
  const { rows } = pendingSuggestions(item, photos);
  const suggestedName = rows.find((r) => r.key === "name")?.value as string | undefined;
  const others = rows.filter((r) => r.key !== "name");
  const description = photos.find((a) => a.analysis?.description)?.analysis?.description;
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The model's name arrives after the photo's read: put it in, unless something's been typed.
  useEffect(() => {
    if (suggestedName && !name) setName(suggestedName);
  }, [suggestedName]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    for (const k of ["items", "attention", "overview", "places"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
  };
  const save = useMutation({
    mutationFn: (patch: ItemPatch) => api.updateItem(item.id, patch),
    onSuccess: () => {
      onSaved();
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteItem(item.id),
    onSuccess: () => {
      onDeleted();
      refresh();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const patch: ItemPatch = { name: name.trim() };
    for (const r of others) if (picked[r.key] !== false) Object.assign(patch, { [r.key]: r.value });
    save.mutate(patch);
  }

  const photo = photos[0];
  const [viewing, setViewing] = useState(false);
  return (
    <form className="card overflow-hidden" onSubmit={onSubmit}>
      {photo && (
        <button type="button" className="relative block" aria-label="Show the photo full screen" onClick={() => setViewing(true)}>
          <img src={api.attachmentUrl(photo.id)} alt="The photo to name" className="aspect-[4/3] w-full bg-base-300 object-contain" />
          <span className="badge absolute end-2 bottom-2 gap-1 border-0 bg-base-100/85">
            <span className="icon-[tabler--zoom-in] size-4" />
            {photos.length > 1 ? `${photos.length} photos` : "Zoom"}
          </span>
        </button>
      )}
      {viewing && (
        <PhotoViewer
          title={name.trim() || "New item"}
          photos={photos.map((p) => ({ id: p.id, filename: p.filename, caption: p.analysis?.description }))}
          start={0}
          onClose={() => setViewing(false)}
        />
      )}
      <div className="card-body gap-4">
        <p className="text-sm text-base-content/70" aria-live="polite">
          {reading ? (
            <span className="inline-flex items-center gap-2">
              <span className="loading loading-spinner loading-xs" />
              Reading the photo…
            </span>
          ) : description ? (
            description
          ) : photos.some((a) => a.analysisStatus === "failed") ? (
            "Couldn't read this photo — name it yourself."
          ) : (
            "Name it yourself."
          )}
        </p>
        <div>
          <label className="label-text" htmlFor={`walk-name-${item.id}`}>
            What is it?
          </label>
          <input id={`walk-name-${item.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={reading ? "Wait for a suggestion, or type it" : "e.g. Cordless drill"} maxLength={200} />
        </div>
        {others.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="label-text mb-1">Also read off the photo</legend>
            {others.map((r) => (
              <label key={r.key} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary checkbox-sm"
                  checked={picked[r.key] !== false}
                  onChange={(e) => setPicked((p) => ({ ...p, [r.key]: e.target.checked }))}
                />
                <span className="w-20 shrink-0 text-sm text-base-content/70">{FIELD_LABELS[r.key] ?? r.label}</span>
                <span className="min-w-0 truncate font-medium">{r.display}</span>
              </label>
            ))}
          </fieldset>
        )}
        {(save.error ?? remove.error) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary grow" disabled={!name.trim() || save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            Save &amp; next
          </button>
          <button type="button" className="btn btn-soft" onClick={onSkip}>
            Skip
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-base-300 pt-3">
          {confirmDelete ? (
            <>
              <span className="text-sm text-base-content/80">Delete this one? (Kept 30 days in Recently deleted.)</span>
              <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Delete
              </button>
              <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-text btn-error btn-sm" onClick={() => setConfirmDelete(true)}>
              <span className="icon-[tabler--trash] size-4" />
              Not worth keeping
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
