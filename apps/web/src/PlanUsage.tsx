/**
 * Settings → Plan & usage (server: lib/plan.ts, GET /api/v1/plan): this period's AI actions, barcode lookups, things,
 * files and people — by person — and, when the server sells plans, the household's plan with its limits and the
 * service's own Upgrade / Manage billing pages. A home Ferret has no plan: the same numbers, nothing limited.
 */
import type { PlanMeter, PlanReport } from "@ferret/shared";
import { PLAN_FEATURE_NAMES, type PlanFeature } from "@ferret/shared/utils";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { settingsHref } from "./lib/route";
import { HelpLink } from "./HelpLink";

/** The household's plan and usage (also read by the search box: no Ask without AI). */
export function usePlan(householdId: string) {
  return useQuery({ queryKey: ["plan", householdId], queryFn: api.plan, staleTime: 60_000 });
}

/** Whether the household's plan has `feature` — yes without a plan (a home Ferret), and until the plan has loaded. */
export function usePlanFeature(householdId: string, feature: PlanFeature) {
  const plan = usePlan(householdId).data?.plan;
  return { on: plan ? plan.limits[feature] : true, planName: plan?.name ?? "" };
}

/** Where a feature the plan leaves out would be: what was made before is kept (paused), and where the plans are. */
export function NotInPlan({ feature, planName }: { feature: PlanFeature; planName: string }) {
  return (
    <div className="alert alert-soft alert-warning flex flex-wrap items-center gap-3" role="status">
      <span className="icon-[tabler--lock] size-5 shrink-0" />
      <span className="min-w-0 grow basis-60">
        {PLAN_FEATURE_NAMES[feature]} aren't part of the {planName} plan. Anything you made before is kept — paused — and works
        again on a plan that has them.
      </span>
      <a href={settingsHref("plan")} className="btn btn-sm btn-primary">
        See plans
      </a>
    </div>
  );
}

const number = (n: number) => n.toLocaleString();
const bytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} bytes`;

/** "Oct 3 – Nov 3", or "October 2026" for a calendar month. */
function periodLabel(period: PlanReport["period"]) {
  if (!period.end) {
    const [y, m] = period.start.split("-").map(Number);
    return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  }
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day(period.start)} – ${day(period.end)}`;
}

function Meter({ label, icon, meter, format = number }: { label: string; icon: string; meter: PlanMeter; format?: (n: number) => string }) {
  const { used, limit } = meter;
  const share = limit ? Math.min(1, used / limit) : 0;
  const tone = limit === null ? "" : share >= 1 ? "progress-error" : share >= 0.8 ? "progress-warning" : "progress-primary";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="flex items-center gap-2 font-medium">
          <span className={`${icon} size-5 text-primary`} />
          {label}
        </span>
        <span className="text-sm text-base-content/70">
          {limit === null ? format(used) : limit === 0 ? "Not in this plan" : `${format(used)} of ${format(limit)}`}
        </span>
      </div>
      {limit !== null && limit > 0 && (
        <progress className={`progress ${tone}`} value={Math.round(share * 100)} max={100} aria-label={`${label}: ${format(used)} of ${format(limit)}`} />
      )}
    </div>
  );
}

