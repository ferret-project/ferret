/**
 * Making it pay off:
 * - RecallCard on an item's page (its open recalls: hazard, what to do, the CPSC's page; "Not mine" / "Dealt with it"),
 *   and RecallAlert on the dashboard (every open recall). Server: lib/recalls.ts.
 * - Coverage (#/coverage): insurance limits next to what the things they cover are worth, with presets for a policy's
 *   usual special limits. Server: lib/coverage.ts.
 * - WeeklySummary (Settings → Notifications): the day for this person's weekly summary, and email. Server: lib/digest.ts.
 */
import { BarSearch } from "./Nav";
import type { CoverageCheck, CoverageInput, ItemRecall } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { CategoryPicker } from "./Catalog";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { usePlaces } from "./lib/places";
import { itemHref, REPORT_HREF } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { money } from "./Overview";

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function useRecallRefresh(householdId: string, itemId?: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([["recalls", householdId], ["attention", householdId], ...(itemId ? [["item", householdId, itemId]] : [])].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** On an item's page: its open recalls. */
export function RecallCard({ itemId, householdId }: { itemId: string; householdId: string }) {
  const recalls = useQuery({ queryKey: ["recalls", householdId, itemId], queryFn: () => api.itemRecalls(itemId) });
  const open = (recalls.data?.data ?? []).filter((r) => r.status === "open");
  if (!open.length) return null;
  return (
    <>
      {open.map((r) => (
        <RecallBox key={r.id} recall={r} householdId={householdId} />
      ))}
    </>
  );
}

function RecallBox({ recall: r, householdId, showItem }: { recall: ItemRecall; householdId: string; showItem?: boolean }) {
  const canEdit = useCanEdit(householdId);
  const refresh = useRecallRefresh(householdId, r.itemId);
  const resolve = useMutation({ mutationFn: (status: "dismissed" | "done") => api.resolveRecall(r.id, status), onSuccess: refresh });
  const sure = r.match !== "possible";
  return (
    <section className={`alert alert-soft ${sure ? "alert-error" : "alert-warning"} flex flex-col items-stretch gap-2`} role="alert">
      <div className="flex items-start gap-3">
        <span className="icon-[tabler--alert-triangle] size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {sure ? "Recalled" : "Possibly recalled — check the model"}
            {showItem && (
              <>
                {": "}
                <a href={itemHref(r.itemId)} className="link">
                  {r.itemName}
                </a>
              </>
            )}
          </p>
          <p className="text-sm">
            {r.recall.title} ({shortDate(r.recall.recalledOn)})
          </p>
        </div>
      </div>
      {!showItem && (
        <div className="space-y-1 text-sm">
          {r.recall.hazard && <p>{r.recall.hazard}</p>}
          {r.recall.remedy && (
            <p>
              <span className="font-medium">What to do: </span>
              {r.recall.remedy}
            </p>
          )}
          {!sure && r.recall.description && <p className="line-clamp-4">{r.recall.description}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {r.recall.url && (
          <a href={r.recall.url} target="_blank" rel="noreferrer" className="btn btn-soft btn-sm">
            <span className="icon-[tabler--external-link] size-4" />
            The recall notice
          </a>
        )}
        {canEdit && (
          <>
            <button type="button" className="btn btn-soft btn-sm" disabled={resolve.isPending} onClick={() => resolve.mutate("dismissed")}>
              Not mine
            </button>
            <button type="button" className="btn btn-soft btn-sm" disabled={resolve.isPending} onClick={() => resolve.mutate("done")}>
              Dealt with it
            </button>
          </>
        )}
      </div>
      {resolve.isError && <p className="text-sm">{resolve.error.message}</p>}
    </section>
  );
}

/**
 * On the dashboard, before anything else: recalls of things you have (barcode or model) in full; possible ones (same
 * maker and kind of thing) as one line of links — each item's page has the details.
 */
export function RecallAlert({ householdId }: { householdId: string }) {
  const recalls = useQuery({ queryKey: ["recalls", householdId], queryFn: api.recalls });
  const open = recalls.data?.data ?? [];
  const sure = open.filter((r) => r.match !== "possible");
  const maybe = [...new Map(open.filter((r) => r.match === "possible").map((r) => [r.itemId, r])).values()];
  if (!open.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {sure.slice(0, 5).map((r) => (
        <RecallBox key={r.id} recall={r} householdId={householdId} showItem />
      ))}
      {sure.length > 5 && <p className="text-sm text-base-content/70">And {sure.length - 5} more — they're in the bell.</p>}
      {maybe.length > 0 && (
        <div className="alert alert-soft alert-warning flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm" role="status">
          <span className="icon-[tabler--alert-triangle] size-5 shrink-0" />
          <span>Possible recalls — check the model:</span>
          {maybe.map((r, i) => (
            <span key={r.itemId}>
              <a href={itemHref(r.itemId)} className="link font-medium">
                {r.itemName}
              </a>
              {i < maybe.length - 1 ? "," : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Coverage ────────────────────────────────────────────────────────────────

/** A policy's usual limits, to start from (the amounts are typical — check yours). */
const PRESETS: { label: string; scope: CoverageInput["scope"]; cents: number; hint: string }[] = [
  { label: "Personal property (Coverage C)", scope: "all", cents: 0, hint: "Everything you own — on your declarations page." },
  { label: "Jewelry & watches", scope: "tag", cents: 150_000, hint: "Theft is often limited to $1,500." },
  { label: "Firearms", scope: "tag", cents: 250_000, hint: "Often $2,500." },
  { label: "Silverware", scope: "tag", cents: 250_000, hint: "Often $2,500." },
  { label: "Cash & coins", scope: "tag", cents: 20_000, hint: "Often $200." },
  { label: "Electronics", scope: "category", cents: 0, hint: "Some policies limit these." },
  { label: "Art & collectibles", scope: "tag", cents: 0, hint: "Usually need a separate rider." },
];

export function Coverage({ householdId }: { householdId: string }) {
  const checks = useQuery({ queryKey: ["coverage", householdId], queryFn: api.coverage });
  const canEdit = useCanEdit(householdId);
  const [editing, setEditing] = useState<CoverageCheck | Partial<CoverageInput> | null>(null);
  const rows = checks.data?.data ?? [];
  const used = new Set(rows.map((r) => r.label));
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start w-full min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label="Back">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">Insurance coverage</h1>
          <HelpLink page="guide/coverage.html" label="Coverage" />
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-sm text-base-content/70">
          Your policy's limits, next to what your things are worth. A homeowner's or renter's policy covers your belongings up to one amount, and
          often much less for some kinds of things — jewelry, firearms, silverware. The numbers are on your policy's declarations page.
        </p>
        {checks.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {rows.map((c) => (
          <CoverageRow key={c.id} check={c} onEdit={canEdit ? () => setEditing(c) : undefined} />
        ))}
        {canEdit && (
          <section className="card">
            <div className="card-body gap-3">
              <h2 className="card-title text-base">{rows.length ? "Add another limit" : "Add your policy's limits"}</h2>
              <div className="flex flex-wrap gap-2">
                {PRESETS.filter((p) => !used.has(p.label)).map((p) => (
                  <button key={p.label} type="button" className="btn btn-soft btn-sm" title={p.hint} onClick={() => setEditing({ label: p.label, scope: p.scope, limitCents: p.cents })}>
                    <span className="icon-[tabler--plus] size-4" />
                    {p.label}
                  </button>
                ))}
                <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing({ scope: "tag" })}>
                  Something else…
                </button>
              </div>
              <p className="text-sm text-base-content/70">
                A limit on a kind of thing counts what's in a category (Electronics) or has a tag (Jewelry) — tag the things it covers. Values come
                from each thing's value, or what you paid; see the <a href={REPORT_HREF} className="link">insurance report</a> for the list.
              </p>
            </div>
          </section>
        )}
      </main>
      {editing && <CoverageDialog householdId={householdId} start={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CoverageRow({ check: c, onEdit }: { check: CoverageCheck; onEdit?: () => void }) {
  const short = c.shortCents > 0;
  const pct = c.limitCents ? Math.min(100, Math.round((c.valueCents / c.limitCents) * 100)) : 100;
  const covers = c.scope === "all" ? "Everything" : c.scope === "category" ? (c.categoryName ?? "A category") : `Tagged ${c.tag}`;
  return (
    <section className="card">
      <div className="card-body gap-3 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-semibold">{c.label}</h2>
            <p className="text-sm text-base-content/70">
              {covers}
              {c.propertyName ? ` at ${c.propertyName}` : ""} · {c.items} {c.items === 1 ? "thing" : "things"}
              {c.unvalued ? ` (${c.unvalued} with no value)` : ""}
            </p>
          </div>
          {onEdit && (
            <button type="button" className="btn btn-text btn-sm" onClick={onEdit}>
              Edit
            </button>
          )}
        </div>
        <div>
          <div className="flex flex-wrap justify-between gap-x-4 text-sm">
            <span>
              Worth <span className="font-semibold">{money(c.valueCents)}</span>
            </span>
            <span>
              Covered for <span className="font-semibold">{money(c.limitCents)}</span>
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-base-200" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of the limit`}>
            <div className={`h-full rounded-full ${short ? "bg-error" : "bg-success"}`} style={{ width: `${pct}%` }} />
          </div>
          <p className={`mt-1 text-sm font-medium ${short ? "text-error" : "text-success"}`}>
            {short ? `${money(c.shortCents)} more than the limit — ask about a rider or a higher limit.` : `Within the limit (${money(c.limitCents - c.valueCents)} to spare).`}
          </p>
          {c.unvalued > 0 && <p className="text-sm text-base-content/70">Things with no value aren't counted, so the real total may be higher.</p>}
          {c.note && <p className="text-sm text-base-content/70">{c.note}</p>}
        </div>
      </div>
    </section>
  );
}

function CoverageDialog({ householdId, start, onClose }: { householdId: string; start: CoverageCheck | Partial<CoverageInput>; onClose: () => void }) {
  const qc = useQueryClient();
  const places = usePlaces(householdId);
  const existing = "id" in start ? start : null;
  const [scope, setScope] = useState<CoverageInput["scope"]>(start.scope ?? "tag");
  const [categoryId, setCategoryId] = useState<string | null>(start.categoryId ?? null);
  const done = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["coverage", householdId] }), qc.invalidateQueries({ queryKey: ["attention", householdId] })]);
    onClose();
  };
  const save = useMutation({ mutationFn: (input: CoverageInput) => (existing ? api.updateCoverage(existing.id, input) : api.addCoverage(input)), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api.deleteCoverage(existing!.id), onSuccess: done });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const dollars = Number.parseFloat(String(f.get("limit") ?? "").replace(/[$,\s]/g, ""));
    save.mutate({
      label: String(f.get("label")).trim(),
      limitCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0,
      scope,
      propertyId: String(f.get("property") || "") || null,
      categoryId: scope === "category" ? categoryId : null,
      tag: scope === "tag" ? String(f.get("tag") ?? "").trim() || null : null,
      note: String(f.get("note") ?? "").trim() || null,
    });
  }
  return (
    <Modal id="coverage" title={existing ? `Edit ${existing.label}` : "Add a limit"} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div>
          <label className="label-text" htmlFor="cov-label">
            Name
          </label>
          <input id="cov-label" name="label" className="input" required maxLength={80} defaultValue={start.label ?? ""} placeholder="e.g. Jewelry & watches" />
        </div>
        <div>
          <label className="label-text" htmlFor="cov-limit">
            Covered up to
          </label>
          <div className="input">
            <span className="my-auto me-1 text-base-content/70">$</span>
            <input id="cov-limit" name="limit" className="grow" inputMode="decimal" required defaultValue={start.limitCents ? String(start.limitCents / 100) : ""} placeholder="1500" />
          </div>
        </div>
        <div>
          <label className="label-text" htmlFor="cov-scope">
            It covers
          </label>
          <select id="cov-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value as CoverageInput["scope"])}>
            <option value="all">Everything</option>
            <option value="category">Things in a category</option>
            <option value="tag">Things with a tag</option>
          </select>
        </div>
        {scope === "category" && <CategoryPicker householdId={householdId} value={categoryId} onChange={setCategoryId} />}
        {scope === "tag" && (
          <div>
            <label className="label-text" htmlFor="cov-tag">
              Tag
            </label>
            <input id="cov-tag" name="tag" className="input" required maxLength={40} defaultValue={start.tag ?? (start.label?.split(/\s*[&,]\s*/)[0] ?? "")} />
          </div>
        )}
        {(places.data?.properties.length ?? 0) > 1 && (
          <div>
            <label className="label-text" htmlFor="cov-property">
              At
            </label>
            <select id="cov-property" name="property" className="select" defaultValue={start.propertyId ?? ""}>
              <option value="">Every property</option>
              {places.data!.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label-text" htmlFor="cov-note">
            Note
          </label>
          <input id="cov-note" name="note" className="input" maxLength={500} defaultValue={start.note ?? ""} placeholder="e.g. theft only; policy HO-3 #12345" />
        </div>
        {existing && (
          <div>
            <button type="button" className="btn btn-text btn-error btn-sm" disabled={remove.isPending} onClick={() => window.confirm(`Remove ${existing.label}?`) && remove.mutate()}>
              Remove this limit
            </button>
          </div>
        )}
        {(save.error ?? remove.error) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            Save
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

// ── Weekly summary ──────────────────────────────────────────────────────────

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function WeeklySummary() {
  const qc = useQueryClient();
  const setting = useQuery({ queryKey: ["weekly"], queryFn: api.weekly });
  const save = useMutation({ mutationFn: api.setWeekly, onSuccess: (data) => qc.setQueryData(["weekly"], data) });
  const s = setting.data;
  if (!s) return null;
  return (
    <section className="card" aria-labelledby="weekly-title">
      <div className="card-body gap-3">
        <h2 id="weekly-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--calendar-week] size-5 text-primary" />
          Weekly summary
        </h2>
        <p className="text-sm text-base-content/70">
          Once a week, everything in the bell — not just what's urgent: possible recalls, coverage gaps, claims waiting, things to name, what's lent
          out. It comes where your reminders do{s.canEmail ? ", and by email if you like" : ""}.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label-text" htmlFor="weekly-day">
              Send it on
            </label>
            <select
              id="weekly-day"
              className="select w-48"
              value={s.day ?? ""}
              onChange={(e) => save.mutate({ day: e.target.value === "" ? null : Number(e.target.value), email: s.email })}
            >
              <option value="">Don't send one</option>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          {s.canEmail && s.day !== null && (
            <label className="flex h-11 cursor-pointer items-center gap-2">
              <input type="checkbox" className="checkbox checkbox-primary" checked={s.email} onChange={(e) => save.mutate({ day: s.day, email: e.target.checked })} />
              Also by email
            </label>
          )}
        </div>
        {save.isError && <p className="text-sm text-error">{save.error.message}</p>}
      </div>
    </section>
  );
}
