/**
 * The demo's receipts: a till slip as a one-page PDF, made when the sample household is planted (so its date is the
 * thing's purchase date). Made-up stores, marked as a sample. Plain PDF by hand — Courier, the PDF's own font, so it
 * needs nothing embedded and lines up like a real slip.
 */
import type { DemoItem, DemoStore } from "./household";

const PAGE_WIDTH = 252; // 3.5 in, a till roll
const MARGIN = 18;
const SIZE = 8.5;
const LEADING = 11;
const CHAR = SIZE * 0.6; // Courier is 600/1000 wide
const COLUMNS = Math.floor((PAGE_WIDTH - 2 * MARGIN) / CHAR);

export interface ReceiptLine {
  text: string;
  cents: number;
}

export interface Receipt {
  store: DemoStore;
  /** yyyy-mm-dd */
  date: string;
  lines: ReceiptLine[];
  /** Under each line: model, serial… */
  details?: string[];
  number: string;
  card: string;
  taxRate: number;
  footer?: string[];
}

/** Where a receipt's first page, drawn ahead by whoever runs the demo (some runtimes can't draw a PDF), is kept. */
export const receiptSample = (d: Pick<DemoItem, "name">) => `receipts/${d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.thumb.webp`;

/** A receipt's file name, as it shows on the item. */
export const receiptFilename = (r: Pick<Receipt, "store" | "date">) => `Receipt ${r.store.name} ${r.date}.pdf`;

/** What a demo item's receipt says: the thing itself (or the lines given), from its store, on the day it was bought. */
export function receiptFor(d: DemoItem, date: string): Receipt | null {
  if (!d.receipt) return null;
  const { store, lines, extras = [], footer } = d.receipt;
  const label = [d.brand, d.name].filter(Boolean).join(" ");
  return {
    store,
    date,
    lines: lines ?? [{ text: label, cents: d.priceCents ?? 0 }, ...extras],
    details: lines ? undefined : [d.model && `Model ${d.model}`, d.serialNumber && `Serial ${d.serialNumber}`].filter((s): s is string => !!s),
    // The same every time for the same thing, so it reads like a real number.
    number: String(10_000_000 + (hash(d.name) % 89_999_999)),
    card: String(1000 + (hash(store.name) % 8999)),
    taxRate: store.taxRate ?? 0.08845,
    footer,
  };
}

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

function hash(s: string) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Words to lines of at most `width` characters. */
function wrap(text: string, width: number) {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function receiptPdf(r: Receipt): Uint8Array {
  type Row = { text: string; align?: "left" | "center" | "right"; bold?: boolean; size?: number } | { rule: true } | { gap: number };
  const rows: Row[] = [];
  const center = (text: string, opts: { bold?: boolean; size?: number } = {}) => rows.push({ text, align: "center", ...opts });
  const pair = (left: string, right: string, bold = false) => rows.push({ text: left.slice(0, COLUMNS - right.length - 1).padEnd(COLUMNS - right.length) + right, bold });

  center(r.store.name.toUpperCase(), { bold: true, size: 12 });
  rows.push({ gap: 3 });
  for (const line of r.store.address) center(line);
  center(r.store.phone);
  rows.push({ gap: 6 }, { rule: true });
  const [y, m, d] = r.date.split("-");
  pair(`${m}/${d}/${y}  ${r.store.time ?? "2:47 PM"}`, `#${r.number}`);
  rows.push({ rule: true });
  r.lines.forEach((line, i) => {
    const words = wrap(line.text, COLUMNS - 12);
    words.forEach((w, j) => (j === words.length - 1 ? pair(w, money(line.cents)) : rows.push({ text: w })));
    if (i === 0) for (const detail of r.details ?? []) rows.push({ text: `  ${detail}` });
  });
  const subtotal = r.lines.reduce((sum, l) => sum + l.cents, 0);
  const tax = Math.round(subtotal * r.taxRate);
  rows.push({ rule: true });
  pair("Subtotal", money(subtotal));
  pair(`Sales tax ${(r.taxRate * 100).toFixed(3)}%`, money(tax));
  pair("TOTAL", money(subtotal + tax), true);
  rows.push({ gap: 4 });
  pair(`VISA **** ${r.card}`, money(subtotal + tax));
  rows.push({ gap: 2 });
  rows.push({ text: "APPROVED  AUTH 0" + String(hash(r.number) % 100_000).padStart(5, "0") });
  rows.push({ rule: true });
  for (const line of [...(r.footer ?? []), ...(r.store.footer ?? ["Thank you for shopping with us!"])]) for (const w of wrap(line, COLUMNS)) center(w);
  rows.push({ gap: 8 });
  center("Sample receipt - Ferret demo", { size: 6.5 });

  // Top down, then the page as tall as it needs to be.
  let height = MARGIN;
  const placed = rows.map((row) => {
    const at = height;
    height += "rule" in row ? 8 : "gap" in row ? row.gap : (row.size ?? SIZE) + (LEADING - SIZE);
    return { row, at };
  });
  height += MARGIN;
  const ops: string[] = ["0.15 g 0.15 G 0.6 w"];
  for (const { row, at } of placed) {
    if ("gap" in row) continue;
    const baseline = height - at - ("rule" in row ? 4 : (row.size ?? SIZE));
    if ("rule" in row) {
      ops.push(`[1.5 1.5] 0 d ${MARGIN} ${baseline} m ${PAGE_WIDTH - MARGIN} ${baseline} l S [] 0 d`);
      continue;
    }
    const size = row.size ?? SIZE;
    const width = row.text.length * size * 0.6;
    const x = row.align === "center" ? (PAGE_WIDTH - width) / 2 : row.align === "right" ? PAGE_WIDTH - MARGIN - width : MARGIN;
    ops.push(`BT /${row.bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${baseline.toFixed(2)} Td (${pdfText(row.text)}) Tj ET`);
  }
  return pdfDocument(PAGE_WIDTH, Math.ceil(height), ops.join("\n"));
}

/** A string for a PDF text operator: brackets and backslashes escaped, beyond ASCII as WinAnsi (or close to it). */
function pdfText(s: string) {
  const swaps: Record<string, string> = { "—": "-", "–": "-", "″": '"', "′": "'", "×": "x", "’": "'", "“": '"', "”": '"', "é": "\\351" };
  return [...s]
    .map((ch) => swaps[ch] ?? ch)
    .join("")
    .replace(/[\\()]/g, (c) => `\\${c}`)
    .replace(/[^\x20-\x7e\\]/g, "?");
}

function pdfDocument(width: number, height: number, content: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // all ASCII, so offsets are bytes
}
