/**
 * QR labels. A label's code opens a box, an item or a place: `/l/<code>` is
 * what the QR holds, so the iPhone camera opens Ferret on it. This file has the
 * QR drawing, the print page (Avery sheets, laid out to the inch) and the page
 * a scan lands on (a blank label offers to become a new box).
 */
import type { Label } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { api } from "./lib/api";
import { authClient, useCanEdit } from "./lib/auth";
import { itemHref, placeHref, printLabelsHref } from "./lib/route";
import { HelpLink } from "./HelpLink";
import { navigateTo } from "./lib/navigate";

/** The address a label's QR code holds. */
export const labelUrl = (code: string) => `${window.location.origin}/l/${code}`;

/** A QR code as crisp SVG squares (scales to any print size). */
export function QrCode({ value, className, style }: { value: string; className?: string; style?: React.CSSProperties }) {
  const path = useMemo(() => {
    const { data, size } = encode(value, { ecc: "M", border: 0 });
    let d = "";
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, size };
  }, [value]);
  return (
    <svg viewBox={`-1 -1 ${path.size + 2} ${path.size + 2}`} className={className} style={style} role="img" aria-label={`QR code for ${value}`} shapeRendering="crispEdges">
      <rect x={-1} y={-1} width={path.size + 2} height={path.size + 2} fill="white" />
      <path d={path.d} fill="black" />
    </svg>
  );
}

// ── Printing ────────────────────────────────────────────────────────────────
/**
 * Sheet layouts in inches (US Letter). Avery 5160/5163 margins from their published templates; 22805/22806 measured from
 * the label outlines in Avery's blank PDF templates (U-0430-01, U-0431-01).
 */
const TEMPLATES = {
  "5163": { name: "Avery 5163 — 2″ × 4″, 10 per sheet (boxes)", cols: 2, rows: 5, w: 4, h: 2, left: 0.17, top: 0.5, gapX: 0.16, gapY: 0 },
  "5160": { name: "Avery 5160 — 1″ × 2⅝″, 30 per sheet (shelves, bins)", cols: 3, rows: 10, w: 2.625, h: 1, left: 0.188, top: 0.5, gapX: 0.125, gapY: 0 },
  "22806": { name: "Avery 22806 — 2″ square, 12 per sheet (boxes, bins)", cols: 3, rows: 4, w: 2, h: 2, left: 0.625, top: 0.625, gapX: 0.625, gapY: 0.5826 },
  "22805": { name: "Avery 22805 — 1½″ square, 24 per sheet (jars, small bins)", cols: 4, rows: 6, w: 1.5, h: 1.5, left: 0.7799, top: 0.5, gapX: 0.3132, gapY: 0.2 },
  plain: { name: "Plain paper — 6 per page, cut out and tape on", cols: 2, rows: 3, w: 3.75, h: 3.25, left: 0.5, top: 0.5, gapX: 0.5, gapY: 0.5 },
} as const;
type SheetId = keyof typeof TEMPLATES;

/**
 * Label printers: one label per page, the page the size of the label (mm, as it comes out — long side across). The
 * printer's own driver supplies the paper: pick it in the print dialog. `row`: QR beside the text; else QR above it.
 */
