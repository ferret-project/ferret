/**
 * Import a spreadsheet: pick a CSV, check which column goes where (guessed — @ferret/shared's guessMapping, with
 * presets for Ferret's own export and Amazon order history), untick what you don't want, import. The file
 * is read here, in the browser; only the rows you tick are sent.
 */
import { Steps } from "./Steps";
import { type ColumnMapping, type DraftRow, detectPreset, draftRows, guessMapping, IMPORT_FIELDS, type ImportField, parseCsv } from "@ferret/shared/utils";
import { useMemo, useState } from "react";
import { ImportStatus, useImportRun } from "./Import";
import { usePlaces } from "./lib/places";
import { PLACES_HREF } from "./lib/route";
import { money } from "./Overview";

const PRESET_NAMES = { ferret: "Ferret's own export", amazon: "Amazon order history" } as const;
const SHOWN = 300;

const CsvSteps = ({ current }: { current: number }) => (
  <Steps label="Import steps" steps={[{ label: "Choose a file" }, { label: "Check columns and rows" }, { label: "Import" }]} current={current} />
);

export function ImportCsv({ householdId }: { householdId: string }) {
  const [file, setFile] = useState<{ name: string; table: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [error, setError] = useState<string | null>(null);

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (f.size > 20 * 1024 * 1024) return setError("That file is over 20 MB — split it into smaller ones.");
    const table = parseCsv(await f.text());
    if (table.length < 2) return setError("That file has no rows under its header.");
    setFile({ name: f.name, table });
    setMapping(guessMapping(table[0]!));
  }

  if (!file) {
    return (
      <>
      <CsvSteps current={0} />
      <section className="card">
        <div className="card-body gap-4">
          <p className="text-base-content/80">
            A spreadsheet saved as <strong>CSV</strong>, with a header row. You'll see which column goes where before anything is
            saved — and an import can be undone.
          </p>
          <ul className="list-inside list-disc space-y-1 text-sm text-base-content/70">
            <li>Numbers, Excel or Google Sheets: File → Export / Download → CSV.</li>
            <li>Amazon: Account → Request your data → Your orders; use <code>Retail.OrderHistory.1.csv</code> from the download.</li>
          </ul>
          <label className="btn btn-primary w-fit">
            <span className="icon-[tabler--file-upload] size-5" />
            Choose a CSV file
            <input type="file" accept=".csv,text/csv,.tsv,text/tab-separated-values" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          {error && <div className="alert alert-soft alert-error">{error}</div>}
        </div>
      </section>
      </>
    );
  }
  return <Mapper householdId={householdId} file={file} mapping={mapping} setMapping={setMapping} onReset={() => setFile(null)} />;
}

