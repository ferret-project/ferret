import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Import a spreadsheet: pick a CSV, check which column goes where (guessed — @ferret/shared's guessMapping, with
 * presets for Ferret's own export and Amazon order history), untick what you don't want, import. The file
 * is read here, in the browser; only the rows you tick are sent.
 */
import { Steps } from "./Steps";
import { type ColumnMapping, type DraftRow, detectPreset, draftRows, guessMapping, IMPORT_FIELDS, type ImportField, parseCsv } from "@ferret/shared/utils";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "./lib/api";
import { ImportStatus, useImportRun } from "./Import";
import { usePlaces } from "./lib/places";
import { PLACES_HREF } from "./lib/route";
import { decimalMark, money, currencySymbol, toCents } from "./lib/money";
import { useFeatures } from "./lib/features";
import type { ImportTriageRow } from "@ferret/shared";

const PRESET_NAMES = { get ferret() { return translateText("Ferret's own export"); }, get amazon() { return translateText("Amazon order history"); } } as const;
const SHOWN = 300;

const CsvSteps = ({ current }: { current: number }) => (
  <Steps label={translateText("Import steps")} steps={[{ label: "Choose a file" }, { label: "Check columns and rows" }, { label: "Import" }]} current={current} />
);

export function ImportCsv({ householdId }: { householdId: string }) {
  const [file, setFile] = useState<{ name: string; table: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [error, setError] = useState<string | null>(null);

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (f.size > 20 * 1024 * 1024) return setError(translateText("That file is over 20 MB — split it into smaller ones."));
    const table = parseCsv(await f.text());
    if (table.length < 2) return setError(translateText("That file has no rows under its header."));
    setFile({ name: f.name, table });
    setMapping(guessMapping(table[0]!));
  }

  if (!file) {
    return (
      <>
      <CsvSteps current={0} />
      <section className="card">
        <div className="card-body gap-4">
          <p className="text-base-content/80">{tr("A spreadsheet saved as {v0}, with a header row. You'll see which column goes where before anything is saved — and an import can be undone.", { v0: <strong>CSV</strong> })}</p>
          <ul className="list-inside list-disc space-y-1 text-sm text-base-content/70">
            <li>{translateText("Numbers, Excel or Google Sheets: File → Export / Download → CSV.")}</li>
            <li>{tr("Amazon: Account → Request your data → Your orders; use {v0} from the download (older ones:{v1}{v2}). A newer download later brings in only the new orders.", { v0: <code>{"Order History.csv"}</code>, v1: " ", v2: <code>Retail.OrderHistory.1.csv</code> })}</li>
          </ul>
          <label className="btn btn-primary w-fit">
            <span className="icon-[tabler--file-upload] size-5" />
            {translateText("Choose a CSV file")}<input type="file" accept=".csv,text/csv,.tsv,text/tab-separated-values" className="hidden" onChange={(e) => void choose(e.target.files?.[0])} />
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
  // Today on this device: recent Amazon orders get "return by" 30 days on (draftRows).
  const rows = useMemo(() => {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return draftRows(file.table, mapping, today, decimalMark());
  }, [file.table, mapping]);
  const places = usePlaces(householdId);
  const properties = places.data?.properties ?? [];
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const property = propertyId ?? properties[0]?.id ?? null;
  const [unticked, setUnticked] = useState<Set<number>>(() => new Set(rows.flatMap((r, i) => (r.unlikely ? [i] : []))));
  // Lines already in Ferret from an earlier copy of the file (Amazon's order + product): unticked once known.
  const keys = useMemo(() => rows.flatMap((r) => (r.draft?.importKey ? [r.draft.importKey] : [])), [rows]);
  const knownQuery = useQuery({
    queryKey: ["import-known", householdId, file.name, keys.length],
    queryFn: () => api.importKnown(keys),
    enabled: keys.length > 0,
    staleTime: Infinity,
  });
  const known = knownQuery.data;
  const isKnown = (r: DraftRow) => Boolean(known && r.draft?.importKey && known.has(r.draft.importKey));
  const knownCount = known ? rows.filter(isKnown).length : 0;
  useEffect(() => {
    if (!known?.size) return;
    setUnticked((prev) => new Set([...prev, ...rows.flatMap((r, i) => (r.draft?.importKey && known.has(r.draft.importKey) ? [i] : []))]));
  }, [known]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filter, setFilter] = useState("");
  const [under, setUnder] = useState("");
  const { run, progress } = useImportRun(householdId);
  const sorted = useAiSort(rows, (skip) => setUnticked((prev) => new Set([...prev, ...skip])));
  const features = useFeatures();

  const below = (toCents(under) ?? 0) > 0 ? toCents(under) : null;
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
          <p className="truncate font-medium">{h || translateText("Column {v0}", { v0: col + 1 })}</p>
          <p className="truncate text-sm text-base-content/70">{sample(col) || translateText("empty")}</p>
        </div>
        <select
          className="select w-full sm:w-56"
          aria-label={translateText("Where {v0} goes", { v0: h || translateText("column {v0}", { v0: col + 1 }) })}
          value={mapping[col] ?? ""}
          onChange={(e) => setField(col, (e.target.value || null) as ImportField | null)}
        >
          <option value="">{translateText("Leave out")}</option>
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
    // A category the AI picked (from the household's own) for lines whose file gave none.
    const withCategory = ({ r, i }: { r: DraftRow; i: number }) => (r.draft!.category || !sorted.result[i]?.category ? r.draft! : { ...r.draft!, category: sorted.result[i]!.category! });
    run.mutate({ source: "csv", name: file.name, parts: [{ propertyId: needsProperty ? property : null, rows: chosen.map(withCategory) }] });
  }

  if (run.isPending || run.isSuccess) {
    return (
      <>
        <CsvSteps current={run.isSuccess ? 3 : 2} />
        <ImportStatus run={run} progress={progress} describe={(n) => translateText("Line {v0}: {v1}", { v0: chosen[n]?.r.line ?? "?", v1: chosen[n]?.r.draft?.name ?? "" })} />
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
                {rows.length} {rows.length === 1 ? translateText("row") : translateText("rows")}
                {preset ? translateText(" · looks like {v0}", { v0: PRESET_NAMES[preset] }) : ""}
              </p>
            </div>
            <button type="button" className="btn btn-text btn-sm" onClick={onReset}>
              {translateText("Another file")}</button>
          </div>
          <p className="text-sm text-base-content/70">{translateText("Which column goes where? Ferret guessed — change anything that's wrong.")}</p>
          <ul className="divide-y divide-base-content/10">{used.map(columnRow)}</ul>
          {unused.length > 0 && (
            <details className="rounded-box bg-base-200 px-3 py-2" open={used.length === 0}>
              <summary className="cursor-pointer py-1 font-medium">
                {unused.length} {unused.length === 1 ? translateText("column") : translateText("columns")} {translateText("left out")}</summary>
              <ul className="divide-y divide-base-content/10">{unused.map(columnRow)}</ul>
            </details>
          )}
          {!mapping.includes("name") && <div className="alert alert-soft alert-warning">{translateText("Choose the column with each thing's name.")}</div>}
        </div>
      </section>

      {needsProperty && (
        <section className="card">
          <div className="card-body gap-2">
            {properties.length ? (
              <>
                <label className="label-text" htmlFor="csv-property">
                  {translateText("Places named in the file go in")}</label>
                <select id="csv-property" className="select" value={property ?? ""} onChange={(e) => setPropertyId(e.target.value)}>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-sm text-base-content/70">{translateText("Ones that aren't there yet are made, e.g. \"Garage › Shelf 2\".")}</p>
              </>
            ) : (
              <div className="alert alert-soft alert-warning">{tr("The file says where things are — add your home under{v0}{v1}{v2}first, or leave the \"Where it is\" column out.", { v0: " ", v1: <a href={PLACES_HREF} className="link">
                  {translateText("Places")}</a>, v2: " " })}</div>
            )}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="csv-rows">
        <div className="card-body gap-3">
          <h2 id="csv-rows" className="card-title text-base">
            {translateText("What to import")}</h2>
          <div className="flex flex-wrap gap-3">
            <input className="input min-w-0 flex-1 basis-48" type="search" placeholder={translateText("Find a row")} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={translateText("Find a row")} />
            {mapping.some((f) => f === "purchasePrice" || f === "value" || f === "purchaseTotal") && (
              <label className="input w-full sm:w-52">
                <span className="my-auto whitespace-nowrap text-sm text-base-content/70">{tr("Leave out under {v0}", { v0: currencySymbol() })}</span>
                <input className="grow" inputMode="decimal" value={under} onChange={(e) => setUnder(e.target.value)} placeholder="0" aria-label={translateText("Leave out things that cost less than")} />
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-text btn-sm"
              onClick={() => setUnticked(new Set(rows.flatMap((r, i) => (isKnown(r) ? [i] : []))))}
              title={knownCount ? translateText("Everything not already in Ferret") : undefined}
            >
              {translateText("Tick all")}</button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setUnticked(new Set(rows.map((_, i) => i)))}>
              {translateText("Untick all")}</button>
            {features?.textAi && (
              <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={sorted.busy || sorted.done} onClick={sorted.start}>
                <span className="icon-[tabler--sparkles] size-4" />
                {sorted.busy ? translateText("Sorting… {v0}", { v0: sorted.progress }) : sorted.done ? translateText("Sorted with AI") : translateText("Sort with AI")}
              </button>
            )}
          </div>
          {sorted.error && <div className="alert alert-soft alert-error text-sm">{sorted.error}</div>}
          {sorted.done && (
            <div className="alert alert-soft alert-info flex items-start gap-2 text-sm">
              <span className="icon-[tabler--sparkles] size-5 shrink-0" />
              <span>
                {sorted.skipped === 1 ? translateText("{count} line looks like consumables or not worth a record, so it's unticked; {categories} got a category from yours. Check before importing — tick anything it got wrong.", { count: sorted.skipped, categories: sorted.categorised }) : translateText("{count} lines look like consumables or not worth a record, so they're unticked; {categories} got a category from yours. Check before importing — tick anything it got wrong.", { count: sorted.skipped, categories: sorted.categorised })}</span>
            </div>
          )}
          {knownQuery.isLoading && <p className="text-sm text-base-content/70">{translateText("Checking what's already in Ferret…")}</p>}
          {knownCount > 0 && (
            <div className="alert alert-soft alert-info flex items-start gap-2 text-sm">
              <span className="icon-[tabler--copy-check] size-5 shrink-0" />
              <span>
                {knownCount === 1 ? translateText("{count} line is already in Ferret from an earlier import of this file, so it's left out.", { count: knownCount }) : translateText("{count} lines are already in Ferret from an earlier import of this file, so they're left out.", { count: knownCount })}</span>
            </div>
          )}
          <ul className="divide-y divide-base-content/10">
            {visible.slice(0, SHOWN).map(({ r, i }) => (
              <li key={i}>
                <label className={`flex items-start gap-3 py-2 ${r.draft ? "cursor-pointer" : "opacity-70"}`}>
                  <input type="checkbox" className="checkbox checkbox-primary mt-1" checked={ticked(r, i)} disabled={!r.draft} onChange={() => toggle(i)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.draft?.name ?? translateText("Line {v0}", { v0: r.line })}</span>
                    <span className="block truncate text-sm text-base-content/70">
                      {[
                        [r.draft?.brand, r.draft?.model].filter(Boolean).join(" "),
                        r.draft?.place,
                        r.draft?.purchasePriceCents != null ? money(r.draft.purchasePriceCents) : null,
                        r.draft?.purchaseDate,
                        r.draft?.returnBy ? translateText("return by {v0}", { v0: r.draft.returnBy }) : null,
                        isKnown(r) ? translateText("already in Ferret") : null,
                        r.unlikely ? translateText("cancelled or returned") : null,
                        !r.draft?.category && sorted.result[i]?.category ? translateText("AI: {v0}", { v0: sorted.result[i]!.category }) : null,
                        sorted.result[i]?.keep === false ? translateText("AI: probably a consumable") : null,
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
          {visible.length > SHOWN && <p className="text-sm text-base-content/70">{translateText("And ")}{visible.length - SHOWN} {translateText("more (find one above to see it).")}</p>}
          {run.isError && <ImportStatus run={run} progress={progress} describe={() => ""} />}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-sm text-base-content/70">{tr("{v0} of {v1} ticked", { v0: chosen.length, v1: rows.length })}</span>
            <button type="button" className="btn btn-primary" disabled={!chosen.length || (needsProperty && !property) || knownQuery.isLoading} onClick={start}>{tr("Import {v0} ", { v0: chosen.length })}{chosen.length === 1 ? translateText("thing") : translateText("things")}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * "Sort with AI" (AI-1): the lines' names go to the server, a job asks the text model which look worth keeping and
 * which of the household's own categories fits each; the ones that don't are unticked here. Nothing is saved until
 * Import, and anything can be ticked again.
 */
function useAiSort(rows: DraftRow[], untick: (indexes: number[]) => void) {
  const [result, setResult] = useState<(ImportTriageRow | null)[]>([]);
  const [state, setState] = useState<{ busy: boolean; done: boolean; progress: string; error: string | null }>({ busy: false, done: false, progress: "", error: null });
  const indexes = rows.flatMap((r, i) => (r.draft ? [i] : []));
  async function start() {
    setState({ busy: true, done: false, progress: "", error: null });
    try {
      const { id } = await api.importTriage({ rows: indexes.slice(0, 3000).map((i) => ({ name: rows[i]!.draft!.name, category: rows[i]!.draft!.category ?? undefined })) });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const run = await api.importTriageRun(id);
        if (run.status === "failed") throw new Error(run.error ?? translateText("Sorting didn't work"));
        if (run.status === "done") {
          const byRow: (ImportTriageRow | null)[] = [];
          (run.result ?? []).forEach((r, n) => (byRow[indexes[n]!] = r));
          setResult(byRow);
          untick(byRow.flatMap((r, i) => (r?.keep === false ? [i] : [])));
          setState({ busy: false, done: true, progress: "", error: null });
          return;
        }
        setState((s) => ({ ...s, progress: run.total ? translateText("{v0} of {v1}", { v0: run.done ?? 0, v1: run.total }) : "" }));
      }
    } catch (err) {
      setState({ busy: false, done: false, progress: "", error: (err as Error).message });
    }
  }
  return {
    ...state,
    start,
    result,
    skipped: result.filter((r) => r?.keep === false).length,
    categorised: result.filter((r, i) => r?.category && !rows[i]?.draft?.category).length,
  };
}
