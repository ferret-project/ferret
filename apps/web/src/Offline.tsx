/**
 * Offline capture (lib/offline.ts): the screen Ferret opens when it can't reach the server on a device that was signed
 * in — take photos (each a "New item", in a room if picked) and scan codes (use one, restock, or add / find) — and, once
 * back online, the dashboard card that uploads them and asks about scans that need an answer.
 */
import type { ScanResult } from "@ferret/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Logo } from "./AuthLayout";
import { PlacePicker } from "./Combobox";
import { api } from "./lib/api";
import { placesKey } from "./lib/places";
import { itemHref } from "./lib/route";
import {
  type Capture,
  type OfflineHome,
  type ScanAction,
  addCapture,
  answerScan,
  listCaptures,
  onCapturesChanged,
  removeCapture,
  syncCaptures,
} from "./lib/offline";
import { Scanner } from "./Scanner";
import { navigateTo } from "./lib/navigate";

/** The captures waiting on this device for a household, kept up to date. */
export function useCaptures(householdId: string) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void listCaptures(householdId).then((c) => live && setCaptures(c)).catch(() => {});
    load();
    const stop = onCapturesChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [householdId]);
  return captures;
}

const SCAN_ACTIONS: { value: ScanAction; label: string; icon: string }[] = [
  { value: "use", label: "Used one", icon: "icon-[tabler--minus]" },
  { value: "restock", label: "Restock", icon: "icon-[tabler--plus]" },
  { value: "add", label: "Add", icon: "icon-[tabler--square-plus]" },
  { value: "lookup", label: "Find", icon: "icon-[tabler--search]" },
];

/** A short beep (and a buzz where phones allow): the scan is saved. */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1200;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    navigator.vibrate?.(40);
  } catch {
    // no sound, then
  }
}

