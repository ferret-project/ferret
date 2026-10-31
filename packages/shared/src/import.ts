/**
 * Importing things from a spreadsheet (CSV): read the file, guess which column is which (any CSV — with presets for
 * Ferret's own export and Amazon's order history), and turn rows into ImportRows for
 * POST /api/v1/import. Pure and zod-free: the web app does this in the browser so people see the result before
 * anything is saved; the server checks every row again.
 */

/** RFC 4180-ish: quoted fields with "" escapes and line breaks, a BOM, CRLF or LF; `;` or tab if that's what it uses. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  const delimiter = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** What a column can go into. Several columns can go into notes (each as "Header: value"). */
export const IMPORT_FIELDS = {
  name: "Name",
  description: "Description",
  brand: "Brand / maker",
  model: "Model",
  serialNumber: "Serial number",
  barcode: "Barcode",
  quantity: "Quantity",
  condition: "Condition",
  purchaseDate: "Purchase date",
  purchasePrice: "Price paid (each)",
  purchaseTotal: "Price paid (total)",
  value: "Value (each)",
  place: "Where it is",
  category: "Category",
  tags: "Tags",
  notes: "Notes",
  warrantyEnds: "Warranty until",
  soldOn: "Sold on",
  soldPrice: "Sold for",
  link: "Web link",
  asin: "Amazon product (ASIN)",
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;
/** Column index → where it goes (or nothing). */
export type ColumnMapping = (ImportField | null)[];

export type CsvPreset = "ferret" | "amazon" | null;

/** "Purchase Price" → "purchaseprice"; a short dotted prefix some exports put on every column ("XY.name") goes. */
const key = (header: string) =>
  header
    .toLowerCase()
    .replace(/^[a-z]{1,4}\.(field\.)?(?=[a-z])/, "")
    .replace(/[^a-z0-9]/g, "");

/** Header (normalised) → field. Order matters only within a file: the first column claiming a field gets it. */
const SYNONYMS: Record<string, ImportField> = {
  item: "name", name: "name", itemname: "name", productname: "name", product: "name", title: "name",
  description: "description", details: "description",
  brand: "brand", manufacturer: "brand", make: "brand", maker: "brand",
  model: "model", modelnumber: "model", modelno: "model",
  serial: "serialNumber", serialnumber: "serialNumber", serialno: "serialNumber", sn: "serialNumber", itemserialnumber: "serialNumber",
  barcode: "barcode", upc: "barcode", ean: "barcode", gtin: "barcode", isbn: "barcode",
  quantity: "quantity", qty: "quantity", count: "quantity",
  condition: "condition", productcondition: "condition",
  purchasedate: "purchaseDate", purchasetime: "purchaseDate", orderdate: "purchaseDate", dateofpurchase: "purchaseDate", purchased: "purchaseDate", datepurchased: "purchaseDate", bought: "purchaseDate",
  price: "purchasePrice", unitprice: "purchasePrice", pricepaideach: "purchasePrice", purchaseprice: "purchasePrice", pricepaid: "purchasePrice", cost: "purchasePrice",
  total: "purchaseTotal", totalprice: "purchaseTotal", totalowed: "purchaseTotal",
  value: "value", valueeach: "value", currentvalue: "value", replacementvalue: "value", estimatedvalue: "value",
  where: "place", location: "place", room: "place", place: "place",
  category: "category",
  tags: "tags", labels: "tags",
  notes: "notes", comments: "notes",
  warrantyuntil: "warrantyEnds", warrantyexpires: "warrantyEnds", warrantyends: "warrantyEnds", warrantyend: "warrantyEnds",
  soldon: "soldOn", solddate: "soldOn", soldtime: "soldOn",
  soldfor: "soldPrice", soldprice: "soldPrice",
  url: "link", link: "link", productlink: "link", producturl: "link",
  asin: "asin",
};
/** Columns worth keeping in the notes ("Bought from: Costco"). */
const INTO_NOTES = new Set(["orderid", "purchasefrom", "purchasedfrom", "store", "retailer", "seller", "inbox", "soldto", "soldnotes", "warrantydetails", "assetid", "lifetimewarranty"]);

export function detectPreset(headers: string[]): CsvPreset {
  const keys = new Set(headers.map(key));
  if (keys.has("asin") && keys.has("orderid") && keys.has("productname")) return "amazon";
  if (keys.has("item") && keys.has("where") && keys.has("ferretid")) return "ferret";
  return null;
}

export function guessMapping(headers: string[]): ColumnMapping {
  const preset = detectPreset(headers);
  const taken = new Set<ImportField>();
  return headers.map((h) => {
    const k = key(h);
    // Amazon's "Total Owed" includes tax and shipping for the whole line; its unit price is what an adjuster wants.
    if (preset === "amazon" && (k === "totalowed" || k === "shipmentitemsubtotal")) return null;
    // Ferret's own export: its totals are worked out, not entered.
    if (preset === "ferret" && (k === "totalvalue" || k === "ferretid" || k === "photos" || k === "receiptsdocuments")) return null;
    const field = SYNONYMS[k] ?? (INTO_NOTES.has(k) ? "notes" : undefined);
    if (!field) return null;
    if (field !== "notes" && taken.has(field)) return null;
    taken.add(field);
    return field;
  });
}

/** "$1,234.56", "1234.5", "1.234,56 €" → cents; null if it isn't money. */
export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/[^\d.,-]/g, "");
  if (!s || s === "-") return null;
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200 ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** "2024-03-05", "2024-03-05T17:01:02Z", "3/5/2024" (US: month first unless that can't be), "5.3.2024", "Mar 5, 2024" → ISO date. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    // A timestamp with a zone (Amazon's "2024-03-05T02:10:00Z") is a moment: the day it was where you are.
    if (/T\d/.test(s) && /(Z|[+-]\d\d:?\d\d)$/.test(s)) {
      const t = new Date(s);
      if (!Number.isNaN(t.getTime())) return isoDate(t.getFullYear(), t.getMonth() + 1, t.getDate());
    }
    return isoDate(+m[1]!, +m[2]!, +m[3]!);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    const [a, b] = [+m[1]!, +m[2]!];
    return a > 12 ? isoDate(y, b, a) : isoDate(y, a, b);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(s);
  if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  const t = new Date(s);
  return /[a-z]/i.test(s) && !Number.isNaN(t.getTime()) ? isoDate(t.getFullYear(), t.getMonth() + 1, t.getDate()) : null;
}

