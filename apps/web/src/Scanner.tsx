/**
 * Full-screen barcode scanner: the back camera, a few frames a second through
 * the decoder, and a "take a photo instead" fallback for browsers that won't
 * give live video (or when the light's bad).
 *
 * One code and it's done — unless `onResult` answers true, then it keeps
 * scanning (a session of stocking shelves: ScanSession.tsx), ignoring the same
 * code for a moment so one barcode isn't counted twice (until `fresh` changes:
 * a new scanner mode reads it again). `paused` stops reading while a question
 * is on screen; `top` and `panel` are the caller's controls.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { readBarcode } from "./lib/barcode";

/** The same code again within this long is the same scan, still in front of the camera. */
const REPEAT_MS = 2500;

export function Scanner({
  onResult,
  onClose,
  paused = false,
  fresh,
  top,
  panel,
  panelAt = "bottom",
}: {
  /** True: keep scanning. */
  onResult: (code: string) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  paused?: boolean;
  /** Changing it forgets the last code, so the one in view counts again. */
  fresh?: unknown;
  top?: ReactNode;
  panel?: ReactNode;
  /** Where the panel sits over the camera: the bottom, or the top (for one with a dropdown that opens downwards). */
  panelAt?: "top" | "bottom";
}) {
  const video = useRef<HTMLVideoElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const last = useRef({ code: "", at: 0 });
  useEffect(() => {
    last.current = { code: "", at: 0 };
  }, [fresh]);

  /** Turns the camera off. Called the moment we're done, on close, and when the app is hidden. */
  const stopCamera = useRef<() => void>(() => {});

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
    stopCamera.current = stop;
    // Don't keep the camera on while the app is in the background.
    const onHidden = () => document.visibilityState === "hidden" && stop();
    document.addEventListener("visibilitychange", onHidden);

    const scan = async () => {
      if (stopped) return;
      const v = video.current;
      // While a question is up, the code that asked it is probably still in view: when it's answered, that's the same
      // scan, not a new one.
      if (pausedRef.current) last.current.at = Date.now();
      else if (v && v.readyState >= 2) {
        try {
          const code = await readBarcode(v);
          const now = Date.now();
          if (code && !stopped && !(code === last.current.code && now - last.current.at < REPEAT_MS)) {
            last.current = { code, at: now };
            if (!(await onResultRef.current(code))) return stop(); // camera off before anything else happens
          } else if (code) {
            last.current.at = now; // still in view: keep ignoring it
          }
        } catch (err) {
          setError(`Couldn't read barcodes here: ${(err as Error).message}`);
          return;
        }
      }
      timer = setTimeout(scan, 250);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => {
        stream = s;
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        void scan();
      })
      .catch(() => setError("Camera not available — take a photo of the barcode instead."));
    if (!navigator.mediaDevices) setError("Camera not available — take a photo of the barcode instead.");

    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, []);

  async function fromPhoto(file: File) {
    setBusy(true);
    try {
      const code = await readBarcode(await createImageBitmap(file));
      if (code) {
        if (!(await onResultRef.current(code))) stopCamera.current();
      } else setError("No barcode found in that photo. Try again, closer and in good light.");
    } catch (err) {
      setError(`Couldn't read that photo: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Scan a barcode">
      <div className="flex items-center justify-between p-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
        <span className="font-semibold">Scan a barcode</span>
        <button
          type="button"
          className="btn btn-circle btn-text text-white"
          aria-label="Close scanner"
          onClick={() => {
            stopCamera.current();
            onClose();
          }}
        >
          <span className="icon-[tabler--x] size-6" />
        </button>
      </div>
      {top}
      <div className="relative flex-1">
        <div className="absolute inset-0 overflow-hidden">
          <video ref={video} className="h-full w-full object-cover" playsInline muted aria-hidden />
          {/* Aiming guide */}
          <div className="rounded-box pointer-events-none absolute inset-x-8 top-1/2 h-32 -translate-y-1/2 border-2 border-white/80" />
        </div>
        {/* Outside the camera's clipping, so a panel's dropdown can spill over. */}
        {panel && <div className={`absolute inset-x-0 z-10 p-3 ${panelAt === "top" ? "top-0" : "bottom-0"}`}>{panel}</div>}
      </div>
      <div className="flex flex-col items-center gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {error ? (
          <p className="text-center text-sm text-white/90">{error}</p>
        ) : (
          <p className="text-center text-sm text-white/70">Point the camera at the barcode.</p>
        )}
        <button type="button" className="btn btn-soft btn-primary" disabled={busy} onClick={() => photo.current?.click()}>
          {busy ? <span className="loading loading-spinner loading-sm" /> : <span className="icon-[tabler--camera] size-5" />}
          Take a photo instead
        </button>
        <input
          ref={photo}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void fromPhoto(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
