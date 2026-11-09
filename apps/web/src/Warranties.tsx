import { tn } from "./i18n";
import { locale } from "./i18n";
import { t as translateText } from "./i18n";
/** An item's warranties: what's covered until when, plus a small form to add one. */
import type { Warranty, WarrantyClaim, WarrantyInput } from "@ferret/shared";
import { ClaimList } from "./Claims";
import { addMonths, today } from "@ferret/shared/utils";
import { type FormEvent, useState } from "react";

const statusBadge: Record<Warranty["status"], { label: string; className: string }> = {
  active: { get label() { return translateText("Active"); }, className: "badge-success" },
  expiring: { get label() { return translateText("Ends soon"); }, className: "badge-warning" },
  expired: { get label() { return translateText("Expired"); }, className: "badge-error" },
};

/** "7 months left", "12 days left", "ended 3 months ago". */
function remaining(endsOn: string) {
  const days = Math.round((Date.parse(endsOn) - Date.parse(today())) / 86_400_000);
  const span = (d: number) => (d >= 60 ? translateText("{v0} months", { v0: Math.round(d / 30.4) }) : tn(d, "{count} day", "{count} days"));
  return days >= 0 ? translateText("{v0} left", { v0: span(days) }) : translateText("ended {v0} ago", { v0: span(-days) });
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });

export function Warranties(props: {
  warranties: Warranty[];
  purchaseDate: string | null | undefined;
  /** Left out for viewers: no add/remove controls. */
  onAdd?: (input: WarrantyInput) => void;
  onRemove?: (w: Warranty) => void;
  claims?: WarrantyClaim[];
  /** File a claim under a warranty, or open one. Left out for viewers (they can still read claims). */
  onFileClaim?: (w: Warranty) => void;
  onOpenClaim?: (c: WarrantyClaim) => void;
  busy: boolean;
  error?: string;
}) {
  const [adding, setAdding] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const startsOn = String(form.get("startsOn") || "") || null;
    const months = Number(form.get("months") || 0);
    const endsOn = String(form.get("endsOn") || "") || (startsOn && months ? addMonths(startsOn, months) : "");
    if (!endsOn) return;
    props.onAdd?.({ provider: String(form.get("provider") || "").trim() || null, startsOn, endsOn });
    setAdding(false);
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h2 className="text-base-content flex items-center gap-2 font-semibold">
          <span className="icon-[tabler--shield-check] text-primary size-5" />
          {translateText("Warranties")}</h2>
        {!adding && props.onAdd && (
          <button type="button" className="btn btn-text btn-sm" onClick={() => setAdding(true)}>
            <span className="icon-[tabler--plus] size-4" /> {translateText("Add")}</button>
        )}
      </div>

      {props.warranties.length === 0 && !adding && (
        <p className="text-base-content/70 text-sm">
          {props.onAdd ? translateText("None yet. Add one, or upload the warranty card and Ferret will read it.") : translateText("None yet.")}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {props.warranties.map((w) => (
          <li key={w.id} className="card">
            <div className="card-body gap-0 p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-base-content/80 flex flex-wrap items-center gap-2 text-sm font-medium">
                    {w.provider || translateText("Warranty")}
                    <span className={`badge badge-soft badge-sm ${statusBadge[w.status].className}`}>{statusBadge[w.status].label}</span>
                  </p>
                  <p className="text-base-content/70 text-xs">
                    {w.startsOn ? `${formatDate(w.startsOn)} – ` : translateText("Until ")}
                    {formatDate(w.endsOn)} · {remaining(w.endsOn)}
                  </p>
                </div>
                {props.onRemove && (
                  <button
                    type="button"
                    className="btn btn-circle btn-text btn-sm"
                    aria-label={translateText("Remove {v0} warranty", { v0: w.provider || "" })}
                    disabled={props.busy}
                    onClick={() => props.onRemove?.(w)}
                  >
                    <span className="icon-[tabler--trash] size-4" />
                  </button>
                )}
              </div>
              <ClaimList claims={(props.claims ?? []).filter((c) => c.warrantyId === w.id)} onOpen={(c) => props.onOpenClaim?.(c)} />
              {props.onFileClaim && (
                <button type="button" className="btn btn-text btn-xs mt-1 self-start" onClick={() => props.onFileClaim?.(w)}>
                  <span className="icon-[tabler--file-plus] size-4" />
                  {translateText("File a claim")}</button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {adding && (
        <form onSubmit={onSubmit} className="card">
          <div className="card-body gap-3 p-4">
            <input name="provider" className="input" placeholder={translateText("Provider (e.g. KitchenAid, Geek Squad)")} />
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-base-content/70 text-xs">{translateText("Starts")}</span>
                <input name="startsOn" type="date" className="input" defaultValue={props.purchaseDate ?? ""} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-base-content/70 text-xs">{translateText("Length")}</span>
                <select name="months" className="select" defaultValue="12">
                  <option value="3">{translateText("3 months")}</option>
                  <option value="6">{translateText("6 months")}</option>
                  <option value="12">{translateText("1 year")}</option>
                  <option value="24">{translateText("2 years")}</option>
                  <option value="36">{translateText("3 years")}</option>
                  <option value="60">{translateText("5 years")}</option>
                  <option value="120">{translateText("10 years")}</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-base-content/70 text-xs">{translateText("…or the exact end date")}</span>
              <input name="endsOn" type="date" className="input" />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-text btn-sm" onClick={() => setAdding(false)}>
                {translateText("Cancel")}</button>
              <button className="btn btn-primary btn-sm" disabled={props.busy}>
                {translateText("Save warranty")}</button>
            </div>
          </div>
        </form>
      )}
      {props.error && <div className="alert alert-soft alert-error text-sm">{props.error}</div>}
    </section>
  );
}
