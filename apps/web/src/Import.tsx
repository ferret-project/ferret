import { tn } from "./i18n";
import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * #/import — bringing things in: a spreadsheet (ImportCsv.tsx: any CSV, with Ferret's own export and
 * Amazon's order history recognised) or Home Assistant's devices (ImportHomeAssistant.tsx). Both send rows to
 * POST /import in parts of 100, as one import that can be undone (server: lib/imports.ts). Recent imports are listed
 * here with Undo — their things go to Recently deleted.
 */
import { useFeatures } from "./lib/features";
import type { ImportPlace, ImportResult, ImportRow, ImportSource } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HelpLink } from "./HelpLink";
import { ImportCsv } from "./ImportCsv";
import { ImportHomeAssistant } from "./ImportHomeAssistant";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { DELETED_HREF, IMPORT_HREF, ITEMS_HREF, importHref } from "./lib/route";

const PART = 100;

export function Import({ householdId, source }: { householdId: string; source: ImportSource | null }) {
  const canEdit = useCanEdit(householdId);
  const title = source === "csv" ? translateText("Import a spreadsheet") : source === "homeassistant" ? translateText("Import from Home Assistant") : translateText("Import");
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href={source ? IMPORT_HREF : "#/"} className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <HelpLink page="guide/importing.html" label={translateText("Importing")} />
        </div>
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!canEdit ? (
          <div className="alert alert-soft alert-info">{translateText("You can look around, but not add things, in this household.")}</div>
        ) : source === "csv" ? (
          <ImportCsv householdId={householdId} />
        ) : source === "homeassistant" ? (
          <ImportHomeAssistant householdId={householdId} />
        ) : (
          <>
            <Choices />
            <RecentImports householdId={householdId} />
          </>
        )}
      </main>
    </div>
  );
}

function Choices() {
  const features = useFeatures();
  const options = [
    {
      href: importHref("csv"),
      icon: "icon-[tabler--file-spreadsheet]",
      title: translateText("A spreadsheet (CSV)"),
      text: translateText("Any list of things — you say which column is which. Ferret's own export and Amazon's order history are recognised."),
    },
    {
      href: importHref("homeassistant"),
      icon: "icon-[tabler--smart-home]",
      title: translateText("Home Assistant"),
      text: translateText("The appliances, TVs, speakers, cameras and network gear it knows — with their maker, model and room."),
      // Only where the server can reach a Home Assistant.
      hidden: features?.homeAssistant === false,
    },
  ].filter((o) => !("hidden" in o && o.hidden));
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
        {options.map((o) => (
          <a key={o.href} href={o.href} className="card transition-shadow hover:shadow-md">
            <div className="card-body gap-2">
              <span className={`${o.icon} size-8 text-primary`} />
              <h2 className="card-title text-lg">{o.title}</h2>
              <p className="text-sm text-base-content/70">{o.text}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function RecentImports({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["imports", householdId], queryFn: api.imports });
  const [confirming, setConfirming] = useState<string | null>(null);
  const undo = useMutation({
    mutationFn: api.undoImport,
    onSuccess: () => {
      setConfirming(null);
      for (const k of ["imports", "items", "places", "overview", "attention", "categories", "tags", "deleted"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
    },
  });
  const rows = list.data?.data ?? [];
  if (!rows.length) return null;
  return (
    <section className="card" aria-labelledby="recent-imports">
      <div className="card-body gap-3">
        <h2 id="recent-imports" className="card-title text-base">
          {translateText("Recent imports")}</h2>
        <ul className="divide-y divide-base-content/10">
          {rows.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className={`${b.source === "csv" ? "icon-[tabler--file-spreadsheet]" : "icon-[tabler--smart-home]"} size-5 shrink-0 text-base-content/70`} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{b.name}</p>
                <p className="text-sm text-base-content/70">
                  {new Date(b.importedAt).toLocaleDateString(locale(), { month: "short", day: "numeric", year: "numeric" })}
                  {b.by ? ` · ${b.by}` : ""} ·{" "}
                  {b.undoneAt ? translateText("undone") : tn(b.items, "{count} thing", "{count} things")}
                </p>
              </div>
              {!b.undoneAt &&
                (confirming === b.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn btn-error btn-sm" disabled={undo.isPending} onClick={() => undo.mutate(b.id)}>
                      {undo.isPending && <span className="loading loading-spinner loading-xs" />}{tr("Undo — remove {v0}", { v0: b.items })}</button>
                    <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(null)}>
                      {translateText("Keep")}</button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => setConfirming(b.id)}>
                    {translateText("Undo…")}</button>
                ))}
            </li>
          ))}
        </ul>
        {undo.isError && <div className="alert alert-soft alert-error">{undo.error.message}</div>}
        {undo.data && (
          <p className="text-sm text-base-content/70">
            {undo.data.removed} {undo.data.removed === 1 ? translateText("thing") : translateText("things")}{tr(" moved to{v0}{v1}.", { v0: " ", v1: <a href={DELETED_HREF} className="link tap">
              {translateText("Recently deleted")}</a> })}</p>
        )}
      </div>
    </section>
  );
}