export function PlanUsage({ householdId, isOwner }: { householdId: string; isOwner: boolean }) {
  const report = usePlan(householdId);
  const r = report.data;
  return (
    <>
      {r?.plan && (
        <section className="card" aria-labelledby="plan-title">
          <div className="card-body gap-3">
            <h2 id="plan-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--rosette-discount-check] size-5 text-primary" />
              {r.plan.name} plan
            </h2>
            <p className="text-sm text-base-content/70">
              {r.plan.limits.ai ? "Includes AI: photo suggestions, Ask Ferret, documents read and search by meaning." : "Search by words; no AI."}
              {r.period.end && ` This month's AI actions and lookups start again on ${new Date(`${r.period.end}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" })}.`}
            </p>
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {(Object.keys(PLAN_FEATURE_NAMES) as PlanFeature[]).map((f) => (
                <li key={f} className={`flex items-center gap-1.5 ${r.plan!.limits[f] ? "" : "text-base-content/70"}`}>
                  <span className={`${r.plan!.limits[f] ? "icon-[tabler--check] text-success" : "icon-[tabler--x]"} size-4 shrink-0`} aria-hidden />
                  {PLAN_FEATURE_NAMES[f]}
                  {!r.plan!.limits[f] && <span className="sr-only">(not in this plan)</span>}
                </li>
              ))}
            </ul>
            {r.plan.status && (
              <div className="alert alert-soft alert-info text-sm" role="status">
                <span className="icon-[tabler--info-circle] size-5 shrink-0" />
                {r.plan.status}
              </div>
            )}
            {isOwner && (r.plan.upgradeUrl || r.plan.manageUrl || r.plan.links.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {r.plan.upgradeUrl && (
                  <a href={r.plan.upgradeUrl} className="btn btn-primary btn-wrap">
                    <span className="icon-[tabler--arrow-up-circle] size-5" />
                    Upgrade
                  </a>
                )}
                {r.plan.manageUrl && (
                  <a href={r.plan.manageUrl} className="btn btn-soft btn-primary btn-wrap">
                    <span className="icon-[tabler--credit-card] size-5" />
                    Manage billing
                  </a>
                )}
                {r.plan.links.map((l) => (
                  <a key={l.url} href={l.url} className="btn btn-soft btn-primary btn-wrap">
                    <span className="icon-[tabler--external-link] size-5" />
                    {l.label}
                  </a>
                ))}
              </div>
            )}
            {!isOwner && <p className="text-sm text-base-content/70">The household's owner manages its plan.</p>}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="usage-title">
        <div className="card-body gap-4">
          <div className="flex items-center justify-between gap-2">
            <h2 id="usage-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--gauge] size-5 text-primary" />
              Usage{r && <span className="font-normal text-base-content/70"> · {periodLabel(r.period)}</span>}
            </h2>
            <HelpLink page="guide/plan-and-usage" label="Plan & usage" />
          </div>
          {report.isError && <div className="alert alert-soft alert-error text-sm">{report.error.message}</div>}
          {report.isPending && <span className="loading loading-spinner loading-sm" aria-label="Loading" />}
          {r && (
            <>
              {!r.plan && <p className="text-sm text-base-content/70">Nothing is limited on this server — these are just this month's numbers.</p>}
              <div className="@container">
                <div className="grid gap-4 @lg:grid-cols-2">
                  <Meter label="AI actions" icon="icon-[tabler--sparkles]" meter={r.aiActions} />
                  <Meter label="Things" icon="icon-[tabler--box]" meter={r.items} />
                  <Meter label="Photos and files" icon="icon-[tabler--photo]" meter={r.fileBytes} format={bytes} />
                  <Meter label="People" icon="icon-[tabler--users]" meter={r.members} />
                  {r.barcodeLookups && <Meter label="Barcode lookups" icon="icon-[tabler--barcode]" meter={r.barcodeLookups} />}
                </div>
              </div>
              <p className="text-xs text-base-content/70">A photo's suggestions count as 2 AI actions; a question to Ask Ferret or a document read, 1.</p>
            </>
          )}
        </div>
      </section>

      {r && r.people.length > 0 && (
        <section className="card" aria-labelledby="by-person-title">
          <div className="card-body gap-3">
            <h2 id="by-person-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--user] size-5 text-primary" />
              By person
            </h2>
            <ul className="divide-y divide-base-300">
              {r.people.map((p) => (
                <li key={p.userId ?? "background"} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-sm text-base-content/70">
                    {[
                      `${number(p.aiActions)} AI ${p.aiActions === 1 ? "action" : "actions"}`,
                      p.photos && `${number(p.photos)} ${p.photos === 1 ? "photo" : "photos"}`,
                      p.asks && `${number(p.asks)} ${p.asks === 1 ? "question" : "questions"}`,
                      p.documents && `${number(p.documents)} ${p.documents === 1 ? "document" : "documents"}`,
                      p.barcodeLookups && `${number(p.barcodeLookups)} barcode ${p.barcodeLookups === 1 ? "lookup" : "lookups"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  );
}
