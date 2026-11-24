/**
 * A thing's sheet as a PDF the server draws itself (GET /items/:id/sheet.pdf, and inside its signed ZIP) — signed
 * with the household's key, so the PDF alone can be checked: `ferret verify <file>.pdf` (the ferret CLI).
 *
 * The signature is an OpenSSH one (lib/signing.ts) over every byte of the PDF before it, appended after the PDF's end
 * as PDF comment lines, which PDF readers skip:
 *
 *   …%%EOF
 *   %FERRET-SIGNATURE
 *   %-----BEGIN SSH SIGNATURE-----
 *   %U1NIU0lH…
 *   %-----END SSH SIGNATURE-----
 *   %END-FERRET-SIGNATURE
 *
 * It's well inside the last 1024 bytes readers look for %%EOF in. Drawn with pdf-lib (pure JavaScript, so it runs
 * wherever Ferret does) in Noto Sans (lib/fonts), so every language Ferret's translated into writes properly. Photos
 * go in as JPEG or PNG — the photo's JPEG preview copy, else the original, else its thumbnail; one in neither shape
 * is named instead.
 */
import fontkit from "@pdf-lib/fontkit";
import type { ItemSheet } from "@ferret/shared";
import { type PDFFont, type PDFImage, type PDFPage, PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { NOTO_SANS_BOLD, NOTO_SANS_REGULAR } from "./fonts/noto-sans";
import type { Tr } from "./language";

export const PDF_SIGNATURE_START = "\n%FERRET-SIGNATURE\n";
const PDF_SIGNATURE_END = "%END-FERRET-SIGNATURE\n";

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const BRAND = rgb(0.54, 0.3, 0.18);
const INK = rgb(0, 0, 0);
const SOFT = rgb(0.33, 0.33, 0.36);
const RULE = rgb(0.85, 0.85, 0.85);
const MARGIN = 50;

/** A photo to draw: its bytes in a shape PDF takes, or none (then it's named). */
export interface SheetPhoto {
  id: string;
  filename: string;
  bytes: Uint8Array | null;
  type: "jpeg" | "png" | null;
}

/** US and Canadian households print on Letter; everyone else on A4. */
const pageSize = (currency: string): [number, number] => (currency === "USD" || currency === "CAD" ? [612, 792] : [595.28, 841.89]);

/** The sheet as an unsigned PDF. */
export async function sheetPdf(tr: Tr, sheet: ItemSheet, photos: SheetPhoto[], opts: { currency: string; madeOn: string; fingerprint: string; publicKey: string; madeAt: Date }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fromB64(NOTO_SANS_REGULAR), { subset: true });
  const bold = await doc.embedFont(fromB64(NOTO_SANS_BOLD), { subset: true });
  const mono = await doc.embedFont(StandardFonts.Courier);
  doc.setTitle(sheet.name);
  doc.setSubject(tr("Everything about {name}, from Ferret", { name: sheet.name }));
  doc.setCreator("Ferret");
  doc.setProducer("Ferret");
  doc.setCreationDate(opts.madeAt);
  doc.setModificationDate(opts.madeAt);

  const [width, height] = pageSize(opts.currency);
  const contentWidth = width - 2 * MARGIN;
  let page: PDFPage = doc.addPage([width, height]);
  let y = height - MARGIN;
  const pages: PDFPage[] = [page];
  const newPage = () => {
    page = doc.addPage([width, height]);
    pages.push(page);
    y = height - MARGIN;
  };
  /** Room for `h` more points on this page, or a new one. */
  const need = (h: number) => {
    if (y - h < MARGIN + 20) newPage();
  };

  /** Words broken into lines that fit `max` points (long words broken too). */
  const wrap = (text: string, font: PDFFont, size: number, max: number) => {
    const lines: string[] = [];
    for (const para of text.split(/\r?\n/)) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const tryLine = line + word;
        if (font.widthOfTextAtSize(tryLine, size) <= max) {
          line = tryLine;
          continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = word.trimStart();
        while (font.widthOfTextAtSize(line, size) > max) {
          let cut = line.length;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > max) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  };
  const write = (text: string, o: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; x?: number; max?: number; gap?: number } = {}) => {
    const font = o.font ?? regular;
    const size = o.size ?? 10;
    const lineHeight = size * 1.35;
    for (const line of wrap(text, font, size, o.max ?? contentWidth - (o.x ?? 0))) {
      need(lineHeight);
      y -= lineHeight;
      page.drawText(line, { x: MARGIN + (o.x ?? 0), y: y + size * 0.3, size, font, color: o.color ?? INK });
    }
    y -= o.gap ?? 0;
  };

  /** Ferret's paw (the app icon's ellipses), `s` points per unit, its top-left at (x, top). */
  const paw = (x: number, top: number, s: number) => {
    const at = (cx: number, cy: number) => ({ x: x + (cx - 8) * s, y: top - (cy - 9) * s });
    const toes: [number, number, number, number, number][] = [
      [32, 42.5, 12.5, 10, 0],
      [16.5, 29.5, 4.6, 6.2, -22],
      [26, 19.5, 5, 6.6, -8],
      [38, 19.5, 5, 6.6, 8],
      [47.5, 29.5, 4.6, 6.2, 22],
    ];
    for (const [cx, cy, rx, ry, deg] of toes) page.drawEllipse({ ...at(cx, cy), xScale: rx * s, yScale: ry * s, rotate: { type: "degrees", angle: -deg } as never, color: BRAND });
  };

  // Header: its name, and Ferret's mark on the right.
  const markText = tr("Ferret");
  const markWidth = bold.widthOfTextAtSize(markText, 14) + 22;
  paw(width - MARGIN - markWidth, y, 0.36);
  page.drawText(markText, { x: width - MARGIN - markWidth + 22, y: y - 14, size: 14, font: bold, color: BRAND });
  write(sheet.name, { font: bold, size: 20, max: contentWidth - markWidth - 10, gap: 2 });
  if (sheet.subtitle.length) write(sheet.subtitle.join(" · "), { color: SOFT, size: 11 });
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 0.7, color: RULE });
  y -= 10;

  // Photos, three across.
  const embedded: { image: PDFImage | null; photo: SheetPhoto }[] = [];
  for (const p of photos) {
    let image: PDFImage | null = null;
    try {
      if (p.bytes && p.type === "jpeg") image = await doc.embedJpg(p.bytes);
      else if (p.bytes && p.type === "png") image = await doc.embedPng(p.bytes);
    } catch {
      image = null; // not readable as it said: named instead
    }
    embedded.push({ image, photo: p });
  }
  const shown = embedded.filter((e) => e.image);
  if (shown.length) {
    const gap = 10;
    const cell = (contentWidth - 2 * gap) / 3;
    const cellH = cell * 0.75;
    for (let i = 0; i < shown.length; i += 3) {
      need(cellH + gap);
      y -= cellH;
      shown.slice(i, i + 3).forEach(({ image }, j) => {
        const scale = Math.min(cell / image!.width, cellH / image!.height);
        const w = image!.width * scale;
        const h = image!.height * scale;
        page.drawImage(image!, { x: MARGIN + j * (cell + gap) + (cell - w) / 2, y: y + (cellH - h) / 2, width: w, height: h });
      });
      y -= gap;
    }
  }
  const unshown = embedded.filter((e) => !e.image);
  if (unshown.length) write(tr("Photos not shown here: {files}", { files: unshown.map((e) => e.photo.filename).join(", ") }), { color: SOFT, size: 9, gap: 4 });

  const heading = (title: string) => {
    need(40);
    y -= 12;
    write(title, { font: bold, size: 13 });
    y -= 3;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 0.5, color: RULE });
    y -= 4;
  };
  const fields = (rows: [string, string][], size = 10) => {
    const lh = size * 1.35;
    const labelWidth = Math.min(150, Math.max(...rows.map(([l]) => regular.widthOfTextAtSize(l, size))) + 14);
    for (const [label, value] of rows) {
      wrap(value, regular, size, contentWidth - labelWidth).forEach((line, i) => {
        need(lh);
        y -= lh;
        // The label beside the value's first line — on the same page as it.
        if (i === 0) page.drawText(wrap(label, regular, size, labelWidth - 8)[0] ?? "", { x: MARGIN, y: y + size * 0.3, size, font: regular, color: SOFT });
        page.drawText(line, { x: MARGIN + labelWidth, y: y + size * 0.3, size, font: regular, color: INK });
      });
    }
  };
  const bullets = (lines: string[], x = 0) => {
    for (const line of lines) {
      const wrapped = wrap(line, regular, 10, contentWidth - x - 12);
      wrapped.forEach((l, i) => {
        need(13.5);
        y -= 13.5;
        if (i === 0) page.drawText("•", { x: MARGIN + x, y: y + 3, size: 10, font: regular, color: INK });
        page.drawText(l, { x: MARGIN + x + 12, y: y + 3, size: 10, font: regular, color: INK });
      });
    }
  };

  for (const sec of sheet.sections) {
    heading(sec.title);
    if (sec.rows?.length) fields(sec.rows);
    if (sec.text) write(sec.text, { gap: 2 });
    if (sec.links?.length) bullets(sec.links.map((l) => (l.label === l.url ? l.url : `${l.label} — ${l.url}`)));
    for (const e of sec.entries ?? []) {
      need(30);
      y -= 6;
      write(e.title, { font: bold, size: 11 });
      if (e.rows.length) fields(e.rows);
      if (e.text) write(e.text);
      if (e.lines?.length) bullets(e.lines);
    }
    if (sec.lines?.length) bullets(sec.lines);
  }
  if (sheet.documents.length) {
    heading(tr("Documents"));
    bullets(sheet.documents.map((d) => d.filename));
  }

  // Where it came from, and the key it's signed with.
  need(70);
  y -= 16;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: width - MARGIN, y }, thickness: 0.7, color: RULE });
  y -= 4;
  write(tr("From Ferret, {date}: {url}", { date: opts.madeOn, url: sheet.url }), { size: 9, color: SOFT });
  write(tr("Signed with the household's key {fingerprint} — check it with: ferret verify <this file>", { fingerprint: opts.fingerprint }), { size: 9, color: SOFT });
  write(opts.publicKey, { font: mono, size: 7, color: SOFT });

  // Page numbers.
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    p.drawText(label, { x: width - MARGIN - regular.widthOfTextAtSize(label, 8), y: MARGIN - 20, size: 8, font: regular, color: SOFT });
  });
  return doc.save({ useObjectStreams: true });
}

/** Appends the signature block (see the top of this file) to a finished PDF. */
export function withSignature(pdf: Uint8Array, armoured: string) {
  const block = `${PDF_SIGNATURE_START}${armoured
    .trim()
    .split("\n")
    .map((l) => `%${l}`)
    .join("\n")}\n${PDF_SIGNATURE_END}`;
  const tail = new TextEncoder().encode(block);
  const out = new Uint8Array(pdf.length + tail.length);
  out.set(pdf);
  out.set(tail, pdf.length);
  return out;
}

/** A signed PDF split back into the PDF and its armoured signature (null when it has none). */
export function splitSignedPdf(bytes: Uint8Array): { pdf: Uint8Array; signature: string } | null {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const at = tail.lastIndexOf(PDF_SIGNATURE_START);
  if (at < 0 || !tail.endsWith(PDF_SIGNATURE_END)) return null;
  const cut = bytes.length - (tail.length - at);
  const block = tail.slice(at + PDF_SIGNATURE_START.length, tail.length - PDF_SIGNATURE_END.length);
  return { pdf: bytes.subarray(0, cut), signature: `${block.split("\n").filter(Boolean).map((l) => l.replace(/^%/, "")).join("\n")}\n` };
}
