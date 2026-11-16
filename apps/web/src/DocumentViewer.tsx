/**
 * A file full screen inside the app, with a Close button (lib/documents.ts opens it): a PDF drawn page by page with
 * pdf.js (fit to the width, zoom with − / +), a picture as it is, anything else as its name. Opened from a search, a PDF
 * opens at the first page with the search's words, marked, with ‹ › to the other pages that have them
 * (lib/pdf-find.ts). Share hands the file to the phone (save to Files, open in Books, print); on a computer it can also
 * open in the browser's own tab. Esc or Close closes.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { t, plural, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { closeDocument, opensInApp, useOpenDocument, type OpenDocument } from "./lib/documents";
import { findInPdf, type PageMatches } from "./lib/pdf-find";

const ZOOMS = [1, 1.5, 2, 3];
/** iOS won't draw a canvas bigger than this many pixels (it goes blank). */
const MAX_CANVAS_PIXELS = 16_000_000;

/** Mounted once at the root; shows whatever lib/documents.ts opened. */
export function DocumentViewerHost() {
  const doc = useOpenDocument();
  return doc ? <DocumentViewer key={doc.url} doc={doc} onClose={closeDocument} /> : null;
}

type Loaded = { file: File; kind: "pdf" | "image" | "other"; objectUrl?: string };

function filenameOf(res: Response, fallback: string) {
  const header = res.headers.get("Content-Disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      /* fall through */
    }
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1] ?? (fallback || t`File`);
}

