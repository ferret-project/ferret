import { createRequire } from "node:module";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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