function Mapper({
  householdId,
  file,
  mapping,
  setMapping,
  onReset,
}: {
  householdId: string;
  file: { name: string; table: string[][] };
  mapping: ColumnMapping;
  setMapping: (m: ColumnMapping) => void;
  onReset: () => void;
}) {
  const headers = file.table[0]!;
  const preset = detectPreset(headers);
  const rows = useMemo(() => draftRows(file.table, mapping), [file.table, mapping]);
  const places = usePlaces(householdId);
  const properties = places.data?.properties ?? [];
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const property = propertyId ?? properties[0]?.id ?? null;
  const [unticked, setUnticked] = useState<Set<number>>(() => new Set(rows.flatMap((r, i) => (r.unlikely ? [i] : []))));
  const [filter, setFilter] = useState("");
  const [under, setUnder] = useState("");
  const { run, progress } = useImportRun(householdId);

  const below = Number.parseFloat(under) > 0 ? Math.round(Number.parseFloat(under) * 100) : null;
  const ticked = (r: DraftRow, i: number) => Boolean(r.draft) && !unticked.has(i) && !(below != null && (r.draft!.purchasePriceCents ?? r.draft!.valueCents ?? 0) < below);
  const chosen = rows.flatMap((r, i) => (ticked(r, i) ? [{ i, r }] : []));
  const needsProperty = chosen.some(({ r }) => r.draft!.place);
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !words.length || words.every((w) => (r.draft?.name ?? "").toLowerCase().includes(w)));
  const sample = (col: number) => file.table.slice(1, 6).map((row) => row[col]?.trim()).filter(Boolean).slice(0, 2).join(" · ");

  const setField = (col: number, field: ImportField | null) => {
    // A field goes in one column (notes can take several): picking it here frees it elsewhere.
    setMapping(mapping.map((f, c) => (c === col ? field : field && field !== "notes" && f === field ? null : f)));
  };
  const toggle = (i: number) => {
    const next = new Set(unticked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setUnticked(next);
  };

  // Columns in use first; the rest folded away (Amazon's file has 28). Kept in place while you change them.
  const [usedAtStart] = useState(() => new Set(mapping.flatMap((f, col) => (f ? [col] : []))));
  const used = headers.map((_, col) => col).filter((col) => usedAtStart.has(col) || mapping[col]);
  const unused = headers.map((_, col) => col).filter((col) => !used.includes(col));
  const columnRow = (col: number) => {
    const h = headers[col]!;
    return (
      <li key={col} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate font-medium">{h || `Column ${col + 1}`}</p>
          <p className="truncate text-sm text-base-content/70">{sample(col) || "empty"}</p>
        </div>
        <select
          className="select w-full sm:w-56"
          aria-label={`Where ${h || `column ${col + 1}`} goes`}
          value={mapping[col] ?? ""}
          onChange={(e) => setField(col, (e.target.value || null) as ImportField | null)}
        >
          <option value="">Leave out</option>
          {(Object.keys(IMPORT_FIELDS) as ImportField[]).map((f) => (
            <option key={f} value={f}>
              {IMPORT_FIELDS[f]}
            </option>
          ))}
        </select>
      </li>
    );
  };

  function start() {
    run.mutate({ source: "csv", name: file.name, parts: [{ propertyId: needsProperty ? property : null, rows: chosen.map(({ r }) => r.draft!) }] });
  }

  if (run.isPending || run.isSuccess) {
    return (
      <>
        <CsvSteps current={run.isSuccess ? 3 : 2} />
        <ImportStatus run={run} progress={progress} describe={(n) => `Line ${chosen[n]?.r.line ?? "?"}: ${chosen[n]?.r.draft?.name ?? ""}`} />
      </>
    );
  }

  return (
    <>
      <CsvSteps current={1} />
      <section className="card" aria-labelledby="csv-columns">
        <div className="card-body gap-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="csv-columns" className="card-title text-base">
                {file.name}
              </h2>
              <p className="text-sm text-base-content/70">
                {rows.length} {rows.length === 1 ? "row" : "rows"}
                {preset ? ` · looks like ${PRESET_NAMES[preset]}` : ""}
              </p>
            </div>
            <button type="button" className="btn btn-text btn-sm" onClick={onReset}>
              Another file
            </button>
          </div>
          <p className="text-sm text-base-content/70">Which column goes where? Ferret guessed — change anything that's wrong.</p>
          <ul className="divide-y divide-base-content/10">{used.map(columnRow)}</ul>
          {unused.length > 0 && (
            <details className="rounded-box bg-base-200 px-3 py-2" open={used.length === 0}>
              <summary className="cursor-pointer py-1 font-medium">
                {unused.length} {unused.length === 1 ? "column" : "columns"} left out
              </summary>
              <ul className="divide-y divide-base-content/10">{unused.map(columnRow)}</ul>
            </details>
          )}
          {!mapping.includes("name") && <div className="alert alert-soft alert-warning">Choose the column with each thing's name.</div>}
        </div>
      </section>

      {needsProperty && (
        <section className="card">
          <div className="card-body gap-2">
            {properties.length ? (
              <>
                <label className="label-text" htmlFor="csv-property">
                  Places named in the file go in
                </label>
                <select id="csv-property" className="select" value={property ?? ""} onChange={(e) => setPropertyId(e.target.value)}>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-sm text-base-content/70">Ones that aren't there yet are made, e.g. "Garage › Shelf 2".</p>
              </>
            ) : (
              <div className="alert alert-soft alert-warning">
                The file says where things are — add your home under{" "}
                <a href={PLACES_HREF} className="link">
                  Places
                </a>{" "}
                first, or leave the "Where it is" column out.
              </div>
            )}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="csv-rows">
        <div className="card-body gap-3">
          <h2 id="csv-rows" className="card-title text-base">
            What to import
          </h2>
          <div className="flex flex-wrap gap-3">
            <input className="input min-w-0 flex-1 basis-48" type="search" placeholder="Find a row" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a row" />
            {mapping.some((f) => f === "purchasePrice" || f === "value" || f === "purchaseTotal") && (
              <label className="input w-full sm:w-52">
                <span className="my-auto whitespace-nowrap text-sm text-base-content/70">Leave out under $</span>
                <input className="grow" inputMode="decimal" value={under} onChange={(e) => setUnder(e.target.value)} placeholder="0" aria-label="Leave out things that cost less than" />
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-text btn-sm" onClick={() => setUnticked(new Set())}>
              Tick all
            </button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setUnticked(new Set(rows.map((_, i) => i)))}>
              Untick all
            </button>
          </div>
          <ul className="divide-y divide-base-content/10">
            {visible.slice(0, SHOWN).map(({ r, i }) => (
              <li key={i}>
                <label className={`flex items-start gap-3 py-2 ${r.draft ? "cursor-pointer" : "opacity-70"}`}>
                  <input type="checkbox" className="checkbox checkbox-primary mt-1" checked={ticked(r, i)} disabled={!r.draft} onChange={() => toggle(i)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.draft?.name ?? `Line ${r.line}`}</span>
                    <span className="block truncate text-sm text-base-content/70">
                      {[
                        [r.draft?.brand, r.draft?.model].filter(Boolean).join(" "),
                        r.draft?.place,
                        r.draft?.purchasePriceCents != null ? money(r.draft.purchasePriceCents) : null,
                        r.draft?.purchaseDate,
                        r.unlikely ? "cancelled or returned" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || " "}
                    </span>
                    {r.problems.length > 0 && <span className="block text-sm text-warning">{r.problems.join("; ")}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {visible.length > SHOWN && <p className="text-sm text-base-content/70">And {visible.length - SHOWN} more (find one above to see it).</p>}
          {run.isError && <ImportStatus run={run} progress={progress} describe={() => ""} />}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-sm text-base-content/70">
              {chosen.length} of {rows.length} ticked
            </span>
            <button type="button" className="btn btn-primary" disabled={!chosen.length || (needsProperty && !property)} onClick={start}>
              Import {chosen.length} {chosen.length === 1 ? "thing" : "things"}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
