/**
 * Offline capture (lib/offline.ts): the screen Ferret opens when it can't reach the server on a device that was signed
 * in — take photos (each a "New item", in a room if picked) and scan codes (use one, restock, or add / find) — and, once
 * back online, the dashboard card that uploads them and asks about scans that need an answer.
 */
import type { ScanResult } from "@ferret/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { randomId } from "./lib/secure-context";
import { Modal } from "./Modal";
import { money, rememberedCurrency, showAmountsIn } from "./lib/money";
import { type OfflineThing, offlineThings } from "./lib/offline-recent";

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

const SCAN_ACTIONS: { value: ScanAction; label: MessageDescriptor; icon: string }[] = [
  { value: "use", label: msg`Used one`, icon: "icon-[tabler--minus]" },
  { value: "restock", label: msg`Restock`, icon: "icon-[tabler--plus]" },
  { value: "add", label: msg`Add`, icon: "icon-[tabler--square-plus]" },
  { value: "lookup", label: msg`Find`, icon: "icon-[tabler--search]" },
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
        id: randomId(),
        householdId: home.householdId,
        createdAt: Date.now(),
        kind: "photo",
        blob: f,
        filename: f.name || "photo.jpg",
        locationId,
        note: "",
      });
    }
    if (list?.length) setSaved(plural(list.length, { one: "# photo saved", other: "# photos saved" }));
  }

  async function addRoomScan(list: FileList | null) {
    const blobs = Array.from(list ?? []).slice(0, 5);
    if (!blobs.length || !locationId) return;
    await addCapture({ id: randomId(), householdId: home.householdId, createdAt: Date.now(), kind: "roomscan", blobs, locationId });
    setSaved(t`Room scan saved`);
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
          <Trans>Offline</Trans>
        </span>
        <button type="button" className="btn btn-soft btn-primary btn-sm ms-auto" onClick={() => window.location.reload()}>
          <span className="icon-[tabler--refresh] size-4" />
          <Trans>Try again</Trans>
        </button>
      </nav>
      <main className="mx-auto flex max-w-xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <section className="card">
          <div className="card-body gap-4">
            <div>
              <h1 className="text-xl font-semibold text-base-content"><Trans>Can't reach Ferret</Trans></h1>
              <p className="text-sm text-base-content/70">
                <Trans>Keep going: photos and scans wait on this phone and go up to {ph({ householdName: home.householdName })} by themselves when there's
                signal again.</Trans>
              </p>
            </div>
            <PlacePicker
              householdId={home.householdId}
              id="offline-place"
              name="locationId"
              label={t`Where you are (optional)`}
              noneLabel={t`Not in a room`}
              value={locationId}
              onChange={setLocationId}
            />
            <div className="grid grid-cols-1 gap-2 @container sm:grid-cols-3">
              <button type="button" className="btn btn-primary btn-wrap" onClick={() => camera.current?.click()}>
                <span className="icon-[tabler--camera] size-5" />
                <Trans>Take a photo</Trans>
              </button>
              <button type="button" className="btn btn-soft btn-primary btn-wrap" onClick={() => files.current?.click()}>
                <span className="icon-[tabler--photo] size-5" />
                <Trans>From photos</Trans>
              </button>
              <button type="button" className="btn btn-soft btn-primary btn-wrap" onClick={() => setScanning(true)}>
                <span className="icon-[tabler--barcode] size-5" />
                <Trans>Scan</Trans>
              </button>
            </div>
            {locationId && (
              <button type="button" className="btn btn-soft btn-primary btn-wrap" onClick={() => roomCamera.current?.click()}>
                <span className="icon-[tabler--scan-eye] size-5" />
                <Trans>Scan this room (up to 5 photos)</Trans>
              </button>
            )}
            <input ref={roomCamera} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void addRoomScan(e.target.files).then(() => (e.target.value = ""))} />
            <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))} />
            <input ref={files} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ""))} />
            {saved && (
              <div className="alert alert-soft alert-success text-sm" role="status">
                <span className="icon-[tabler--circle-check] size-5" />
                {saved === "Room scan saved" ? t`Room scan saved — Ferret looks at it once there's signal, and the bell says when it's ready.` : t`${saved} — each will be a "New item" to name.`}
              </div>
            )}
          </div>
        </section>

        <OfflineRecent householdId={home.householdId} />

        <section className="card" aria-labelledby="waiting-title">
          <div className="card-body gap-3">
            <h2 id="waiting-title" className="font-semibold text-base-content">
              <Trans>Waiting to upload</Trans> {captures.length > 0 && <span className="badge badge-soft badge-primary badge-sm">{captures.length}</span>}
            </h2>
            {captures.length === 0 && <p className="text-sm text-base-content/70"><Trans>Nothing yet.</Trans></p>}
            {photos.length > 0 && (
              <ul className="grid grid-cols-4 gap-2">
                {photos.map((p) => (
                  <li key={p.id} className="relative">
                    <Thumb blob={p.kind === "photo" ? p.blob : undefined} />
                    <button
                      type="button"
                      className="btn btn-circle btn-xs absolute end-1 top-1 border-0 bg-base-100/85 text-base-content shadow-sm"
                      aria-label={t`Don't upload this photo`}
                      onClick={() => window.confirm(t`Don't upload this photo?`) && void removeCapture(p.id)}
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
                        {plural(r.blobs.length, { one: "Room scan · # photo", other: "Room scan · # photos" })}
                      </span>
                      <button type="button" className="btn btn-text btn-xs" onClick={() => window.confirm(t`Don't upload this room scan?`) && void removeCapture(r.id)}>
                        <Trans>Remove</Trans>
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
                      <span className="text-base-content/70">{t(SCAN_ACTIONS.find((a) => a.value === s.mode)!.label)}</span>
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
            await addCapture({ id: randomId(), householdId: home.householdId, createdAt: Date.now(), kind: "scan", code, mode });
            beep();
            return true; // keep scanning
          }}
          top={
            <div className="join" role="group" aria-label={t`What a scan does`}>
              {SCAN_ACTIONS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  className={`btn btn-sm join-item ${mode === a.value ? "btn-primary" : "btn-soft bg-base-100/85"}`}
                  aria-pressed={mode === a.value}
                  onClick={() => setMode(a.value)}
                >
                  {t(a.label)}
                </button>
              ))}
            </div>
          }
          panel={
            <p className="rounded-box bg-base-100/90 px-3 py-2 text-center text-sm">
              {plural(scans.length, { one: "Offline — # scan saved to send later", other: "Offline — # scans saved to send later" })}
            </p>
          }
        />
      )}
    </div>
  );
}