export function DocumentViewer({ doc, onClose }: { doc: OpenDocument; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [pages, setPages] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let objectUrl: string | undefined;
    let stop = false;
    void (async () => {
      try {
        const res = await fetch(doc.url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const type = blob.type || res.headers.get("Content-Type") || "";
        const file = new File([blob], filenameOf(res, doc.label), { type });
        const kind = type === "application/pdf" ? "pdf" : type.startsWith("image/") ? "image" : "other";
        if (kind === "image") objectUrl = URL.createObjectURL(blob);
        if (!stop) setLoaded({ file, kind, objectUrl });
      } catch {
        if (!stop) setFailed(true);
      }
    })();
    return () => {
      stop = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    // Before anything under it (the photo viewer, a dialog) hears the Esc.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, [onClose]);

  const name = loaded?.file.name ?? doc.label;
  const canShare = loaded && typeof navigator.canShare === "function" && navigator.canShare({ files: [loaded.file] });
  const zoomable = loaded?.kind === "pdf" || loaded?.kind === "image";

  async function share() {
    if (!loaded) return;
    try {
      await navigator.share({ files: [loaded.file], title: loaded.file.name });
    } catch {
      /* closed the share sheet */
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={name}>
      <div className="flex items-center gap-1 p-2 ps-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <p className="min-w-0 flex-1 truncate text-sm text-white/80">
          {name}
          {pages > 1 && <span className="text-white/70"> · {plural(pages, { one: "# page", other: "# pages" })}</span>}
        </p>
        {zoomable && (
          <>
            <button type="button" className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15" aria-label={t`Zoom out`} disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
              <span className="icon-[tabler--zoom-out] size-5" />
            </button>
            <button type="button" className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15" aria-label={t`Zoom in`} disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>
              <span className="icon-[tabler--zoom-in] size-5" />
            </button>
          </>
        )}
        {!opensInApp() && (
          <a href={doc.url} target="_blank" rel="noreferrer" data-native className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15" aria-label={t`Open ${name} in a new tab`} title={t`Open in a new tab`}>
            <span className="icon-[tabler--external-link] size-5" />
          </a>
        )}
        {canShare && (
          <button type="button" className="btn btn-circle btn-sm btn-text text-white hover:bg-white/15" aria-label={t`Share or save ${name}`} onClick={() => void share()}>
            <span className="icon-[tabler--share] size-5" />
          </button>
        )}
        <button ref={closeButton} type="button" className="btn btn-sm btn-soft ms-1 border-0 bg-white/15 text-white hover:bg-white/25" onClick={onClose}>
          <Trans>Close</Trans>
        </button>
      </div>

      <div data-scroller className="min-h-0 flex-1 overflow-auto overscroll-contain bg-neutral-800 pb-[env(safe-area-inset-bottom)]">
        {failed ? (
          <p className="p-6 text-center text-sm text-white/85"><Trans>Couldn't open this file.</Trans></p>
        ) : !loaded ? (
          <div className="flex h-full items-center justify-center" role="status" aria-label={t`Opening…`}>
            <span className="loading loading-spinner loading-lg text-white/70" />
          </div>
        ) : loaded.kind === "pdf" ? (
          <PdfPages file={loaded.file} find={doc.find} near={doc.near} zoom={ZOOMS[zoom]!} onPages={setPages} onFail={() => setFailed(true)} />
        ) : loaded.kind === "image" ? (
          <div className="p-2" style={{ width: `${ZOOMS[zoom]! * 100}%` }}>
            <img src={loaded.objectUrl} alt={name} className="mx-auto h-auto w-full max-w-none bg-white" />
          </div>
        ) : (
          <p className="p-6 text-center text-sm text-white/85">
            {canShare ? <Trans>This file can't be shown here. Use Share to open it in another app.</Trans> : <Trans>This file can't be shown here.</Trans>}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

function PdfPages(props: { file: File; find?: string; near?: string; zoom: number; onPages: (n: number) => void; onFail: () => void }) {
  const { file, find, zoom } = props;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [aspect, setAspect] = useState(1.294); // Letter, until the first page says
  const [width, setWidth] = useState(0);
  const [matches, setMatches] = useState<PageMatches[] | null>(null);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const holders = useRef(new Map<number, HTMLDivElement>());
  const baseWidths = useRef(new Map<number, number>());

  useEffect(() => {
    let stop = false;
    let task: { destroy: () => Promise<void> } | undefined;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const loading = pdfjs.getDocument({
          data: new Uint8Array(await file.arrayBuffer()),
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
        });
        task = loading;
        const doc = await loading.promise;
        const first = await doc.getPage(1);
        const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = first.view;
        if (stop) return;
        setAspect((y1 - y0) / (x1 - x0) || 1.294);
        setPdf(doc);
        props.onPages(doc.numPages);
        if (find) {
          const found = await findInPdf(doc, find, (m, n) => pdfjs.Util.transform(m, n), props.near);
          if (!stop) setMatches(found);
        }
      } catch {
        if (!stop) props.onFail();
      }
    })();
    return () => {
      stop = true;
      void task?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, find]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageWidth = Math.max(0, (width - 16) * zoom);

  // To the match: its page, with its first mark a third of the way down the screen.
  useEffect(() => {
    const match = matches?.[at];
    const holder = match && holders.current.get(match.page);
    const scroller = box.current?.parentElement;
    if (!match || !holder || !scroller || !pageWidth) return;
    const first = match.marks[0];
    const scale = pageWidth / (baseWidths.current.get(match.page) ?? pageWidth);
    const top = holder.offsetTop + (first ? first.y * scale : 0) - scroller.clientHeight / 3;
    const left = holder.offsetLeft + (first ? first.x * scale : 0) - scroller.clientWidth / 3;
    scroller.scrollTo({ top: Math.max(0, top), left: Math.max(0, zoom > 1 ? left : 0) });
  }, [matches, at, pageWidth, zoom]);

  const marksOf = new Map(matches?.map((m) => [m.page, m.marks]));
  return (
    <div ref={box} className="w-full">
      {find && pdf && (
        <div className="sticky top-0 left-0 z-10 flex w-full items-center gap-2 bg-neutral-900/95 px-3 py-1.5 text-sm text-white/85" role="status">
          {matches === null ? (
            <>
              <span className="loading loading-spinner loading-xs" />
              <span className="min-w-0 flex-1 truncate"><Trans>Finding “{find}”…</Trans></span>
            </>
          ) : matches.length === 0 ? (
            <span className="min-w-0 flex-1 truncate"><Trans>“{find}” isn't in this file's text — it may be a scan.</Trans></span>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate">
                {plural(matches.length, { one: `“${find}” on page ${ph({ page: matches[0]!.page + 1 })}`, other: `“${find}” on # pages` })}
                {matches.length > 1 && <span className="text-white/70"> · {t`page ${ph({ page: matches[at]!.page + 1 })}`}</span>}
              </span>
              {matches.length > 1 && (
                <>
                  <button type="button" className="btn btn-circle btn-xs btn-text text-white hover:bg-white/15" aria-label={t`Previous page with it`} onClick={() => setAt((a) => (a - 1 + matches.length) % matches.length)}>
                    <span className="icon-[tabler--chevron-up] size-4" />
                  </button>
                  <button type="button" className="btn btn-circle btn-xs btn-text text-white hover:bg-white/15" aria-label={t`Next page with it`} onClick={() => setAt((a) => (a + 1) % matches.length)}>
                    <span className="icon-[tabler--chevron-down] size-4" />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {!pdf ? (
        <div className="flex h-64 items-center justify-center" role="status" aria-label={t`Opening…`}>
          <span className="loading loading-spinner loading-lg text-white/70" />
        </div>
      ) : (
        pageWidth > 0 && (
          <div className="flex flex-col items-start gap-2 p-2" style={{ width: pageWidth + 16 }}>
            {Array.from({ length: pdf.numPages }, (_, i) => (
              <PdfPage
                key={i}
                pdf={pdf}
                number={i + 1}
                width={pageWidth}
                aspect={aspect}
                marks={marksOf.get(i)}
                holder={(el) => (el ? holders.current.set(i, el) : holders.current.delete(i))}
                onBaseWidth={(w) => baseWidths.current.set(i, w)}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

/** One page: drawn when it comes near the screen, its canvas let go again when it's far away (iPhones run out). */
function PdfPage(props: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  aspect: number;
  marks?: PageMatches["marks"];
  holder: (el: HTMLDivElement | null) => void;
  onBaseWidth: (w: number) => void;
}) {
  const { pdf, number, width, marks } = props;
  const [near, setNear] = useState(false);
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(Boolean(e?.isIntersecting)), { root: el.closest("[data-scroller]"), rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // A marked page knows its size at once, so the jump to its marks lands right before it's drawn.
  useEffect(() => {
    if (!marks || base) return;
    let stop = false;
    void pdf.getPage(number).then((page) => {
      const v = page.getViewport({ scale: 1 });
      if (stop) return;
      setBase({ w: v.width, h: v.height });
      props.onBaseWidth(v.width);
    });
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, pdf, number]);

  useEffect(() => {
    const c = canvas.current;
    if (!near || !c) return;
    let task: { cancel: () => void } | undefined;
    let stop = false;
    void (async () => {
      const page = await pdf.getPage(number);
      if (stop) return;
      const v = page.getViewport({ scale: 1 });
      setBase({ w: v.width, h: v.height });
      props.onBaseWidth(v.width);
      let scale = (width / v.width) * (window.devicePixelRatio || 1);
      const pixels = v.width * v.height * scale * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const render = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport });
      task = render;
      await render.promise.catch(() => {});
    })();
    return () => {
      stop = true;
      task?.cancel();
      c.width = 0;
      c.height = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, pdf, number, width]);

  const aspect = base ? base.h / base.w : props.aspect;
  const scale = base ? width / base.w : 0;
  return (
    <div
      ref={(el) => {
        holder.current = el;
        props.holder(el);
      }}
      className="relative bg-white shadow"
      style={{ width, height: width * aspect }}
    >
      <canvas ref={canvas} className="block size-full" aria-label={t`Page ${number}`} role="img" />
      {scale > 0 &&
        marks?.map((m, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute rounded-sm bg-yellow-300/45 mix-blend-multiply ring-2 ring-yellow-400/70"
            style={{ left: m.x * scale - 2, top: m.y * scale - 1, width: m.w * scale + 4, height: m.h * scale + 2 }}
          />
        ))}
    </div>
  );
}
