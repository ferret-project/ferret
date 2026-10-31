/**
 * Warranty claims on an item's page: each warranty lists its claims with their
 * status, and the dialog files a new one or follows one to its end (claim
 * number, status, what happened, what it cost). FlyonUI badges + the Modal form.
 */
import type { ClaimInput, ClaimStatus, Warranty, WarrantyClaim } from "@ferret/shared";
import { claimStatuses } from "@ferret/shared/utils";
import { today } from "@ferret/shared/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { DialogActions, Modal } from "./Modal";
import { money } from "./Overview";

export const CLAIM_STATUS: Record<ClaimStatus, { label: string; badge: string }> = {
  filed: { label: "Filed", badge: "badge-info" },
  in_progress: { label: "In progress", badge: "badge-warning" },
  approved: { label: "Approved", badge: "badge-success" },
  denied: { label: "Denied", badge: "badge-error" },
  resolved: { label: "Resolved", badge: "badge-neutral" },
};

const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** A warranty's claims, under it on the item page. */
export function ClaimList({ claims, onOpen }: { claims: WarrantyClaim[]; onOpen: (c: WarrantyClaim) => void }) {
  if (!claims.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 border-t border-base-content/10 pt-2">
      {claims.map((c) => (
        <li key={c.id}>
          <button type="button" className="flex w-full items-start gap-2 rounded-field p-1 text-start hover:bg-base-200" onClick={() => onOpen(c)}>
            <span className="icon-[tabler--file-alert] mt-0.5 size-4 shrink-0 text-base-content/70" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-base-content">{c.problem}</span>
              <span className="block text-xs text-base-content/70">
                {[`Filed ${formatDate(c.filedOn)}`, c.reference && `#${c.reference}`, c.resolution].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className={`badge badge-soft badge-sm shrink-0 ${CLAIM_STATUS[c.status].badge}`}>{CLAIM_STATUS[c.status].label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** File a claim under `warranty`, or follow up `claim`. */
export function ClaimDialog(props: { householdId: string; itemId: string; warranty?: Warranty; claim?: WarrantyClaim; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const c = props.claim;
  const [status, setStatus] = useState<ClaimStatus>(c?.status ?? "filed");
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["claims", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["overview", props.householdId] }),
      qc.invalidateQueries({ queryKey: ["attention", props.householdId] }),
    ]);
  const save = useMutation({
    mutationFn: (input: ClaimInput) => (c ? api.updateClaim(c.id, input) : api.fileClaim(props.warranty!.id, input)),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteClaim(c!.id),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim() || null;
    const cost = Number.parseFloat(String(f.get("cost") || "").replace(/[$,\s]/g, ""));
    save.mutate({
      problem: String(f.get("problem")).trim(),
      filedOn: text("filedOn") ?? today(),
      reference: text("reference"),
      status,
      resolution: text("resolution"),
      resolvedOn: text("resolvedOn"),
      costCents: Number.isFinite(cost) ? Math.round(cost * 100) : null,
      notes: text("notes"),
    });
  }
  const closed = status === "denied" || status === "resolved";
  const provider = c?.warrantyProvider ?? props.warranty?.provider;
  return (
    <Modal id="claim-dialog" title={c ? "Warranty claim" : `File a claim${provider ? ` with ${provider}` : ""}`} onClose={props.onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <fieldset className="space-y-4" disabled={!props.canEdit}>
          <div>
            <label className="label-text" htmlFor="claim-problem">
              What went wrong
            </label>
            <textarea id="claim-problem" name="problem" className="textarea" rows={2} defaultValue={c?.problem} maxLength={2000} required autoFocus={!c} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label-text" htmlFor="claim-filed">
                Filed on
              </label>
              <input id="claim-filed" name="filedOn" type="date" className="input" defaultValue={c?.filedOn ?? today()} max={today()} />
            </div>
            <div>
              <label className="label-text" htmlFor="claim-reference">
                Claim number
              </label>
              <input id="claim-reference" name="reference" className="input" defaultValue={c?.reference ?? ""} maxLength={120} placeholder="from the provider" />
            </div>
          </div>
          <div>
            <label className="label-text" htmlFor="claim-status">
              Status
            </label>
            <select id="claim-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as ClaimStatus)}>
              {claimStatuses.map((s) => (
                <option key={s} value={s}>
                  {CLAIM_STATUS[s].label}
                </option>
              ))}
            </select>
          </div>
          {(c || closed) && (
            <>
              <div>
                <label className="label-text" htmlFor="claim-resolution">
                  What happened
                </label>
                <input id="claim-resolution" name="resolution" className="input" defaultValue={c?.resolution ?? ""} maxLength={2000} placeholder="e.g. Motor replaced under warranty" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label-text" htmlFor="claim-resolved">
                    Closed on
                  </label>
                  <input id="claim-resolved" name="resolvedOn" type="date" className="input" defaultValue={c?.resolvedOn ?? ""} />
                </div>
                <div>
                  <label className="label-text" htmlFor="claim-cost">
                    It cost us
                  </label>
                  <div className="input">
                    <span className="my-auto me-1 text-base-content/70">$</span>
                    <input
                      id="claim-cost"
                      name="cost"
                      className="grow"
                      inputMode="decimal"
                      defaultValue={c?.costCents != null ? (c.costCents / 100).toFixed(2) : ""}
                      placeholder="deductible, shipping…"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
          <div>
            <label className="label-text" htmlFor="claim-notes">
              Notes
            </label>
            <textarea id="claim-notes" name="notes" className="textarea" rows={2} defaultValue={c?.notes ?? ""} maxLength={5000} placeholder="Who you spoke to, what they asked for…" />
          </div>
          {c?.costCents ? <p className="text-sm text-base-content/70">Cost so far: {money(c.costCents)}</p> : null}
        </fieldset>
        {(save.isError || remove.isError) && <div className="alert alert-soft alert-error">{save.error?.message ?? remove.error?.message}</div>}
        {props.canEdit && c && (
          <div className="border-t border-base-300 pt-4">
            <button
              type="button"
              className="btn btn-text btn-error"
              disabled={remove.isPending}
              onClick={() => window.confirm("Remove this claim?") && remove.mutate()}
            >
              <span className="icon-[tabler--trash] size-5" />
              Remove
            </button>
          </div>
        )}
        {props.canEdit && (
          <DialogActions>
            <button type="button" className="btn btn-secondary btn-soft" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending && <span className="loading loading-spinner loading-sm" />}
              {c ? "Save" : "File claim"}
            </button>
          </DialogActions>
        )}
      </form>
    </Modal>
  );
}