const ROLLS = {
  dk1201: { group: "Brother QL", name: "DK-1201 — 29 × 90 mm (address)", w: 90, h: 29 },
  dk1209: { group: "Brother QL", name: "DK-1209 — 29 × 62 mm (small address)", w: 62, h: 29 },
  dk1208: { group: "Brother QL", name: "DK-1208 — 38 × 90 mm (large address)", w: 90, h: 38 },
  dk11204: { group: "Brother QL", name: "DK-11204 — 17 × 54 mm (multi-purpose)", w: 54, h: 17 },
  dk2205: { group: "Brother QL", name: "DK-2205 — 62 mm continuous (cut at 40 mm)", w: 62, h: 40 },
  dk2210: { group: "Brother QL", name: "DK-2210 — 29 mm continuous (cut at 50 mm)", w: 50, h: 29 },
  dk11221: { group: "Brother QL", name: "DK-11221 — 23 × 23 mm (square)", w: 23, h: 23 },
  dk1202: { group: "Brother QL", name: "DK-1202 — 62 × 100 mm (shipping)", w: 100, h: 62 },
  tze24: { group: "Brother P-touch", name: "TZe 24 mm tape (60 mm long)", w: 60, h: 24 },
  tze18: { group: "Brother P-touch", name: "TZe 18 mm tape (50 mm long)", w: 50, h: 18 },
  tze12: { group: "Brother P-touch", name: "TZe 12 mm tape (40 mm long)", w: 40, h: 12 },
  dymo30252: { group: "Dymo LabelWriter", name: "30252 — 1⅛″ × 3½″ (address)", w: 89, h: 28 },
  dymo30336: { group: "Dymo LabelWriter", name: "30336 — 1″ × 2⅛″ (multi-purpose)", w: 54, h: 25 },
  dymo30334: { group: "Dymo LabelWriter", name: "30334 — 2¼″ × 1¼″ (multi-purpose)", w: 57, h: 32 },
  dymo30332: { group: "Dymo LabelWriter", name: "30332 — 1″ × 1″ (square)", w: 25, h: 25 },
  dymo30330: { group: "Dymo LabelWriter", name: "30330 — ¾″ × 2″ (return address)", w: 51, h: 19 },
  dymo30256: { group: "Dymo LabelWriter", name: "30256 — 2⁵⁄₁₆″ × 4″ (shipping)", w: 102, h: 59 },
  dymo1744907: { group: "Dymo LabelWriter", name: "1744907 — 4″ × 6″ (5XL shipping)", w: 102, h: 152 },
  thermal2x1: { group: "Other thermal printers", name: "2″ × 1″", w: 51, h: 25 },
  thermal15x1: { group: "Other thermal printers", name: "1½″ × 1″", w: 38, h: 25 },
  thermal225x125: { group: "Other thermal printers", name: "2¼″ × 1¼″", w: 57, h: 32 },
  thermal4x6: { group: "Other thermal printers", name: "4″ × 6″ (shipping)", w: 102, h: 152 },
} as const;
type RollId = keyof typeof ROLLS;
type TemplateId = SheetId | RollId;
const isRoll = (id: TemplateId): id is RollId => id in ROLLS;

/**
 * The print page's margins and size, as fixed strings: the CSP allows each inline style by its hash (server: app.ts
 * LABEL_PAGE_STYLE_HASHES — test/hardening.test.ts checks them). Landscape for long labels, so the driver's label
 * paper is used across; as it comes for square and tall ones.
 */
export const PAGE_STYLES = {
  sheet: "@page { size: letter; margin: 0; }",
  landscape: "@page { size: landscape; margin: 0; }",
  roll: "@page { margin: 0; }",
} as const;

/** How much to shrink the on-screen preview so a letter sheet fits the window. */
function usePreviewScale() {
  const fit = () => Math.min(1, (window.innerWidth - 32) / (8.5 * 96));
  const [scale, setScale] = useState(fit);
  useEffect(() => {
    const onResize = () => setScale(fit());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return scale;
}

const NUDGE_KEY = "ferret.labelNudge";
function useNudge() {
  const [nudge, setNudge] = useState<{ x: number; y: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(NUDGE_KEY) ?? "") as { x: number; y: number };
    } catch {
      return { x: 0, y: 0 };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(NUDGE_KEY, JSON.stringify(nudge));
    } catch {
      /* private mode: just this visit */
    }
  }, [nudge]);
  return [nudge, setNudge] as const;
}

