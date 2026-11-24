/**
 * #/import/ferret — one thing exported from Ferret (its signed ZIP, ItemSheet.tsx) brought back in. The ZIP is checked
 * first (POST /import/item/check: signed by this household's key, by another key, not signed, or changed since), and
 * that's shown with what's in it; then Import — or Import anyway, when it isn't this household's signature. Server:
 * lib/item-import.ts. It's one import like any other: listed on Import, with Undo.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import type { ItemImportCheck } from "@ferret/shared";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";

export function ImportFerret({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: api.checkItemZip,
    onSuccess: (seen) => setPropertyId(seen.propertyId),
  });
  const places = useQuery({ queryKey: ["places", householdId], queryFn: api.places, enabled: Boolean(check.data?.place) });
  const run = useMutation({
    mutationFn: () => api.importItemZip(file!, { anyway: check.data?.signature !== "ours", propertyId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["items", householdId] });
      void qc.invalidateQueries({ queryKey: ["imports", householdId] });
    },
  });
  const choose = (f: File | null) => {
    setFile(f);
    run.reset();
    check.reset();
    if (f) check.mutate(f);
  };
  const seen = check.data;

  if (run.data) {
    return (
      <section className="card" aria-live="polite">
        <div className="card-body gap-3">
          <h2 className="card-title flex items-center gap-2">
            <span className="icon-[tabler--circle-check] size-6 text-success" />
            <Trans>Imported {ph({ name: seen?.name ?? "" })}</Trans>
          </h2>
          {run.data.skippedFiles.length > 0 && (
            <p className="text-sm text-warning">
              <Trans>These files couldn't be added: {ph({ files: run.data.skippedFiles.join(", ") })}</Trans>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <a className="btn btn-primary" href={itemHref(run.data.itemId)}>
              <Trans>Open it</Trans>
            </a>
            <button type="button" className="btn btn-soft" onClick={() => choose(null)}>
              <Trans>Import another</Trans>
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <div className="card-body gap-3">
          <p className="text-sm text-base-content/70">
            <Trans>
              Choose the ZIP from a thing's Print or export. Ferret checks its signature first and shows you what's in it; nothing is added until you say so. It comes in as a new thing,
              with its photos, documents, warranties, maintenance and repairs.
            </Trans>
          </p>
          <label className="btn btn-primary btn-wrap self-start">
            <span className="icon-[tabler--file-zip] size-5" />
            {file ? t`Choose another ZIP` : t`Choose a ZIP`}
            <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
          </label>
          {check.isPending && <span className="loading loading-spinner text-primary" />}
          {check.isError && <p className="text-sm text-error">{check.error.message}</p>}
        </div>
      </section>

      {seen && (
        <section className="card" aria-labelledby="import-check">
          <div className="card-body gap-4">
            <h2 id="import-check" className="card-title">{seen.name}</h2>
            <Signature seen={seen} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {seen.place && (
                <>
                  <dt className="text-base-content/70"><Trans>Where it was</Trans></dt>
                  <dd>{seen.place}</dd>
                </>
              )}
              {seen.category && (
                <>
                  <dt className="text-base-content/70"><Trans>Category</Trans></dt>
                  <dd>{seen.category}</dd>
                </>
              )}
              {seen.exportedAt && (
                <>
                  <dt className="text-base-content/70"><Trans>Exported</Trans></dt>
                  <dd>{new Date(seen.exportedAt).toLocaleString()}</dd>
                </>
              )}
              <dt className="text-base-content/70"><Trans>With it</Trans></dt>
              <dd>{contents(seen) || t`Just its details`}</dd>
            </dl>
            {seen.sameSerial && (
              <div className="alert alert-soft alert-warning text-sm">
                <span className="icon-[tabler--copy] size-5 shrink-0" />
                <span>
                  <Trans>
                    <a className="link" href={itemHref(seen.sameSerial.id)}>{ph({ name: seen.sameSerial.name })}</a> here has the same serial number — importing adds a second one.
                  </Trans>
                </span>
              </div>
            )}
            {seen.place && (
              <fieldset>
                <legend className="mb-1 text-sm font-medium"><Trans>Put its place in</Trans></legend>
                <div className="flex flex-col">
                  {(places.data?.properties ?? []).map((p) => (
                    <label key={p.id} className="flex h-11 items-center gap-2">
                      <input type="radio" name="import-property" className="radio radio-primary" checked={propertyId === p.id} onChange={() => setPropertyId(p.id)} />
                      <span className="label-text text-base">{p.name}</span>
                    </label>
                  ))}
                  <label className="flex h-11 items-center gap-2">
                    <input type="radio" name="import-property" className="radio radio-primary" checked={propertyId === null} onChange={() => setPropertyId(null)} />
                    <span className="label-text text-base"><Trans>Nowhere yet (I'll place it)</Trans></span>
                  </label>
                </div>
                <p className="mt-1 text-xs text-base-content/70"><Trans>Rooms and shelves along its path are found by name, or made.</Trans></p>
              </fieldset>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={`btn btn-wrap ${seen.signature === "ours" ? "btn-primary" : seen.signature === "changed" ? "btn-error" : "btn-warning"}`}
                disabled={run.isPending}
                onClick={() => run.mutate()}
              >
                {run.isPending && <span className="loading loading-spinner loading-sm" />}
                {seen.signature === "ours" ? t`Import` : t`Import anyway`}
              </button>
              <button type="button" className="btn btn-soft" onClick={() => choose(null)}>
                <Trans>Cancel</Trans>
              </button>
            </div>
            {run.isError && <p className="text-sm text-error">{run.error.message}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

function contents(seen: ItemImportCheck) {
  const c = seen.counts;
  return [
    c.photos && plural(c.photos, { one: "# photo", other: "# photos" }),
    c.documents && plural(c.documents, { one: "# document", other: "# documents" }),
    c.warranties && plural(c.warranties, { one: "# warranty", other: "# warranties" }),
    c.maintenance && plural(c.maintenance, { one: "# maintenance task", other: "# maintenance tasks" }),
    c.repairs && plural(c.repairs, { one: "# repair", other: "# repairs" }),
  ]
    .filter(Boolean)
    .join(", ");
}

/** What the signature says, in words — the prompt's reason. */
function Signature({ seen }: { seen: ItemImportCheck }) {
  const fingerprint = seen.fingerprint ?? "";
  if (seen.signature === "ours") {
    return (
      <div className="alert alert-soft alert-success text-sm">
        <span className="icon-[tabler--shield-check] size-5 shrink-0" />
        <span><Trans>Signed by this household, and nothing has changed since it was exported.</Trans></span>
      </div>
    );
  }
  if (seen.signature === "other") {
    return (
      <div className="alert alert-soft alert-warning text-sm">
        <span className="icon-[tabler--shield-question] size-5 shrink-0" />
        <div>
          <p><Trans>Signed by another key, not this household's. Nothing has changed since it was signed — import it if you know where it came from.</Trans></p>
          <p className="mt-1 break-all font-mono text-xs"><Trans>Key fingerprint: {ph({ fingerprint })}</Trans></p>
        </div>
      </div>
    );
  }
  if (seen.signature === "unsigned") {
    return (
      <div className="alert alert-soft alert-warning text-sm">
        <span className="icon-[tabler--shield-off] size-5 shrink-0" />
        <span><Trans>It isn't signed, so Ferret can't tell whether anything in it was changed.</Trans></span>
      </div>
    );
  }
  return (
    <div className="alert alert-soft alert-error text-sm">
      <span className="icon-[tabler--shield-x] size-5 shrink-0" />
      <div>
        <p><Trans>Something in it changed after it was signed. Only import it if you made the change yourself.</Trans></p>
        <ul className="mt-1 list-disc ps-5">{seen.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    </div>
  );
}
