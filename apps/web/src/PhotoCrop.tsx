/**
 * Crop a photo down to the thing (one item on a busy shelf, a label): drag the box or its corners — or, from the
 * keyboard, arrows move it and Shift+arrows resize it — optionally kept square, as photos show in lists. The crop is
 * cut here from the full photo and saved as a new photo of the item (the original is kept), by default as its main
 * photo; "Use as main photo" makes the photo itself the main one, uncropped.
 *
 * `CapturedPhoto` is the same crop box for a photo just taken with the camera, before it's uploaded: use it as it is,
 * crop it, or take it again (a phone's own camera has no crop of its own).
 */
import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import type { Attachment } from "@ferret/shared";
import { api } from "./lib/api";
import { DialogActions, Modal } from "./Modal";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** The crop as fractions of the photo (0–1). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Grip = "move" | "nw" | "ne" | "sw" | "se";

const MIN = 0.08;
/** The crop's longest side at most (plenty for an item's photo, and well under the upload limit). */
const MAX_PX = 2400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A square in the photo's pixels: its height as a fraction is its width's × the photo's width ÷ height. */
function squared(b: Box, ratio: number, keep: "w" | "h" = "w"): Box {
  let w = b.w;
  let h = b.h;
  if (keep === "w") h = w * ratio;
  else w = h / ratio;
  if (h > 1) [h, w] = [1, 1 / ratio];
  if (w > 1) [w, h] = [1, ratio];
  return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h };
}

const WHOLE: Box = { x: 0, y: 0, w: 1, h: 1 };
const isWhole = (b: Box) => b.x < 0.005 && b.y < 0.005 && b.w > 0.99 && b.h > 0.99;