/** #/labels — print labels: these codes, or new blank ones to stick on while packing. */
export function PrintLabels({ householdName, householdId, codes }: { householdName: string; householdId: string; codes: string[] }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const [template, setTemplate] = useState<TemplateId>(() => {
    try {
      const saved = localStorage.getItem("ferret.labelTemplate") as TemplateId | null;
      return saved && (saved in TEMPLATES || saved in ROLLS) ? saved : "5163";
    } catch {
      return "5163";
    }
  });
  const [nudge, setNudge] = useNudge();
  const [skip, setSkip] = useState(0); // labels already used on a part-used sheet
  const [count, setCount] = useState(10);
  const all = useQuery({ queryKey: ["labels", householdId], queryFn: () => api.labels() });
  const make = useMutation({
    mutationFn: () => api.blankLabels(count),
    onSuccess: async ({ codes: made }) => {
      await qc.invalidateQueries({ queryKey: ["labels", householdId] });
      navigateTo(printLabelsHref(made));
    },
  });
  const byCode = new Map((all.data?.data ?? []).map((l) => [l.code, l]));
  const labels = codes.map((c) => byCode.get(c) ?? { code: c, householdId, item: null, location: null });
  const roll = isRoll(template) ? ROLLS[template] : null;
  const t = isRoll(template) ? TEMPLATES["5163"] : TEMPLATES[template];
  const perSheet = roll ? 1 : t.cols * t.rows;
  const slots: (Label | null)[] = [...Array(skip).fill(null), ...labels];
  const preview = usePreviewScale();
  const sheets = Array.from({ length: Math.max(1, Math.ceil(slots.length / perSheet)) }, (_, i) => slots.slice(i * perSheet, (i + 1) * perSheet));

  return (
    <div className="min-h-dvh bg-base-200 print:bg-white">
      {/* The sheet is laid out to the edge of the paper: no browser margins while this page is open. */}
      <style>{roll ? (roll.w > roll.h ? PAGE_STYLES.landscape : PAGE_STYLES.roll) : PAGE_STYLES.sheet}</style>
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4 print:hidden">
        <div className="navbar-start items-center gap-2">
          <a
            href="#/"
            className="btn btn-text btn-sm btn-square"
            aria-label="Back"
            onClick={(e) => {
              if (window.history.length > 1) {
                e.preventDefault();
                window.history.back();
              }
            }}
          >
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold">Print labels</h1>
          <HelpLink page="guide/labels.html" label="QR labels" />
        </div>
        <div className="navbar-end items-center">
          {labels.length > 0 && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>
              <span className="icon-[tabler--printer] size-4" />
              Print
            </button>
          )}
        </div>
      </nav>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] print:hidden">
        <section className="card">
          <div className="card-body gap-4 p-4 sm:p-6">
            <div>
              <label className="label-text" htmlFor="label-template">
                Labels
              </label>
              <select
                id="label-template"
                className="select"
                value={template}
                onChange={(e) => {
                  setTemplate(e.target.value as TemplateId);
                  try {
                    localStorage.setItem("ferret.labelTemplate", e.target.value);
                  } catch {
                    /* fine */
                  }
                }}
              >
                <optgroup label="Sheets (any printer)">
                  {(Object.keys(TEMPLATES) as SheetId[]).map((id) => (
                    <option key={id} value={id}>
                      {TEMPLATES[id].name}
                    </option>
                  ))}
                </optgroup>
                {[...new Set(Object.values(ROLLS).map((x) => x.group))].map((group) => (
                  <optgroup key={group} label={`${group} (label printer)`}>
                    {(Object.keys(ROLLS) as RollId[])
                      .filter((id) => ROLLS[id].group === group)
                      .map((id) => (
                        <option key={id} value={id}>
                          {ROLLS[id].name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {codes.length === 0 ? (
              canEdit ? (
                <div className="space-y-2">
                  <p className="text-sm text-base-content/70">
                    Blank labels to stick on boxes as you pack. Scan one later and say what it is — a new box, or something already in
                    Ferret.
                  </p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="label-text" htmlFor="label-count">
                        How many
                      </label>
                      <input
                        id="label-count"
                        type="number"
                        min={1}
                        max={300}
                        className="input w-28"
                        value={count}
                        onChange={(e) => setCount(Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
                      />
                    </div>
                    <button type="button" className="btn btn-wrap btn-primary" disabled={make.isPending} onClick={() => make.mutate()}>
                      {make.isPending && <span className="loading loading-spinner loading-sm" />}
                      Make {count} blank {count === 1 ? "label" : "labels"}
                    </button>
                  </div>
                  {!roll && <p className="text-xs text-base-content/70">Tip: a full sheet of 5163 is 10, of 5160 is 30, of 22806 is 12, of 22805 is 24.</p>}
                  {make.isError && <div className="alert alert-soft alert-error">{make.error.message}</div>}
                </div>
              ) : (
                <p className="text-sm text-base-content/70">Open a box or place to print its label.</p>
              )
            ) : (
              <p className="text-sm text-base-content/70">
                {labels.length} {labels.length === 1 ? "label" : "labels"}
                {roll ? "" : ` on ${sheets.length} ${sheets.length === 1 ? "sheet" : "sheets"}`}.
              </p>
            )}

            {!roll && labels.length > 0 && (
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <span className="icon-[tabler--layout-grid] size-4 text-base-content/70" />
                A part-used sheet? Skip the first
                <input
                  type="number"
                  min={0}
                  max={perSheet - 1}
                  className="input input-sm w-20"
                  value={skip}
                  onChange={(e) => setSkip(Math.max(0, Math.min(perSheet - 1, Number(e.target.value) || 0)))}
                />
                {skip === 1 ? "label" : "labels"}
              </label>
            )}

            {roll ? (
              <div className="rounded-box bg-base-200 p-3 text-sm">
                <p className="font-medium">In the print dialog:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-base-content/80">
                  <li>Choose your label printer, and its paper: {roll.name.replace(/ \(.*\)$/, "")}.</li>
                  <li>Scale 100% (not "Fit"), margins None, no headers or footers.</li>
                  {roll.w > roll.h && <li>If it comes out sideways, switch Landscape / Portrait.</li>}
                </ul>
                <p className="mt-2 text-base-content/70">Each label prints on its own label. The printer needs its driver installed on this computer.</p>
              </div>
            ) : (
            <details className="text-sm">
              <summary className="cursor-pointer text-base-content/70">Printing tips and alignment</summary>
              <div className="mt-3 space-y-3">
                <p className="text-base-content/70">
                  Print at <strong>100% / Actual size</strong> (not "Fit to page"), with no headers or footers. Try a plain page first and hold
                  it against a label sheet to the light. If it's off, nudge it:
                </p>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2">
                    Right
                    <input type="number" step={0.5} className="input input-sm w-20" value={nudge.x} onChange={(e) => setNudge({ ...nudge, x: Number(e.target.value) || 0 })} />
                    mm
                  </label>
                  <label className="flex items-center gap-2">
                    Down
                    <input type="number" step={0.5} className="input input-sm w-20" value={nudge.y} onChange={(e) => setNudge({ ...nudge, y: Number(e.target.value) || 0 })} />
                    mm
                  </label>
                </div>
              </div>
            </details>
            )}
          </div>
        </section>
        {labels.length > 0 && <p className="text-center text-sm text-base-content/70">Preview:</p>}
      </main>

      {labels.length > 0 && roll && (
        // A label printer: one label per page, each the size of the label (on screen: a row of them, actual size).
        <div className="flex flex-wrap justify-center gap-4 px-4 pb-8 print:block print:p-0">
          {labels.map((l) => (
            <div key={l.code} className="break-after-page bg-white shadow-md print:shadow-none" style={{ width: `${roll.w}mm`, height: `${roll.h}mm` }}>
              <RollLabel label={l} w={roll.w} h={roll.h} householdName={householdName} />
            </div>
          ))}
        </div>
      )}

      {labels.length > 0 && !roll && (
        <div className="flex flex-col items-center gap-6 pb-8 print:block print:gap-0 print:p-0">
          {sheets.map((sheet, i) => (
            // On screen, the sheet is scaled to fit; printed, it's exactly letter size.
            <div
              key={i}
              className="relative overflow-hidden shadow-lg print:static print:h-auto! print:w-auto! print:overflow-visible print:shadow-none"
              style={{ width: `${8.5 * preview}in`, height: `${11 * preview}in` }}
            >
              <div className="origin-top-left scale-(--preview) print:scale-100" style={{ "--preview": preview } as React.CSSProperties}>
                <div
                  className="label-sheet relative bg-white"
                  style={{ width: "8.5in", height: "11in", transform: `translate(${nudge.x}mm, ${nudge.y}mm)` }}
                >
                  {sheet.map((l, j) =>
                    l ? (
                      <LabelCell
                        key={l.code}
                        label={l}
                        template={template as SheetId}
                        householdName={householdName}
                        style={{
                          left: `${t.left + (j % t.cols) * (t.w + t.gapX)}in`,
                          top: `${t.top + Math.floor(j / t.cols) * (t.h + t.gapY)}in`,
                          width: `${t.w}in`,
                          height: `${t.h}in`,
                        }}
                      />
                    ) : (
                      // A spot already used on a part-used sheet: outlined on screen, nothing printed.
                      <div
                        key={`skip-${j}`}
                        aria-hidden
                        className="absolute rounded-sm border border-dashed border-gray-300 bg-gray-100 print:hidden"
                        style={{
                          left: `${t.left + (j % t.cols) * (t.w + t.gapX)}in`,
                          top: `${t.top + Math.floor(j / t.cols) * (t.h + t.gapY)}in`,
                          width: `${t.w}in`,
                          height: `${t.h}in`,
                        }}
                      />
                    ),
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One label: QR on the left, the code big (to read or type), what it's on. Square labels: the QR above them. */
function LabelCell({ label, template, householdName, style }: { label: Label; template: SheetId; householdName: string; style: React.CSSProperties }) {
  const name = label.item?.name ?? label.location?.path ?? "";
  if (template === "22805" || template === "22806") {
    const big = template === "22806";
    return (
      <div className={`absolute flex flex-col items-center justify-center overflow-hidden text-center text-black ${big ? "gap-[0.05in] p-[0.12in]" : "gap-[0.03in] p-[0.1in]"}`} style={style}>
        <QrCode value={labelUrl(label.code)} className={big ? "h-[1.3in] w-[1.3in] shrink-0" : "h-[0.95in] w-[0.95in] shrink-0"} />
        <div className="w-full min-w-0 leading-tight">
          <div className={`font-mono font-bold tracking-wider ${big ? "text-[15pt]" : "text-[11pt]"}`}>{label.code}</div>
          {name && <div className={`truncate font-semibold ${big ? "text-[8pt]" : "text-[6.5pt]"}`}>{name}</div>}
        </div>
      </div>
    );
  }
  const small = template === "5160";
  return (
    <div
      className={`absolute flex items-center overflow-hidden text-black ${small ? "gap-[0.08in] p-[0.06in]" : "gap-[0.15in] p-[0.15in]"} ${template === "plain" ? "flex-col justify-center border border-dashed border-gray-400 text-center" : ""}`}
      style={style}
    >
      <QrCode value={labelUrl(label.code)} className={small ? "h-[0.85in] w-[0.85in] shrink-0" : template === "plain" ? "h-[2in] w-[2in]" : "h-[1.65in] w-[1.65in] shrink-0"} />
      <div className="min-w-0 leading-tight">
        <div className={`font-mono font-bold tracking-wider ${small ? "text-[13pt]" : "text-[22pt]"}`}>{label.code}</div>
        {name && <div className={`line-clamp-2 font-semibold ${small ? "text-[7.5pt]" : "text-[12pt]"}`}>{name}</div>}
        {!small && <div className="mt-1 text-[8pt] text-gray-600">🐾 Ferret · {householdName}</div>}
      </div>
    </div>
  );
}

/**
 * One label on a label printer's roll, sized in mm: long ones put the QR beside the code and what it's on; square and
 * tall ones put it above. Text sizes follow the label's height, so a 12 mm tape and a 4″ × 6″ both read.
 */
function RollLabel({ label, w, h, householdName }: { label: Label; w: number; h: number; householdName: string }) {
  const name = label.item?.name ?? label.location?.path ?? "";
  const pad = Math.max(1, Math.min(w, h) * 0.07);
  const row = w / h >= 1.6;
  const qr = row ? h - 2 * pad : Math.min(w - 2 * pad, h - 2 * pad - Math.min(w, h) * 0.3);
  const code = row ? Math.min(h * 0.32, (w - qr - 3 * pad) / 4.2) : Math.min(w, h) * 0.16;
  const small = Math.max(1.6, code * 0.48);
  return (
    <div
      className={`flex h-full w-full overflow-hidden text-black ${row ? "flex-row items-center" : "flex-col items-center justify-center text-center"}`}
      style={{ padding: `${pad}mm`, gap: `${pad}mm` }}
    >
      <QrCode value={labelUrl(label.code)} className="shrink-0" style={{ width: `${qr}mm`, height: `${qr}mm` }} />
      <div className="min-w-0 leading-tight">
        <div className="font-mono font-bold tracking-wider" style={{ fontSize: `${code}mm` }}>
          {label.code}
        </div>
        {name && h >= 17 && (
          <div className="line-clamp-2 font-semibold" style={{ fontSize: `${small}mm` }}>
            {name}
          </div>
        )}
        {h >= 50 && <div className="mt-1 text-gray-600" style={{ fontSize: `${small * 0.8}mm` }}>🐾 Ferret · {householdName}</div>}
      </div>
    </div>
  );
}

// ── Scanning ────────────────────────────────────────────────────────────────
/** #/l/:code — where a scanned label lands: its box, item or place; a blank one asks what it's for. */
export function LabelLanding({ code, householdId }: { code: string; householdId: string }) {
  const qc = useQueryClient();
  const label = useQuery({ queryKey: ["label", code], queryFn: () => api.label(code), retry: false });
  const canEdit = useCanEdit(householdId);
  const [mode, setMode] = useState<"box" | "item" | "place" | null>(null);
  const [item, setItem] = useState<Choice | null>(null);
  const [place, setPlace] = useState<string | null>(null);

  // A label from another of your households: switch to it first.
  const elsewhere = label.data && label.data.householdId !== householdId;
  useEffect(() => {
    if (elsewhere) void authClient.organization.setActive({ organizationId: label.data!.householdId });
  }, [elsewhere, label.data]);

  // Already on something: go there (replacing this page, so Back returns to the camera).
  useEffect(() => {
    if (!label.data || elsewhere) return;
    if (label.data.item) navigateTo(itemHref(label.data.item.id), { replace: true });
    else if (label.data.location) navigateTo(placeHref(label.data.location.id), { replace: true });
  }, [label.data, elsewhere]);

  const attach = useMutation({
    mutationFn: async () => {
      if (mode === "box") {
        const name = (document.getElementById("new-box-name") as HTMLInputElement).value.trim() || `Box ${code}`;
        const box = await api.createItem({ name, isContainer: true, locationId: place, origin: "label" });
        return api.assignLabel(code, { itemId: box.id });
      }
      if (mode === "item" && item) return api.assignLabel(code, { itemId: item.id });
      if (mode === "place" && place) return api.assignLabel(code, { locationId: place });
      throw new Error("Choose what it's on first");
    },
    onSuccess: (l) => {
      void qc.invalidateQueries({ queryKey: ["items", householdId] });
      void qc.invalidateQueries({ queryKey: ["labels", householdId] });
      if (l.item) navigateTo(itemHref(l.item.id), { replace: true });
      else if (l.location) navigateTo(placeHref(l.location.id), { replace: true });
    },
  });

  if (label.isError) {
    return (
      <Centered icon="icon-[tabler--qrcode-off]" title={`Label ${code}`}>
        <p className="text-sm text-base-content/70">This label isn't one of yours — or the code was misread. Try scanning again.</p>
      </Centered>
    );
  }
  if (!label.data || label.data.item || label.data.location || elsewhere) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }
  return (
    <Centered icon="icon-[tabler--qrcode]" title={`New label ${code}`}>
      {!canEdit ? (
        <p className="text-sm text-base-content/70">This label isn't on anything yet.</p>
      ) : (
        <div className="flex w-full flex-col gap-3 text-start">
          <p className="text-center text-sm text-base-content/70">What did you stick it on?</p>
          {/* FlyonUI's radio buttons in a join: the checked one fills in. */}
          <div className="join w-full" role="radiogroup" aria-label="What it's on">
            {(
              [
                ["box", "A new box"],
                ["item", "Something in Ferret"],
                ["place", "A shelf or place"],
              ] as const
            ).map(([m, text]) => (
              <input
                key={m}
                type="radio"
                name="label-mode"
                aria-label={text}
                className="join-item btn btn-soft btn-primary btn-sm h-auto min-h-9 flex-1 py-1"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
            ))}
          </div>
          {mode === "box" && (
            <>
              <div>
                <label className="label-text" htmlFor="new-box-name">
                  Box name
                </label>
                <input id="new-box-name" className="input" placeholder={`e.g. Kitchen — plates (or leave as "Box ${code}")`} autoFocus />
              </div>
              <PlacePicker householdId={householdId} id="new-box-place" name="locationId" label="Where it is" value={place} onChange={setPlace} noneLabel="Not decided yet" />
            </>
          )}
          {mode === "item" && (
            <ItemPicker householdId={householdId} id="label-item" name="itemId" label="Which one" value={item} onChange={setItem} />
          )}
          {mode === "place" && (
            <PlacePicker householdId={householdId} id="label-place" name="locationId" label="Which place" value={place} onChange={setPlace} noneLabel="Choose a place" />
          )}
          {attach.isError && <div className="alert alert-soft alert-error text-sm">{attach.error.message}</div>}
          {mode && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={attach.isPending || (mode === "item" && !item) || (mode === "place" && !place)}
              onClick={() => attach.mutate()}
            >
              {attach.isPending && <span className="loading loading-spinner loading-sm" />}
              {mode === "box" ? "Make the box" : "Put the label on it"}
            </button>
          )}
        </div>
      )}
    </Centered>
  );
}

function Centered({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-base-200 p-4">
      <div className="card w-full max-w-sm">
        <div className="card-body items-center gap-3 text-center">
          <span className={`${icon} size-10 text-primary`} />
          <h1 className="font-mono text-lg font-semibold">{title}</h1>
          {children}
          <a href="#/" className="btn btn-text btn-sm">
            Back to Ferret
          </a>
        </div>
      </div>
    </main>
  );
}
