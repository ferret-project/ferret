/**
 * #/import — bringing things in: a spreadsheet (ImportCsv.tsx: any CSV, with Ferret's own export and
 * Amazon's order history recognised) or Home Assistant's devices (ImportHomeAssistant.tsx). Both send rows to
 * POST /import in parts of 100, as one import that can be undone (server: lib/imports.ts). Recent imports are listed
 * here with Undo — their things go to Recently deleted.
 */
import { TopBar } from "./Nav";
import { useFeatures } from "./lib/features";
import type { ImportPlace, ImportResult, ImportRow, ImportSource } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HelpLink } from "./HelpLink";
import { ImportCsv } from "./ImportCsv";
import { ImportHomeAssistant } from "./ImportHomeAssistant";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { DELETED_HREF, IMPORT_HREF, ITEMS_HREF, PAPERLESS_HREF, importHref } from "./lib/route";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans, Plural } from "@lingui/react/macro";

const PART = 100;

export function Import({ householdId, source }: { householdId: string; source: ImportSource | null }) {
  const canEdit = useCanEdit(householdId);
  const title = source === "csv" ? t`Import a spreadsheet` : source === "homeassistant" ? t`Import from Home Assistant` : t`Import`;
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar
        title={title}
        back={source ? IMPORT_HREF : "#/"}
        help={<HelpLink page="guide/importing.html" label={t`Importing`} />}
        search={false}
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!canEdit ? (
          <div className="alert alert-soft alert-info"><Trans>You can look around, but not add things, in this household.</Trans></div>
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
      title: t`A spreadsheet (CSV)`,
      text: t`Any list of things — you say which column is which. Ferret's own export and Amazon's order history are recognised.`,
    },
    {
      href: importHref("homeassistant"),
      icon: "icon-[tabler--smart-home]",
      title: t`Home Assistant`,
      text: t`The appliances, TVs, speakers, cameras and network gear it knows — with their maker, model and room.`,
      // Only where the server can reach a Home Assistant.
      hidden: features?.homeAssistant === false,
    },
    {
      href: PAPERLESS_HREF,
      icon: "icon-[tabler--file-text]",
      title: t`Paperless-ngx`,
      text: t`Receipts and manuals you tag in Paperless — each becomes a new thing, or goes onto one you have.`,
      hidden: features?.paperless === false,
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
          <Trans>Recent imports</Trans>
        </h2>
        <ul className="divide-y divide-base-content/10">
          {rows.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <span className={`${b.source === "csv" ? "icon-[tabler--file-spreadsheet]" : "icon-[tabler--smart-home]"} size-5 shrink-0 text-base-content/70`} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{b.name}</p>
                <p className="text-sm text-base-content/70">
                  {new Date(b.importedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  {b.by ? ` · ${b.by}` : ""} ·{" "}
                  {b.undoneAt ? t`undone` : plural(b.items, { one: "# thing", other: "# things" })}
                </p>
              </div>
              {!b.undoneAt &&
                (confirming === b.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn btn-error btn-sm" disabled={undo.isPending} onClick={() => undo.mutate(b.id)}>
                      {undo.isPending && <span className="loading loading-spinner loading-xs" />}
                      <Trans>Undo — remove {ph({ items: b.items })}</Trans>
                    </button>
                    <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(null)}>
                      <Trans>Keep</Trans>
                    </button>
                  </div>
                ) : (
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => setConfirming(b.id)}>
                    <Trans>Undo…</Trans>
                  </button>
                ))}
            </li>
          ))}
        </ul>
        {undo.isError && <div className="alert alert-soft alert-error">{undo.error.message}</div>}
        {undo.data && (
          <p className="text-sm text-base-content/70">
            <Trans>
              <Plural value={undo.data.removed} one="# thing" other="# things" /> moved to{" "}
              <a href={DELETED_HREF} className="link tap">
                Recently deleted
              </a>
              .
            </Trans>
          </p>
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
            {progress.total ? t`Importing… ${ph({ done: progress.done })} of ${ph({ total: progress.total })}` : t`Importing…`}
          </p>
          <progress className="progress progress-primary w-full" value={progress.done} max={progress.total} aria-label={t`Import progress`} />
        </div>
      </div>
    );
  }
  if (run.isError) {
    return (
      <div className="alert alert-soft alert-error" role="alert">
        {run.error.message}
        {progress && progress.done > 0 ? t` — the first ${ph({ done: progress.done })} went in; see Recent imports to undo them.` : ""}
      </div>
    );
  }
  const r = run.data;
  if (!r) return null;
  const made = [r.placesCreated && plural(r.placesCreated, { one: "# new place", other: "# new places" }), r.categoriesCreated && plural(r.categoriesCreated, { one: "# new category", other: "# new categories" })].filter((x): x is string => typeof x === "string");
  return (
    <section className="card" aria-live="polite">
      <div className="card-body gap-3">
        <h2 className="card-title flex items-center gap-2">
          <span className="icon-[tabler--circle-check] size-6 text-success" />
          {r.created
            ? plural(r.created, { one: "Imported # thing", other: "Imported # things" })
            : r.placesCreated
              ? plural(r.placesCreated, { one: "Made # place", other: "Made # places" })
              : r.updated
                ? t`Updated from Home Assistant`
                : t`Nothing new to import`}
        </h2>
        {r.created > 0 && made.length > 0 && <p className="text-sm text-base-content/70">{made.length === 2 ? t`And made ${ph({ places: made[0]! })} and ${ph({ categories: made[1]! })}.` : t`And made ${ph({ what: made[0]! })}.`}</p>}
        {r.updated > 0 && (
          <p className="text-sm text-base-content/70">
            {plural(r.updated, { one: "# thing changed to match Home Assistant.", other: "# things changed to match Home Assistant." })}
          </p>
        )}
        {r.skipped.length > 0 && (
          <details className="rounded-box bg-base-200 p-3">
            <summary className="cursor-pointer font-medium">
              <Trans>{ph({ count: r.skipped.length })} not imported</Trans>
            </summary>
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
          <Trans><a href={ITEMS_HREF} className="btn btn-primary">
            See everything
          </a>
          <a href={IMPORT_HREF} className="btn btn-soft">
            Done
          </a></Trans>
        </div>
        <p className="text-sm text-base-content/70"><Trans>Not what you wanted? Undo it under Import → Recent imports.</Trans></p>
      </div>
    </section>
  );
}
