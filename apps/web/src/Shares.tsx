/**
 * Share links (server: lib/shares.ts), for the household's owner and admins:
 * - ShareButton → ShareDialog on the insurance report (whole household or one property) and on a tag's or category's
 *   page: who it's for, 7 / 30 / 90 days, photos and receipts or not → the link, to copy or share.
 * - ShareLinks (Settings → Household): every link — still open or not, how often opened (and when, from where),
 *   copy again, turn off.
 * What opens: Shared.tsx.
 */
import type { ShareInput, ShareLinkSummary } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { useRole } from "./lib/auth";
import { inFerretApp } from "./lib/install";
import { DialogActions, Modal } from "./Modal";
import { NotInPlan, usePlanFeature } from "./PlanUsage";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { copyText } from "./lib/secure-context";

type Target = Pick<ShareInput, "kind" | "propertyId" | "tag" | "categoryId">;

const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Owners and admins share; everyone else doesn't see the button. */
function useCanShare(householdId: string) {
  const role = useRole(householdId);
  // Share links need a real sign-in: inside the phone app (its own sign-in) there's no button.
  return !inFerretApp && (role === "owner" || role === "admin");
}

export function ShareButton({ householdId, target, what, className = "btn btn-soft btn-primary" }: { householdId: string; target: Target; what: string; className?: string }) {
  const canShare = useCanShare(householdId);
  const [open, setOpen] = useState(false);
  if (!canShare) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="icon-[tabler--share] size-5" />
        <Trans>Share…</Trans>
      </button>
      {open && <ShareDialog householdId={householdId} target={target} what={what} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ householdId, target, what, onClose }: { householdId: string; target: Target; what: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [made, setMade] = useState<ShareLinkSummary | null>(null);
  const create = useMutation({
    mutationFn: api.createShare,
    onSuccess: (link) => {
      setMade(link);
      void qc.invalidateQueries({ queryKey: ["shares", householdId] });
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      ...target,
      label: String(f.get("label") ?? "").trim() || null,
      days: Number(f.get("days")) as 7 | 30 | 90,
      includeFiles: f.get("files") === "on",
    });
  }
  const feature = usePlanFeature(householdId, "shareLinks");
  return (
    <Modal id="share" title={t`Share ${what}`} onClose={onClose}>
      {!feature.on ? (
        <div className="flex flex-col gap-4">
          <NotInPlan feature="shareLinks" planName={feature.planName} />
          <DialogActions>
            <button type="button" className="btn btn-soft" onClick={onClose}>
              <Trans>Close</Trans>
            </button>
          </DialogActions>
        </div>
      ) : made ? (
        <div className="flex flex-col gap-4">
          <p>
            <Trans>Anyone with this link can see {what} — read-only, no account — until {ph({ longDate: longDate(made.expiresAt) })}. You can turn it off any time in Settings →
            Household.</Trans>
          </p>
          <LinkField url={made.url} />
          <p className="text-sm text-base-content/70">
            <Trans>It opens only where Ferret can be reached: if Ferret is on your home network only, the person needs to be on it (or your VPN) too.</Trans>
          </p>
          <DialogActions>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              <Trans>Done</Trans>
            </button>
          </DialogActions>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <p className="text-base-content/80">
            <Trans>A read-only link to {what}, for someone without an account — an insurer, an adjuster, an executor. It shows things as they are when it's
            opened, never your notes, and every opening is logged.</Trans>
          </p>
          <div>
            <label className="label-text" htmlFor="share-label">
              <Trans>Who it's for (just for you)</Trans>
            </label>
            <input id="share-label" name="label" className="input" maxLength={80} placeholder={t`e.g. State Farm claim`} autoFocus />
          </div>
          <div>
            <label className="label-text" htmlFor="share-days">
              <Trans>Works for</Trans>
            </label>
            <select id="share-days" name="days" className="select" defaultValue="30">
              <option value="7">{t`7 days`}</option>
              <option value="30">{t`30 days`}</option>
              <option value="90">{t`90 days`}</option>
            </select>
          </div>
          <label className="flex cursor-pointer items-start gap-3">
            <input type="checkbox" name="files" className="switch switch-primary mt-0.5" defaultChecked />
            <span>
              <Trans>Photos, receipts and manuals too
              <span className="block text-sm text-base-content/70">The proof an insurer asks for. Off: just the list.</span></Trans>
            </span>
          </label>
          {create.isError && <div className="alert alert-soft alert-error">{create.error.message}</div>}
          <DialogActions>
            <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
              <Trans>Cancel</Trans>
            </button>
            <button type="submit" className="btn btn-primary" disabled={create.isPending}>
              {create.isPending && <span className="loading loading-spinner loading-sm" />}
              <Trans>Make the link</Trans>
            </button>
          </DialogActions>
        </form>
      )}
    </Modal>
  );
}

function LinkField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === "function";
  async function copy() {
    await copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="flex flex-col gap-2">
      <input className="input font-mono text-sm" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={t`The link`} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-soft btn-sm" onClick={() => void copy()}>
          <span className={`${copied ? "icon-[tabler--check]" : "icon-[tabler--copy]"} size-4`} />
          {copied ? t`Copied` : t`Copy link`}
        </button>
        {canShare && (
          <button type="button" className="btn btn-soft btn-sm" onClick={() => void navigator.share({ url }).catch(() => {})}>
            <span className="icon-[tabler--share] size-4" />
            <Trans>Send…</Trans>
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings → Household: every share link, open or not. */
export function ShareLinks({ householdId }: { householdId: string }) {
  const canShare = useCanShare(householdId);
  const qc = useQueryClient();
  const links = useQuery({ queryKey: ["shares", householdId], queryFn: api.shares, enabled: canShare });
  const [showing, setShowing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: api.revokeShare,
    onSuccess: () => {
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ["shares", householdId] });
    },
  });
  const feature = usePlanFeature(householdId, "shareLinks");
  if (!canShare) return null;
  const rows = links.data?.data ?? [];
  return (
    <section className="card" aria-labelledby="share-links">
      <div className="card-body gap-3">
        <h2 id="share-links" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--share] size-5 text-primary" />
          <Trans>Share links</Trans>
          <HelpLink page="guide/sharing.html" label={t`Share links`} />
        </h2>
        {!feature.on && <NotInPlan feature="shareLinks" planName={feature.planName} />}
        {!rows.length ? (
          <p className="text-sm text-base-content/70">
            <Trans>None yet. Share the insurance report (Report → Share…), or a tag's or category's things, with someone who has no account.</Trans>
          </p>
        ) : (
          <ul className="divide-y divide-base-content/10">
            {rows.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium">
                      {l.title}
                      {l.label && <span className="font-normal text-base-content/70"> — {l.label}</span>}
                    </p>
                    <p className="text-sm text-base-content/70">
                      {l.active ? t`Open until ${ph({ longDate: longDate(l.expiresAt) })}` : l.revokedAt ? t`Turned off ${ph({ longDate: longDate(l.revokedAt) })}` : t`Ran out ${ph({ longDate: longDate(l.expiresAt) })}`}
                      {" · "}
                      {l.views ? (
                        <button type="button" className="link tap" onClick={() => setShowing(showing === l.id ? null : l.id)}>
                          {plural(l.views, { one: "opened # time", other: "opened # times" })}
                        </button>
                      ) : (
                        t`not opened yet`
                      )}
                      {l.includeFiles ? t` · with files` : ""}
                    </p>
                  </div>
                  {l.active && (
                    <div className="flex flex-wrap gap-2">
                      <CopyButton url={l.url} />
                      {confirming === l.id ? (
                        <>
                          <button type="button" className="btn btn-error btn-sm" disabled={revoke.isPending} onClick={() => revoke.mutate(l.id)}>
                            <Trans>Turn off</Trans>
                          </button>
                          <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(null)}>
                            <Trans>Keep</Trans>
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(l.id)}>
                          <Trans>Turn off…</Trans>
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {showing === l.id && <Views id={l.id} />}
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && <div className="alert alert-soft alert-error">{revoke.error.message}</div>}
      </div>
    </section>
  );
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-soft btn-sm"
      onClick={() =>
        void copyText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
    >
      <span className={`${copied ? "icon-[tabler--check]" : "icon-[tabler--copy]"} size-4`} />
      {copied ? t`Copied` : t`Copy link`}
    </button>
  );
}

function Views({ id }: { id: string }) {
  const views = useQuery({ queryKey: ["share-views", id], queryFn: () => api.shareViews(id) });
  if (!views.data) return <span className="loading loading-spinner loading-sm" />;
  return (
    <ul className="rounded-box bg-base-200 p-3 text-sm">
      {views.data.data.map((v) => (
        <li key={v.at} className="truncate">
          {new Date(v.at).toLocaleString()} · {v.ipAddress ?? t`unknown address`}
          {v.userAgent ? <span className="text-base-content/70"> · {v.userAgent}</span> : null}
        </li>
      ))}
    </ul>
  );
}
