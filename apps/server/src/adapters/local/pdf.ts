import { createRequire } from "node:module";
import path from "node:path";
import { OPS, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import type { PdfPages } from "../../ports";

/** pdf.js's fonts for the 14 standard PDF fonts (Helvetica, Times…), so text in them draws. */
const STANDARD_FONTS = `${path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;
/** A hostile PDF can be made to take ages: give up after this. */
const TIME_LIMIT_MS = 20_000;
/**
 * And to take memory: a few kilobytes can declare an enormous picture. Pictures larger than this (pixels) are left
 * out of the page, and nothing is drawn onto a canvas larger than this (bytes) — a thumbnail needs neither.
 */
const MAX_IMAGE_PX = 16_000_000;
const MAX_CANVAS_BYTES = 64 * 1024 * 1024;
/** Reading every picture of a long invoice takes longer than a page's text. */
const PICTURES_TIME_LIMIT_MS = 60_000;
/** A picture smaller than this on the page (points) is a mark or an icon, not a product's photo. */
const MIN_PICTURE_PT = 20;
/** The photos kept, at most this many pixels on their longer side. */
const PICTURE_PX = 1600;

type Matrix = [number, number, number, number, number, number];
const times = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/**
 * Reads the text a PDF carries, and draws its first page with pdf.js (Mozilla's renderer, made for untrusted PDFs) onto @napi-rs/canvas. Nothing in
 * the PDF runs: pdf.js 6 has no eval at all, scripting is only in its viewer, and no system fonts are used.
 */
export class PdfJsPages implements PdfPages {
  async firstPage(pdf: Uint8Array, maxSize: number) {
    const task = this.open(pdf);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIME_LIMIT_MS);
    });
    try {
      return await Promise.race([this.draw(task.promise, maxSize), tooSlow]);
    } catch {
      return null; // damaged or password-protected
    } finally {
      clearTimeout(timer);
      await task.destroy().catch(() => {});
    }
  }

  async pageTexts(pdf: Uint8Array, maxPages: number) {
    const task = this.open(pdf);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIME_LIMIT_MS);
    });
    try {
      return await Promise.race([this.read(task.promise, maxPages), tooSlow]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      await task.destroy().catch(() => {});
    }
  }

  async pictures(pdf: Uint8Array, maxPages: number, want: (beside: string) => boolean) {
    const task = this.open(pdf);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooSlow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PICTURES_TIME_LIMIT_MS);
    });
    try {
      return await Promise.race([this.findPictures(task.promise, maxPages, want), tooSlow]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      await task.destroy().catch(() => {});
    }
  }

  private open(pdf: Uint8Array) {
    return getDocument({
      data: pdf.slice(), // pdf.js takes ownership of the buffer
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: STANDARD_FONTS,
      verbosity: 0,
      maxImageSize: MAX_IMAGE_PX,
      canvasMaxAreaInBytes: MAX_CANVAS_BYTES,
    });
  }

  private async read(loading: ReturnType<typeof getDocument>["promise"], maxPages: number) {
    const doc = await loading;
    const pages: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      // Each run of text, and a line break where pdf.js saw one.
      pages.push(content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join("").replace(/[ \t]+\n/g, "\n").trim());
    }
    return pages;
  }

  /**
   * Where each picture is drawn (following the page's transforms to its box), the text on its row, and — for those
   * wanted — its pixels as decoded by pdf.js, made a JPEG.
   */
  private async findPictures(loading: ReturnType<typeof getDocument>["promise"], maxPages: number, want: (beside: string) => boolean) {
    const doc = await loading;
    const out: { page: number; beside: string; image: Uint8Array }[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      const words = (await page.getTextContent()).items.flatMap((t) => ("str" in t && t.str.trim() ? [{ text: t.str, y: (t.transform as number[])[5]! }] : []));
      const saved: Matrix[] = [];
      let m: Matrix = [1, 0, 0, 1, 0, 0];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] as unknown[];
        if (fn === OPS.save) saved.push(m);
        else if (fn === OPS.restore) m = saved.pop() ?? m;
        else if (fn === OPS.transform) m = times(args as Matrix, m);
        else if (fn === OPS.paintImageXObject) {
          // The unit square, where the picture goes, through the current transform.
          const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
          const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
          const height = Math.max(...ys) - Math.min(...ys);
          if (height < MIN_PICTURE_PT || Math.max(...xs) - Math.min(...xs) < MIN_PICTURE_PT) continue;
          const middle = (Math.max(...ys) + Math.min(...ys)) / 2;
          const beside = words.filter((w) => Math.abs(w.y - middle) <= height / 2 + 20).map((w) => w.text).join(" ");
          if (!want(beside)) continue;
          const id = args[0] as string;
          const picture = (page.objs.has(id) ? page.objs.get(id) : page.commonObjs.has(id) ? page.commonObjs.get(id) : null) as { width: number; height: number; kind?: number; data?: Uint8Array } | null;
          // pdf.js's decoded pixels: 2 is RGB, 3 is RGBA (1, one bit a pixel, is a mask, not a photo).
          if (!picture?.data || (picture.kind !== 2 && picture.kind !== 3)) continue;
          const image = await sharp(picture.data, { raw: { width: picture.width, height: picture.height, channels: picture.kind === 3 ? 4 : 3 } })
            .resize(PICTURE_PX, PICTURE_PX, { fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 85 })
            .toBuffer();
          out.push({ page: n, beside, image: new Uint8Array(image) });
        }
      }
      page.cleanup();
    }
    return out;
  }

  private async draw(loading: ReturnType<typeof getDocument>["promise"], maxSize: number) {
    const doc = await loading;
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, maxSize / Math.max(natural.width, natural.height)) });
    // In Node, pdf.js's canvas factory makes @napi-rs/canvas canvases.
    const factory = doc.canvasFactory as { create(w: number, h: number): { canvas: { toBuffer(type: "image/png"): Buffer }; context: unknown } };
    const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    // Paper is white (a PDF page has no background of its own).
    const paint = context as { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void };
    paint.fillStyle = "#ffffff";
    paint.fillRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport, canvas: canvas } as unknown as Parameters<typeof page.render>[0]).promise;
    return new Uint8Array(canvas.toBuffer("image/png"));
  }
}
