/**
 * WarrantyList (#/warranties — the dashboard's Warranties card, Insurance in the menu): every warranty in the household,
 * ending soon first, then the ones still covering something, then the ones that have ended (folded); claims still
 * open on top. Each row opens its item, where warranties are added and changed (Warranties.tsx).
 */
import type { Warranty, WarrantyClaim } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { CLAIM_STATUS } from "./Claims";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { TopBar } from "./Nav";
import { daysLeft } from "./Overview";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

type Row = Warranty & { itemName: string };

const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function WarrantyList({ householdId }: { householdId: string }) {
  const warranties = useQuery({ queryKey: ["warranties", householdId], queryFn: api.allWarranties });
  const claims = useQuery({ queryKey: ["claims", householdId, "open"], queryFn: () => api.listClaims({ open: true }) });
  const all = warranties.data?.data ?? [];
  const ending = all.filter((w) => w.status === "expiring");
  const covered = all.filter((w) => w.status === "active");
  // Ended: most recent first.
  const ended = all.filter((w) => w.status === "expired").reverse();
  const open = claims.data?.data ?? [];

  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar
        title={<Trans>Warranties</Trans>}
        back="#/"
        help={<HelpLink page="guide/warranties.html" label={t`Warranties`} />}
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {warranties.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {warranties.isError && <div className="alert alert-soft alert-error">{warranties.error.message}</div>}
        {warranties.data && all.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--shield-check] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>No warranties yet</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70">
                <Trans>Add one from a thing's page, under Warranties. Upload a receipt or warranty card and Ferret suggests the dates for you.</Trans>
              </p>
            </div>
          </div>
        )}

        {all.length > 0 && ending.length + covered.length === 0 && (
          <p className="px-1 text-sm text-base-content/70"><Trans>Nothing's under warranty right now. Add one from a thing's page, under Warranties.</Trans></p>
        )}
        {open.length > 0 && (
          <Group title={t`Claims in progress`} count={open.length} badge="badge-info">
            {open.map((c) => (
              <ClaimRow key={c.id} claim={c} />
            ))}
          </Group>
        )}
        {ending.length > 0 && (
          <Group title={t`Ending in the next 60 days`} count={ending.length} badge="badge-warning">
            {ending.map((w) => (
              <WarrantyRow key={w.id} w={w} />
            ))}
          </Group>
        )}
        {covered.length > 0 && (
          <Group title={t`Covered`} count={covered.length} badge="badge-success">
            {covered.map((w) => (
              <WarrantyRow key={w.id} w={w} />
            ))}
          </Group>
        )}
        {ended.length > 0 && (
          <details className="card group" open={ending.length + covered.length === 0}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 p-4 font-semibold text-base-content sm:px-6 [&::-webkit-details-marker]:hidden">
              <span className="icon-[tabler--chevron-right] size-4 transition-transform group-open:rotate-90" aria-hidden />
              <Trans>Ended</Trans>
              <span className="badge badge-soft badge-sm badge-neutral">{ended.length}</span>
            </summary>
            <ul className="divide-y divide-base-content/10 px-4 pb-2 sm:px-6">
              {ended.map((w) => (
                <WarrantyRow key={w.id} w={w} />
              ))}
            </ul>
          </details>
        )}
      </main>
    </div>
  );
}

function Group(props: { title: string; count: number; badge: string; children: React.ReactNode }) {
  const id = `group-${props.title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-body gap-2 p-4 sm:p-6">
        <h2 id={id} className="flex items-center gap-2 font-semibold text-base-content">
          {props.title}
          <span className={`badge badge-soft badge-sm ${props.badge}`}>{props.count}</span>
        </h2>
        <ul className="divide-y divide-base-content/10">{props.children}</ul>
      </div>
    </section>
  );
}

function WarrantyRow({ w }: { w: Row }) {
  const ended = w.status === "expired";
  return (
    <li>
      <a href={itemHref(w.itemId)} className="-mx-2 flex min-h-11 items-center gap-3 rounded-field px-2 py-3 hover:bg-base-200">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-base-content">{w.itemName}</span>
          <span className="block truncate text-sm text-base-content/70">{[w.provider, w.coverage].filter(Boolean).join(" · ") || t`Warranty`}</span>
          <span className="block text-xs text-base-content/70">
            {ended ? t`Ended` : t`Ends`} {formatDate(w.endsOn)}
          </span>
        </span>
        {w.status === "expiring" && <span className="badge badge-soft badge-warning">{daysLeft(w.endsOn)}</span>}
      </a>
    </li>
  );
}

function ClaimRow({ claim: c }: { claim: WarrantyClaim }) {
  return (
    <li>
      <a href={itemHref(c.itemId)} className="-mx-2 flex min-h-11 items-center gap-3 rounded-field px-2 py-3 hover:bg-base-200">
        <span className="icon-[tabler--file-alert] size-5 shrink-0 text-base-content/70" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-base-content">{c.itemName}</span>
          <span className="block truncate text-sm text-base-content/70">{c.problem}</span>
          <span className="block truncate text-xs text-base-content/70">
            {[c.warrantyProvider, c.reference && `#${c.reference}`, `filed ${formatDate(c.filedOn)}`].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className={`badge badge-soft ${CLAIM_STATUS[c.status].badge}`}>{t(CLAIM_STATUS[c.status].label)}</span>
      </a>
    </li>
  );
}