/** Where a kept thing was: its room, and the box it's in. */
const whereOf = (item: OfflineThing["item"]) => [item.place, item.container?.name].filter(Boolean).join(" › ");

/** The things looked at last, kept on this device (lib/offline-recent.ts): browsed read-only with no signal. */
function OfflineRecent({ householdId }: { householdId: string }) {
  const [things, setThings] = useState<OfflineThing[] | null>(null);
  const [open, setOpen] = useState<OfflineThing | null>(null);
  // Amounts in the household's currency, as this device last saw it.
  useState(() => {
    showAmountsIn(rememberedCurrency(householdId));
    return true;
  });
  useEffect(() => {
    let live = true;
    offlineThings(householdId).then(
      (kept) => live && setThings(kept),
      () => live && setThings([]),
    );
    return () => {
      live = false;
    };
  }, [householdId]);
  if (!things?.length) return null;
  return (
    <section className="card" aria-labelledby="offline-recent-title">
      <div className="card-body gap-2">
        <div>
          <h2 id="offline-recent-title" className="font-semibold text-base-content">
            <Trans>Recently viewed</Trans>
          </h2>
          <p className="text-sm text-base-content/70">
            <Trans>Kept on this device: what you looked at last, as it was then.</Trans>
          </p>
        </div>
        <ul className="divide-y divide-base-content/10">
          {things.map((thing) => (
            <li key={thing.key}>
              <button type="button" className="flex min-h-11 w-full items-center gap-3 py-2 text-start" onClick={() => setOpen(thing)}>
                <span className="w-12 shrink-0">
                  <Thumb blob={thing.photo ?? undefined} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-base-content">{thing.item.name}</span>
                  {whereOf(thing.item) && <span className="block truncate text-sm text-base-content/70">{whereOf(thing.item)}</span>}
                </span>
                <span className="icon-[tabler--chevron-right] size-4 text-base-content/70 rtl:-scale-x-100" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      {open && <OfflineThingDetails thing={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** One kept thing, read-only: what matters when you can't reach Ferret (where it is, what it is, its numbers). */
function OfflineThingDetails({ thing, onClose }: { thing: OfflineThing; onClose: () => void }) {
  const item = thing.item;
  const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString();
  const rows: [string, string | null | undefined][] = [
    [t`Where`, whereOf(item)],
    [t`Brand`, item.brand],
    [t`Model`, item.model],
    [t`Serial number`, item.serialNumber],
    [t`How many`, item.quantity > 1 ? String(item.quantity) : null],
    [t`Category`, item.category],
    [t`Tags`, item.tags?.length ? item.tags.join(", ") : null],
    [t`Bought`, item.purchaseDate ? day(item.purchaseDate) : null],
    [t`Paid`, item.purchasePriceCents != null ? money(item.purchasePriceCents) : null],
    [t`Worth`, item.valueCents != null ? money(item.valueCents) : null],
    [t`Description`, item.description],
    [t`Notes`, item.notes],
  ];
  return (
    <Modal id="offline-thing" title={item.name} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {thing.photo && (
          <div className="mx-auto w-48">
            <Thumb blob={thing.photo} />
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-base-content/70">{label}</dt>
                <dd className="whitespace-pre-line break-words text-base-content">{value}</dd>
              </div>
            ))}
        </dl>
        <p className="text-xs text-base-content/70">
          <Trans>Saved on this device {ph({ when: new Date(thing.savedAt).toLocaleString() })}. Changes made since show once Ferret can be reached.</Trans>
        </p>
      </div>
    </Modal>
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
  // Whether the server reads photos: then they go to the inbox to be read first. Known once online.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
  const known = me.data !== undefined;
  const inbox = Boolean(me.data?.features.photoAi);
  useEffect(() => {
    if (!waiting.length || !known) return;
    let stop = false;
    const go = async () => {
      if (stop || !navigator.onLine) return;
      const done = await syncCaptures(householdId, { inbox }).catch(() => 0);
      if (done) for (const key of ["items", "overview", "places", "attention", "shopping", "inbox", "inbox-count"]) void qc.invalidateQueries({ queryKey: [key, householdId] });
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
  }, [householdId, waiting.length, known, inbox]);
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
          <Trans>Captured offline</Trans>
          {waiting.length > 0 && navigator.onLine && <span className="loading loading-spinner loading-xs" aria-label={t`Uploading`} />}
        </h2>
        {waiting.length > 0 && (
          <p className="text-sm text-base-content/70">
            <Trans>{ph({ count: waiting.length })} waiting to upload</Trans>{navigator.onLine ? "" : t` — when there's signal`}.
            {failed.length > 0 && <span className="text-error"> <Trans>{ph({ count: failed.length })} couldn't go up: {ph({ error: failed[0]!.error ?? "" })}</Trans></span>}
          </p>
        )}
        {failed.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {failed.map((c) => (
              <button key={c.id} type="button" className="btn btn-text btn-sm btn-error" onClick={() => window.confirm(t`Throw this one away?`) && void removeCapture(c.id)}>
                <Trans>Discard</Trans> {c.kind === "photo" ? "photo" : c.kind === "roomscan" ? t`room scan` : c.code}
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
      setError(e instanceof Error ? e.message : t`Something went wrong`);
    } finally {
      setBusy(false);
    }
  }
  const verb = t(SCAN_ACTIONS.find((a) => a.value === capture.mode)?.label ?? SCAN_ACTIONS[3]!.label);
  return (
    <li className="rounded-box bg-base-200 p-3 text-sm">
      <p className="mb-2">
        <span className="font-mono">{capture.code}</span> · {verb} ·{" "}
        {r.action === "choose"
          ? t`it's on several things — which?`
          : r.action === "ask"
            ? t`${ph({ name: r.item.name })}: what did you do?`
            : r.action === "unknown"
              ? t`nothing in Ferret has this code.`
              : r.action === "have"
                ? t`you have this already.`
                : r.action === "pairing"
                ? t`a smart-home setup code — open the scanner online to save it on its item.`
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
              <Trans>Used {ph({ step: r.step })}</Trans>
            </button>
            <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={busy} onClick={() => void act(() => answerScan(capture, { itemId: r.item.id, mode: "restock" }))}>
              <Trans>Added {ph({ step: r.step })}</Trans>
            </button>
            <Trans><a href={itemHref(r.item.id)} className="btn btn-text btn-sm">
              Open it
            </a></Trans>
          </>
        )}
        {r.action === "have" &&
          r.items.map((it) => (
            <button key={it.id} type="button" className="btn btn-soft btn-primary btn-sm btn-wrap" disabled={busy} onClick={() => void act(() => answerScan(capture, { itemId: it.id, mode: "restock" }))}>
              <Trans>Add {ph({ step: r.step })} to {ph({ name: it.name })} (now {ph({ after: it.quantity + r.step })}</Trans>)
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
            {r.action === "have" ? t`Add as a separate item` : t`Add it as a new thing`}
          </button>
        )}
        <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => void removeCapture(capture.id)}>
          <Trans>Dismiss</Trans>
        </button>
      </div>
      {error && <p className="mt-2 text-error">{error}</p>}
    </li>
  );
}