/** No signal (or the server's down) on a device that was signed in: capture now, upload later. */
export function OfflineCapture({ home }: { home: OfflineHome }) {
  const qc = useQueryClient();
  // The room picker reads the places query: give it the places kept on this device (once, before it first draws).
  useState(() => {
    if (home.places && !qc.getQueryData(placesKey(home.householdId))) qc.setQueryData(placesKey(home.householdId), home.places);
    return true;
  });
  const captures = useCaptures(home.householdId);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<ScanAction>("use");
  const [saved, setSaved] = useState<string | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const roomCamera = useRef<HTMLInputElement>(null);

  // Signal again: try the real app (which uploads what's waiting).
  useEffect(() => {
    const back = () => window.location.reload();
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);

  async function addPhotos(list: FileList | null) {
    for (const f of Array.from(list ?? [])) {
      await addCapture({
        id: crypto.randomUUID(),
        householdId: home.householdId,
        createdAt: Date.now(),
        kind: "photo",
        blob: f,
        filename: f.name || "photo.jpg",
        locationId,
        note: "",
      });
    }
    if (list?.length) setSaved(`${list.length} ${list.length === 1 ? "photo" : "photos"} saved`);
  }

  async function addRoomScan(list: FileList | null) {
    const blobs = Array.from(list ?? []).slice(0, 5);
    if (!blobs.length || !locationId) return;
    await addCapture({ id: crypto.randomUUID(), householdId: home.householdId, createdAt: Date.now(), kind: "roomscan", blobs, locationId });
    setSaved("Room scan saved");
  }

  const photos = captures.filter((c) => c.kind === "photo");
  const roomScans = captures.filter((c) => c.kind === "roomscan");
  const scans = captures.filter((c) => c.kind === "scan");

  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="sticky top-0 z-10 flex items-center gap-3 border-b border-base-300 bg-base-100/85 px-4 py-2.5 backdrop-blur-md">
        <Logo className="text-lg text-primary" />
        <span className="badge badge-soft badge-warning gap-1">
          <span className="icon-[tabler--wifi-off] size-4" />
          Offline
        </span>
        <button type="button" className="btn btn-soft btn-primary btn-sm ms-auto" onClick={() => window.location.reload()}>
          <span className="icon-[tabler--refresh] size-4" />
          Try again
        </button>
      </nav>
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <section className="card">
          <div className="card-body gap-4">
            <div>
              <h1 className="text-xl font-semibold text-base-content">Can't reach Ferret</h1>
              <p className="text-sm text-base-content/70">
                Keep going: photos and scans wait on this phone and go up to {home.householdName} by themselves when there's
                signal again.
              </p>
            </div>
            <PlacePicker
              householdId={home.householdId}
              id="offline-place"
              name="locationId"
              label="Where you are (optional)"
              noneLabel="Not in a room"
              value={locationId}
              onChange={setLocationId}
            />
            <div className="grid grid-cols-1 gap-2 @container sm:grid-cols-3">
              <button type="button" className="btn btn-primary btn-wrap" onClick={() => camera.current?.click()}>
                <span className="icon-[tabler--camera] size-5" />
                Take a photo
              </button>
              <button type="button" className="btn btn-soft btn-primary btn-wrap" onClick={() => files.current?.click()}>
                <span className="icon-[tabler--photo] size-5" />
                From photos
              </button>
              <button type="button" className="btn btn-soft btn-primary btn-wrap" onClick={() => setScanning(true)}>
                <span className="icon-[tabler--barcode] size-5" />
                Scan
              </button>
            </div>
            {locationId && (
              <button type="button" className="btn btn-soft btn-primary btn-wrap" onClick={() => roomCamera.current?.click()}>
                <span className="icon-[tabler--scan-eye] size-5" />
                Scan this room (up to 5 photos)
              </button>
            )}
            <input ref={roomCamera} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void addRoomScan(e.target.files).then(() => (e.target.value = ""))} />
            <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))} />
            <input ref={files} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))} />
            {saved && (
              <div className="alert alert-soft alert-success text-sm" role="status">
                <span className="icon-[tabler--circle-check] size-5" />
                {saved === "Room scan saved" ? "Room scan saved — Ferret looks at it once there's signal, and the bell says when it's ready." : `${saved} — each will be a "New item" to name.`}
              </div>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="waiting-title">
          <div className="card-body gap-3">
            <h2 id="waiting-title" className="font-semibold text-base-content">
              Waiting to upload {captures.length > 0 && <span className="badge badge-soft badge-primary badge-sm">{captures.length}</span>}
            </h2>
            {captures.length === 0 && <p className="text-sm text-base-content/70">Nothing yet.</p>}
            {photos.length > 0 && (
              <ul className="grid grid-cols-4 gap-2">
                {photos.map((p) => (
                  <li key={p.id} className="relative">
                    <Thumb blob={p.kind === "photo" ? p.blob : undefined} />
                    <button
                      type="button"
                      className="btn btn-circle btn-xs absolute end-1 top-1 border-0 bg-base-100/85"
                      aria-label="Don't upload this photo"
                      onClick={() => window.confirm("Don't upload this photo?") && void removeCapture(p.id)}
                    >
                      <span className="icon-[tabler--x] size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {roomScans.length > 0 && (
              <ul className="divide-y divide-base-content/10 text-sm">
                {roomScans.map((r) =>
                  r.kind === "roomscan" ? (
                    <li key={r.id} className="flex items-center gap-2 py-2">
                      <span className="icon-[tabler--scan-eye] size-4 text-base-content/70" />
                      <span className="min-w-0 flex-1 truncate">
                        Room scan · {r.blobs.length} {r.blobs.length === 1 ? "photo" : "photos"}
                      </span>
                      <button type="button" className="btn btn-text btn-xs" onClick={() => window.confirm("Don't upload this room scan?") && void removeCapture(r.id)}>
                        Remove
                      </button>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
            {scans.length > 0 && (
              <ul className="divide-y divide-base-content/10 text-sm">
                {scans.map((s) =>
                  s.kind === "scan" ? (
                    <li key={s.id} className="flex items-center gap-2 py-2">
                      <span className={`${SCAN_ACTIONS.find((a) => a.value === s.mode)!.icon} size-4 text-base-content/70`} />
                      <span className="min-w-0 flex-1 truncate font-mono">{s.code}</span>
                      <span className="text-base-content/70">{SCAN_ACTIONS.find((a) => a.value === s.mode)!.label}</span>
                    </li>
                  ) : null,
                )}
              </ul>
            )}
          </div>
        </section>
      </main>

      {scanning && (
        <Scanner
          onClose={() => setScanning(false)}
          onResult={async (code) => {
            await addCapture({ id: crypto.randomUUID(), householdId: home.householdId, createdAt: Date.now(), kind: "scan", code, mode });
            beep();
            return true; // keep scanning
          }}
          top={
            <div className="join" role="group" aria-label="What a scan does">
              {SCAN_ACTIONS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  className={`btn btn-sm join-item ${mode === a.value ? "btn-primary" : "btn-soft bg-base-100/85"}`}
                  aria-pressed={mode === a.value}
                  onClick={() => setMode(a.value)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          }
          panel={
            <p className="rounded-box bg-base-100/90 px-3 py-2 text-center text-sm">
              Offline — {scans.length} {scans.length === 1 ? "scan" : "scans"} saved to send later
            </p>
          }
        />
      )}
    </div>
  );
}

function Thumb({ blob }: { blob?: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" className="aspect-square w-full rounded-box bg-base-300 object-cover" /> : <span className="block aspect-square rounded-box bg-base-300" />;
}

/**
 * Back online, on any screen: uploads what was captured offline — straight away, when the signal returns, and every
 * half minute while some wait.
 */
export function useCaptureSync(householdId: string) {
  const captures = useCaptures(householdId);
  const qc = useQueryClient();
  const waiting = captures.filter((c) => !(c.kind === "scan" && c.result));
  useEffect(() => {
    if (!waiting.length) return;
    let stop = false;
    const go = async () => {
      if (stop || !navigator.onLine) return;
      const done = await syncCaptures(householdId).catch(() => 0);
      if (done) for (const key of ["items", "overview", "places", "attention", "shopping"]) void qc.invalidateQueries({ queryKey: [key, householdId] });
    };
    void go();
    window.addEventListener("online", go);
    const timer = setInterval(go, 30_000);
    return () => {
      stop = true;
      window.removeEventListener("online", go);
      clearInterval(timer);
    };
    // Re-run when the number waiting changes, not on every capture update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, waiting.length]);
}

/** On the dashboard: what's still waiting from offline, and the scans whose answer needs someone. */
export function CapturesCard({ householdId }: { householdId: string }) {
  const captures = useCaptures(householdId);
  const waiting = captures.filter((c) => !(c.kind === "scan" && c.result));
  const needs = captures.filter((c): c is Extract<Capture, { kind: "scan" }> => c.kind === "scan" && Boolean(c.result));
  if (!captures.length) return null;
  const failed = waiting.filter((c) => c.error);
  return (
    <section className="card border border-warning/30" aria-labelledby="captures-title">
      <div className="card-body gap-3">
        <h2 id="captures-title" className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--cloud-upload] size-5 text-primary" />
          Captured offline
          {waiting.length > 0 && navigator.onLine && <span className="loading loading-spinner loading-xs" aria-label="Uploading" />}
        </h2>
        {waiting.length > 0 && (
          <p className="text-sm text-base-content/70">
            {waiting.length} waiting to upload{navigator.onLine ? "" : " — when there's signal"}.
            {failed.length > 0 && <span className="text-error"> {failed.length} couldn't go up: {failed[0]!.error}</span>}
          </p>
        )}
        {failed.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {failed.map((c) => (
              <button key={c.id} type="button" className="btn btn-text btn-sm btn-error" onClick={() => window.confirm("Throw this one away?") && void removeCapture(c.id)}>
                Discard {c.kind === "photo" ? "photo" : c.kind === "roomscan" ? "room scan" : c.code}
              </button>
            ))}
          </div>
        )}
        {needs.length > 0 && (
          <ul className="flex flex-col gap-3">
            {needs.map((c) => (
              <NeedsAnswer key={c.id} capture={c} householdId={householdId} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** A scan from offline whose answer needs someone: which item, what to do, or "nothing has this code". */
function NeedsAnswer({ capture, householdId }: { capture: Extract<Capture, { kind: "scan" }>; householdId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = capture.result as ScanResult;
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      for (const key of ["items", "overview", "shopping", "stock"]) void qc.invalidateQueries({ queryKey: [key, householdId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  const verb = capture.mode === "use" ? "Used one" : capture.mode === "restock" ? "Restock" : capture.mode === "add" ? "Add" : "Find";
  return (
    <li className="rounded-box bg-base-200 p-3 text-sm">
      <p className="mb-2">
        <span className="font-mono">{capture.code}</span> · {verb} ·{" "}
        {r.action === "choose"
          ? "it's on several things — which?"
          : r.action === "ask"
            ? `${r.item.name}: what did you do?`
            : r.action === "unknown"
              ? "nothing in Ferret has this code."
              : r.action === "have"
                ? "you have this already."
                : r.action === "pairing"
                ? "a smart-home setup code — open the scanner online to save it on its item."
                : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {r.action === "choose" &&
          r.items.map((it) => (
            <button key={it.id} type="button" className="btn btn-soft btn-primary btn-sm" disabled={busy} onClick={() => void act(() => answerScan(capture, { itemId: it.id }))}>
              {it.name}
            </button>
          ))}
        {r.action === "ask" && (
          <>
            <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={busy} onClick={() => void act(() => answerScan(capture, { itemId: r.item.id, mode: "use" }))}>
              Used {r.step}
            </button>
            <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={busy} onClick={() => void act(() => answerScan(capture, { itemId: r.item.id, mode: "restock" }))}>
              Added {r.step}
            </button>
            <a href={itemHref(r.item.id)} className="btn btn-text btn-sm">
              Open it
            </a>
          </>
        )}
        {r.action === "have" &&
          r.items.map((it) => (
            <button key={it.id} type="button" className="btn btn-soft btn-primary btn-sm btn-wrap" disabled={busy} onClick={() => void act(() => answerScan(capture, { itemId: it.id, mode: "restock" }))}>
              Add {r.step} to {it.name} (now {it.quantity + r.step})
            </button>
          ))}
        {(r.action === "unknown" || r.action === "have") && (
          <button
            type="button"
            className="btn btn-soft btn-primary btn-sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const item = await api.createItem({ name: "New item", barcode: capture.code, origin: "scan" });
                await removeCapture(capture.id);
                navigateTo(itemHref(item.id));
              })
            }
          >
            {r.action === "have" ? "Add as a separate item" : "Add it as a new thing"}
          </button>
        )}
        <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => void removeCapture(capture.id)}>
          Dismiss
        </button>
      </div>
      {error && <p className="mt-2 text-error">{error}</p>}
    </li>
  );
}