/** The photo with a box to drag onto the thing, its corners to fit — the part shared by both dialogs. */
function CropArea(props: { src: string; alt: string; box: Box; onBox: (b: Box | ((b: Box) => Box)) => void; square: boolean; ratio: number; onRatio: (r: number) => void }) {
  const { box, onBox: setBox, square, ratio } = props;
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ grip: Grip; startX: number; startY: number; start: Box } | null>(null);

  function moveTo(grip: Grip, start: Box, dx: number, dy: number): Box {
    if (grip === "move") return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
    let { x, y, w, h } = start;
    const right = x + w;
    const bottom = y + h;
    if (grip === "nw" || grip === "sw") x = clamp(x + dx, 0, right - MIN);
    if (grip === "nw" || grip === "ne") y = clamp(y + dy, 0, bottom - MIN);
    w = grip === "ne" || grip === "se" ? clamp(start.w + dx, MIN, 1 - start.x) : right - x;
    h = grip === "sw" || grip === "se" ? clamp(start.h + dy, MIN, 1 - start.y) : bottom - y;
    if (!square) return { x, y, w, h };
    // Square: follow the wider pull, anchored at the opposite corner.
    const s = squared({ x, y, w, h }, ratio, Math.abs(dx) >= Math.abs(dy) * ratio ? "w" : "h");
    return {
      ...s,
      x: grip === "nw" || grip === "sw" ? clamp(right - s.w, 0, 1 - s.w) : start.x,
      y: grip === "nw" || grip === "ne" ? clamp(bottom - s.h, 0, 1 - s.h) : start.y,
    };
  }

  const onDown = (grip: Grip) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { grip, startX: e.clientX, startY: e.clientY, start: box };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const rect = frame.current?.getBoundingClientRect();
    if (!d || !rect) return;
    setBox(moveTo(d.grip, d.start, (e.clientX - d.startX) / rect.width, (e.clientY - d.startY) / rect.height));
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent) => {
    const step = 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    setBox((b) => moveTo(e.shiftKey ? "se" : "move", b, d[0]!, d[1]!));
  };

  const grips: [Grip, string][] = [
    ["nw", "start-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"],
    ["ne", "end-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"],
    ["sw", "start-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"],
    ["se", "end-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"],
  ];
  // The padding leaves room for the corner grips when the box is the whole photo; the shade is clipped to it.
  return (
    <div className="flex justify-center overflow-hidden rounded-box bg-base-300 p-4 select-none" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div ref={frame} className="relative inline-block touch-none" dir="ltr">
        <img
          src={props.src}
          alt={props.alt}
          draggable={false}
          className="block max-h-[55dvh] w-auto max-w-full"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) props.onRatio(img.naturalWidth / img.naturalHeight);
          }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label={t`Crop area — arrows move it, Shift and arrows resize it`}
          aria-valuetext={t`${ph({ round: Math.round(box.w * 100) })}% wide, ${ph({ round2: Math.round(box.h * 100) })}% high`}
          className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
          onPointerDown={onDown("move")}
          onKeyDown={onKey}
        >
          {/* The rule of thirds, faintly. */}
          <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="border-[0.5px] border-white/30" />
            ))}
          </div>
          {grips.map(([grip, place]) => (
            // A 44 px target around a small white corner.
            <span key={grip} aria-hidden className={`absolute flex size-11 items-center justify-center ${place}`} onPointerDown={onDown(grip)}>
              <span className="size-4 rounded-full border-2 border-primary bg-white shadow" />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function SquareToggle({ square, onChange }: { square: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={square} onChange={(e) => onChange(e.target.checked)} />
      <Trans>Square (as photos show in lists)</Trans>
    </label>
  );
}

export function PhotoCrop(props: { photo: Attachment; itemId: string; isMain: boolean; onSaved: () => void; onClose: () => void }) {
  const { photo, itemId } = props;
  const [box, setBox] = useState<Box>({ x: 0.15, y: 0.15, w: 0.7, h: 0.7 });
  const [ratio, setRatio] = useState(1); // the photo's width ÷ height, once it's loaded
  const [square, setSquare] = useState(false);
  const [main, setMain] = useState(true);

  const refresh = props.onSaved;
  const save = useMutation({
    mutationFn: async () => {
      const crop = await cut(api.attachmentUrl(photo.id), box);
      const name = photo.filename.replace(/\.[^.]+$/, "");
      return api.uploadCrop(itemId, crop, { filename: `${name} (cropped).jpg`, main, croppedFrom: photo.id });
    },
    onSuccess: () => {
      refresh();
      props.onClose();
    },
  });
  const makeMain = useMutation({
    mutationFn: () => api.setMainPhoto(photo.id),
    onSuccess: () => {
      refresh();
      props.onClose();
    },
  });

  const busy = save.isPending || makeMain.isPending;
  return (
    <Modal id="photo-crop" title={t`Crop photo`} onClose={props.onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-base-content/70">
          <Trans>Drag the box onto the thing, and its corners to fit. The crop is saved as a new photo — the original stays.</Trans>
        </p>
        <CropArea src={api.attachmentUrl(photo.id)} alt={photo.analysis?.description || photo.filename} box={box} onBox={setBox} square={square} ratio={ratio} onRatio={setRatio} />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <SquareToggle
            square={square}
            onChange={(on) => {
              setSquare(on);
              if (on) setBox((b) => squared(b, ratio));
            }}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={main} onChange={(e) => setMain(e.target.checked)} />
            <Trans>Make it the main photo</Trans>
          </label>
        </div>
        {(save.isError || makeMain.isError) && (
          <p className="text-sm text-error">{(save.error ?? makeMain.error)?.message ?? t`Couldn't save the crop — try again.`}</p>
        )}
        <DialogActions>
          {!props.isMain && (
            <button type="button" className="btn btn-text me-auto" disabled={busy} onClick={() => makeMain.mutate()}>
              {makeMain.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--star] size-4" />}
              <Trans>Use as main photo, uncropped</Trans>
            </button>
          )}
          <button type="button" className="btn btn-soft btn-secondary" onClick={props.onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save.mutate()}>
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--crop] size-4" />}
            <Trans>Save crop</Trans>
          </button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/**
 * A photo just taken, before it's added: the whole photo unless the box is dragged in, then the part inside it.
 * "Retake" opens the camera again.
 */
export function CapturedPhoto(props: { file: File; onUse: (file: File) => void; onRetake: () => void; onClose: () => void }) {
  const { file } = props;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [box, setBox] = useState<Box>(WHOLE);
  const [ratio, setRatio] = useState(1);
  const [square, setSquare] = useState(false);
  const whole = isWhole(box);
  const use = useMutation({
    mutationFn: async () => {
      if (whole || !src) return file;
      const crop = await cut(src, box);
      return new File([crop], `${file.name.replace(/\.[^.]+$/, "") || "photo"} (cropped).jpg`, { type: "image/jpeg" });
    },
    onSuccess: (f) => props.onUse(f),
  });

  return (
    <Modal id="captured-photo" title={t`Use this photo?`} onClose={props.onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-base-content/70">
          <Trans>To keep just part of it, drag the corners in.</Trans>
        </p>
        {src && <CropArea src={src} alt={t`The photo you took`} box={box} onBox={setBox} square={square} ratio={ratio} onRatio={setRatio} />}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <SquareToggle
            square={square}
            onChange={(on) => {
              setSquare(on);
              setBox((b) => (on ? squared(isWhole(b) ? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } : b, ratio) : b));
            }}
          />
          {!whole && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => (setSquare(false), setBox(WHOLE))}>
              <span className="icon-[tabler--arrows-maximize] size-4" />
              <Trans>Whole photo</Trans>
            </button>
          )}
        </div>
        {use.isError && <p className="text-sm text-error">{use.error.message}</p>}
        <DialogActions>
          <button type="button" className="btn btn-text me-auto" disabled={use.isPending} onClick={props.onRetake}>
            <span className="icon-[tabler--camera-rotate] size-4" />
            <Trans>Retake</Trans>
          </button>
          <button type="button" className="btn btn-soft btn-secondary" onClick={props.onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="button" className="btn btn-primary" disabled={use.isPending || !src} onClick={() => use.mutate()}>
            {use.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className={`${whole ? "icon-[tabler--check]" : "icon-[tabler--crop]"} size-4`} />}
            {whole ? <Trans>Use photo</Trans> : <Trans>Use crop</Trans>}
          </button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/** Cuts the box out of the full photo (upright, as shown) as a JPEG, at most MAX_PX along its longest side. */
async function cut(url: string, box: Box): Promise<Blob> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(t`Couldn't load the photo — try again`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const sx = Math.round(box.x * bitmap.width);
    const sy = Math.round(box.y * bitmap.height);
    const sw = Math.max(1, Math.round(box.w * bitmap.width));
    const sh = Math.max(1, Math.round(box.h * bitmap.height));
    const scale = Math.min(1, MAX_PX / Math.max(sw, sh));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(sw * scale), height: Math.round(sh * scale) });
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t`This browser can't crop photos`);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error(t`Couldn't make the crop`);
    return blob;
  } finally {
    bitmap.close();
  }
}