export interface ImportOutcome extends ImportResult {
  total: number;
  /** Things changed to match Home Assistant (a re-import). */
  updated: number;
}

/** Rows (and places) for one property; a Home Assistant import can have several (a floor that's its own property). */
export interface ImportPart {
  propertyId: string | null;
  places?: ImportPlace[];
  rows: ImportRow[];
}

/**
 * Sends the parts in turn (made first if they're a function — new properties), rows 100 at a time, all as one import;
 * then `then` (a re-import's changes). Skipped rows' indexes count across all the parts' rows, in order.
 */
export function useImportRun(householdId: string) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const run = useMutation({
    mutationFn: async (job: { source: ImportSource; name: string; parts: ImportPart[] | (() => Promise<ImportPart[]>); then?: () => Promise<number> }) => {
      const parts = typeof job.parts === "function" ? await job.parts() : job.parts;
      const total = parts.reduce((n, p) => n + p.rows.length, 0);
      const out: ImportOutcome = { batchId: "", created: 0, skipped: [], placesCreated: 0, categoriesCreated: 0, total, updated: 0 };
      let done = 0;
      setProgress({ done, total });
      for (const part of parts) {
        for (let start = 0; start === 0 || start < part.rows.length; start += PART) {
          const rows = part.rows.slice(start, start + PART);
          const places = start === 0 ? part.places : undefined;
          if (!rows.length && !places?.length) break;
          const r = await api.importRows({ source: job.source, name: job.name, propertyId: part.propertyId, batchId: out.batchId || null, places, rows });
          out.batchId = r.batchId || out.batchId;
          out.created += r.created;
          out.placesCreated += r.placesCreated;
          out.categoriesCreated += r.categoriesCreated;
          out.skipped.push(...r.skipped.map((s) => ({ ...s, index: s.index + done })));
          done += rows.length;
          setProgress({ done, total });
        }
      }
      if (job.then) out.updated = await job.then();
      return out;
    },
    onSettled: () => {
      for (const k of ["imports", "items", "item", "places", "overview", "attention", "categories", "tags"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
    },
  });
  return { run, progress };
}

/** Progress while it runs; then what happened, with the rows that weren't imported (labelled by `describe`). */
export function ImportStatus({
  run,
  progress,
  describe,
}: {
  run: ReturnType<typeof useImportRun>["run"];
  progress: { done: number; total: number } | null;
  describe: (index: number) => string;
}) {
  if (run.isPending && progress) {
    return (
      <div className="card">
        <div className="card-body gap-3">
          <p className="font-medium">
            {progress.total ? translateText("Importing… {v0} of {v1}", { v0: progress.done, v1: progress.total }) : translateText("Importing…")}
          </p>
          <progress className="progress progress-primary w-full" value={progress.done} max={progress.total} aria-label={translateText("Import progress")} />
        </div>
      </div>
    );
  }
  if (run.isError) {
    return (
      <div className="alert alert-soft alert-error" role="alert">
        {run.error.message}
        {progress && progress.done > 0 ? translateText(" — the first {v0} went in; see Recent imports to undo them.", { v0: progress.done }) : ""}
      </div>
    );
  }
  const r = run.data;
  if (!r) return null;
  const made = [r.placesCreated && tn(r.placesCreated, "{count} new place", "{count} new places"), r.categoriesCreated && tn(r.categoriesCreated, "{count} new category", "{count} new categories")].filter(Boolean);
  return (
    <section className="card" aria-live="polite">
      <div className="card-body gap-3">
        <h2 className="card-title flex items-center gap-2">
          <span className="icon-[tabler--circle-check] size-6 text-success" />
          {r.created
            ? tn(r.created, "Imported {count} thing", "Imported {count} things")
            : r.placesCreated
              ? tn(r.placesCreated, "Made {count} place", "Made {count} places")
              : r.updated
                ? translateText("Updated from Home Assistant")
                : translateText("Nothing new to import")}
        </h2>
        {r.created > 0 && made.length > 0 && <p className="text-sm text-base-content/70">{tr("And made {v0}.", { v0: made.join(" and ") })}</p>}
        {r.updated > 0 && (
          <p className="text-sm text-base-content/70">
            {r.updated} {r.updated === 1 ? translateText("thing") : translateText("things")} {translateText("changed to match Home Assistant.")}</p>
        )}
        {r.skipped.length > 0 && (
          <details className="rounded-box bg-base-200 p-3">
            <summary className="cursor-pointer font-medium">{tr("{v0} not imported", { v0: r.skipped.length })}</summary>
            <ul className="mt-2 space-y-1 text-sm">
              {r.skipped.slice(0, 200).map((s) => (
                <li key={s.index}>
                  <span className="font-medium">{describe(s.index)}</span> — {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          <a href={ITEMS_HREF} className="btn btn-primary">
            {translateText("See everything")}</a>
          <a href={IMPORT_HREF} className="btn btn-soft">
            {translateText("Done")}</a>
        </div>
        <p className="text-sm text-base-content/70">{translateText("Not what you wanted? Undo it under Import → Recent imports.")}</p>
      </div>
    </section>
  );
}
