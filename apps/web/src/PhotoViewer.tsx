/**
 * Photos full screen: one at a time, with ‹ › (arrow keys, or swipe on a phone), double-tap or the + button to zoom
 * (drag to look around), the photo's description as a caption, and its original to open or save. Esc or ✕ closes.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./lib/api";

export interface ViewerPhoto {
  id: string;
  filename: string;
  caption?: string | null;
  /** Only its small copy is kept (the original was removed to free space). */
  smallCopy?: boolean;
}

export function PhotoViewer(props: { photos: ViewerPhoto[]; start: number; title: string; onClose: () => void }) {
  const { photos, onClose } = props;
  const [index, setIndex] = useState(Math.min(props.start, photos.length - 1));
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null); // the point zoomed in on, 0–1
  const drag = useRef<{ x: number; y: number; moved: boolean; zoomStart?: { x: number; y: number } } | null>(null);
  const lastTap = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const photo = photos[index];
  const many = photos.length > 1;

  const go = (step: number) => {
    setZoom(null);
    setIndex((i) => (i + step + photos.length) % photos.length);
  };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && many) go(1);
      else if (e.key === "ArrowLeft" && many) go(-1);
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!photo) return null;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false, zoomStart: zoom ?? undefined };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    // Zoomed in: dragging moves around the photo.
    if (d.zoomStart) {
      const box = e.currentTarget.getBoundingClientRect();
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      setZoom({ x: clamp(d.zoomStart.x - dx / box.width), y: clamp(d.zoomStart.y - dy / box.height) });
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dx = e.clientX - d.x;
    // Not zoomed: a sideways swipe changes photo.
    if (!d.zoomStart && many && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - d.y)) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (d.moved) return;
    // A double tap zooms in on that spot, or back out.
    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      const box = e.currentTarget.getBoundingClientRect();
      setZoom(zoom ? null : { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
    } else {
      lastTap.current = now;
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={`${props.title} — photo ${index + 1} of ${photos.length}`}
    >
      <div className="flex items-center gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <p className="min-w-0 flex-1 truncate text-sm text-white/80">
          {props.title}
          {many && ` · ${index + 1} of ${photos.length}`}
        </p>
        <button
          type="button"
          className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15"
          aria-label={zoom ? "Zoom out" : "Zoom in"}
          aria-pressed={Boolean(zoom)}
          onClick={() => setZoom(zoom ? null : { x: 0.5, y: 0.5 })}
        >
          <span className={`${zoom ? "icon-[tabler--zoom-out]" : "icon-[tabler--zoom-in]"} size-5`} />
        </button>
        <a
          href={api.attachmentUrl(photo.id)}
          target="_blank"
          rel="noreferrer"
          className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15"
          aria-label={`Open the original of ${photo.filename}`}
        >
          <span className="icon-[tabler--external-link] size-5" />
        </a>
        <button ref={closeButton} type="button" className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15" aria-label="Close" onClick={onClose}>
          <span className="icon-[tabler--x] size-5" />
        </button>
      </div>

      <div
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden ${zoom ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <img
          key={photo.id}
          src={api.attachmentUrl(photo.id)}
          alt={photo.caption || photo.filename}
          draggable={false}
          className="size-full object-contain transition-transform duration-200 motion-reduce:transition-none"
          style={zoom ? { transform: "scale(2.5)", transformOrigin: `${zoom.x * 100}% ${zoom.y * 100}%` } : undefined}
        />
        {many && (
          <>
            <button
              type="button"
              className="btn btn-circle absolute start-3 top-1/2 -translate-y-1/2 border-0 bg-black/50 text-white hover:bg-black/70 max-sm:hidden"
              aria-label="Previous photo"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={() => go(-1)}
            >
              <span className="icon-[tabler--chevron-left] size-6" />
            </button>
            <button
              type="button"
              className="btn btn-circle absolute end-3 top-1/2 -translate-y-1/2 border-0 bg-black/50 text-white hover:bg-black/70 max-sm:hidden"
              aria-label="Next photo"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={() => go(1)}
            >
              <span className="icon-[tabler--chevron-right] size-6" />
            </button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {photo.caption && <p className="mx-auto max-w-3xl text-center text-sm text-white/85">{photo.caption}</p>}
        {photo.smallCopy && <p className="mx-auto max-w-3xl text-center text-xs text-white/85">Only a small copy of this photo is kept.</p>}
        {many && (
          <div className="flex justify-center gap-2 overflow-x-auto" role="group" aria-label="Photos">
            {photos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                aria-label={`Photo ${i + 1}`}
                aria-current={i === index}
                onClick={() => {
                  setZoom(null);
                  setIndex(i);
                }}
                className={`size-12 shrink-0 overflow-hidden rounded-field border-2 ${i === index ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
              >
                <img src={api.thumbnailUrl(p.id)} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