const CONDITIONS: Record<string, "new" | "excellent" | "good" | "fair" | "poor"> = {
  new: "new", brandnew: "new", unused: "new", excellent: "excellent", likenew: "excellent", mint: "excellent",
  good: "good", used: "good", verygood: "excellent", fair: "fair", acceptable: "fair", worn: "fair", poor: "poor", broken: "poor", damaged: "poor",
};

/** A row ready for the server (the shape of ImportRow in @ferret/shared). */
export interface ImportDraft {
  name: string;
  description?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  barcode?: string;
  quantity?: number;
  condition?: "new" | "excellent" | "good" | "fair" | "poor";
  purchaseDate?: string;
  purchasePriceCents?: number;
  valueCents?: number;
  notes?: string;
  place?: string;
  category?: string;
  tags?: string[];
  links?: { url: string; label?: string | null }[];
  warrantyEnds?: string;
  soldOn?: string;
  soldCents?: number;
}

export interface DraftRow {
  /** Its line in the file (1 = the header). */
  line: number;
  draft: ImportDraft | null;
  /** Why it can't be imported (no name), or what was left out ("couldn't read the date '…'"). */
  problems: string[];
  /** Amazon: a cancelled or returned order line — unticked to start with. */
  unlikely?: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Rows (header first) + where each column goes → drafts, with what couldn't be read. */
export function draftRows(table: string[][], mapping: ColumnMapping): DraftRow[] {
  const [headers = [], ...body] = table;
  const preset = detectPreset(headers);
  const statusCol = preset === "amazon" ? headers.findIndex((h) => key(h) === "orderstatus") : -1;
  return body.map((cells, i) => {
    const problems: string[] = [];
    const d: Partial<ImportDraft> = {};
    const notes: string[] = [];
    let total: number | null = null;
    mapping.forEach((field, col) => {
      const value = (cells[col] ?? "").trim();
      if (!field || !value || /^(n\/?a|none|null|-|not (available|applicable)|unknown)$/i.test(value)) return;
      const header = headers[col] ?? `Column ${col + 1}`;
      const money = () => {
        const c = parseMoney(value);
        if (c == null) problems.push(`Couldn't read ${header} "${clip(value, 30)}"`);
        return c ?? undefined;
      };
      const date = () => {
        const v = parseDate(value);
        if (!v) problems.push(`Couldn't read ${header} "${clip(value, 30)}" as a date`);
        return v ?? undefined;
      };
      switch (field) {
        case "name":
          d.name = clip(value, 200);
          break;
        case "description":
          d.description = clip(value, 5000);
          break;
        case "brand":
        case "model":
        case "serialNumber":
          d[field] = clip(value, 120);
          break;
        case "barcode":
          d.barcode = clip(value.replace(/\s/g, ""), 64);
          break;
        case "quantity": {
          const n = Number.parseInt(value.replace(/[^\d]/g, ""), 10);
          if (Number.isFinite(n)) d.quantity = Math.min(n, 100000);
          else problems.push(`Couldn't read ${header} "${clip(value, 30)}"`);
          break;
        }
        case "condition": {
          const c = CONDITIONS[value.toLowerCase().replace(/[^a-z]/g, "")];
          if (c) d.condition = c;
          else notes.push(`${header}: ${value}`);
          break;
        }
        case "purchaseDate":
          d.purchaseDate = date();
          break;
        case "purchasePrice":
          d.purchasePriceCents = money();
          break;
        case "purchaseTotal":
          total = money() ?? null;
          break;
        case "value":
          d.valueCents = money();
          break;
        case "place":
          d.place = clip(value, 400);
          break;
        case "category":
          d.category = clip(value, 200);
          break;
        case "tags":
          d.tags = [...new Set(value.split(/[;,|]/).map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
          break;
        case "notes":
          notes.push(mapping.filter((f) => f === "notes").length > 1 || INTO_NOTES.has(key(header)) ? `${header}: ${value}` : value);
          break;
        case "warrantyEnds":
          d.warrantyEnds = date();
          break;
        case "soldOn":
          d.soldOn = date();
          break;
        case "soldPrice":
          d.soldCents = money();
          break;
        case "link":
          if (/^https?:\/\/\S+$/i.test(value) && value.length <= 2000) (d.links ??= []).push({ url: value });
          else problems.push(`${header} isn't a web address`);
          break;
        case "asin":
          if (/^[A-Z0-9]{10}$/i.test(value)) (d.links ??= []).push({ url: `https://www.amazon.com/dp/${value.toUpperCase()}`, label: "On Amazon" });
          break;
      }
    });
    if (total != null && d.purchasePriceCents == null) d.purchasePriceCents = Math.round(total / Math.max(1, d.quantity ?? 1));
    if (preset === "amazon") notes.unshift("Bought on Amazon");
    if (notes.length) d.notes = clip(notes.join("\n"), 10000);
    if (d.soldCents != null && !d.soldOn) problems.push("Sold for a price but no date — kept as still yours");
    const unlikely = statusCol >= 0 && /cancel|return/i.test(cells[statusCol] ?? "");
    if (!d.name) return { line: i + 2, draft: null, problems: ["No name"], unlikely };
    return { line: i + 2, draft: d as ImportDraft, problems, unlikely };
  });
}
