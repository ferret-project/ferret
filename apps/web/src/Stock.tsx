import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * An item's stock (scan to count, server lib/stock.ts): its count with − / +, what scanning its codes does (its
 * barcode, its QR label, a pack's barcode…), and the history of changes with Undo. Items that aren't tracked show a
 * "Track stock" button instead, so a TV's page stays quiet.
 */
import type { StockBehaviour, StockMovement, StockRule } from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";
import { Scanner } from "./Scanner";

const BEHAVIOURS: { value: StockBehaviour; label: string }[] = [
  { value: "use", get label() { return translateText("Use (take out)"); } },
  { value: "restock", get label() { return translateText("Restock (put in)"); } },
  { value: "ask", get label() { return translateText("Ask each time"); } },
  { value: "lookup", get label() { return translateText("Just open it"); } },
];

const REASONS: Record<StockMovement["reason"], string> = {
  scan: "scanned",
  get manual() { return translateText("by hand"); },
  edit: "edited",
  undo: "undo",
  maintenance: "maintenance",
};

export function StockCard({
  item,
  householdId,
  canEdit,
}: {
  item: { id: string; name: string; barcode?: string | null; labelCode: string | null; minQuantity?: number | null };
  householdId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const key = ["stock", householdId, item.id];
  const stock = useQuery({ queryKey: key, queryFn: () => api.stock(item.id) });
  const [open, setOpen] = useState(false);
  const refresh = () => {
    for (const k of ["stock", "item", "shopping", "attention", "overview"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
  };
  const adjust = useMutation({ mutationFn: (delta: number) => api.adjustStock(item.id, delta), onSuccess: refresh });
  const undo = useMutation({ mutationFn: api.undoStock, onSuccess: refresh });

  const s = stock.data;
  if (!s) return null;
  const tracking = open || s.rules.length > 0 || s.movements.length > 0 || item.minQuantity != null;
  if (!tracking) {
    return canEdit ? (
      <div>
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setOpen(true)}>
          <span className="icon-[tabler--stack-2] size-4" />
          {translateText("Track stock")}</button>
      </div>
    ) : null;
  }
  const error = adjust.error ?? undo.error;

  return (
    <section className="card" aria-labelledby="stock-title">
      <div className="card-body gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="stock-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--stack-2] size-5 text-primary" />
            {translateText("Stock")}<HelpLink page="guide/stock.html" label={translateText("Stock")} />
          </h2>
          <div className="flex items-center gap-2" aria-live="polite">
            {canEdit && (
              <button type="button" className="btn btn-soft btn-square" aria-label={translateText("Use one {v0}", { v0: item.name })} disabled={adjust.isPending || s.quantity === 0} onClick={() => adjust.mutate(-1)}>
                <span className="icon-[tabler--minus] size-5" />
              </button>
            )}
            <span className="min-w-12 text-center text-2xl font-semibold tabular-nums" aria-label={translateText("{v0} left", { v0: s.quantity })}>
              {s.quantity}
            </span>
            {canEdit && (
              <button type="button" className="btn btn-soft btn-square" aria-label={translateText("Add one {v0}", { v0: item.name })} disabled={adjust.isPending} onClick={() => adjust.mutate(1)}>
                <span className="icon-[tabler--plus] size-5" />
              </button>
            )}
          </div>
        </div>
        {error && <div className="alert alert-soft alert-error">{error.message}</div>}
        <KeepAtLeast itemId={item.id} value={item.minQuantity ?? null} quantity={s.quantity} canEdit={canEdit} onChanged={refresh} />

        <Codes item={item} rules={s.rules} canEdit={canEdit} onChanged={refresh} />

        {s.movements.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{translateText("History")}</h3>
            <ul className="divide-y divide-base-content/10 text-sm">
              {s.movements.slice(0, 10).map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                  <span className={`w-10 font-semibold tabular-nums ${m.undone ? "text-base-content/70 line-through" : m.delta < 0 ? "text-error" : "text-success"}`}>
                    {m.delta > 0 ? `+${m.delta}` : `−${-m.delta}`}
                  </span>
                  <span className="min-w-0 flex-1 text-base-content/70">{tr("{v0} left · {v1}", { v0: m.quantityAfter, v1: REASONS[m.reason] })}{m.by ? translateText(" by {v0}", { v0: m.by }) : ""} · {formatWhen(m.at)}
                    {m.note ? ` — ${m.note}` : ""}
                  </span>
                  {canEdit && !m.undone && m.reason !== "undo" && m.reason !== "edit" && (
                    <button type="button" className="btn btn-text btn-xs" disabled={undo.isPending} onClick={() => undo.mutate(m.id)}>
                      {translateText("Undo")}</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** What scanning each of the item's codes does, and adding one (its barcode, its QR label, or any other code). */
function Codes({
  item,
  rules,
  canEdit,
  onChanged,
}: {
  item: { id: string; barcode?: string | null; labelCode: string | null };
  rules: StockRule[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const save = useMutation({ mutationFn: (r: { code: string; behaviour: StockBehaviour; step: number }) => api.setStockRule(item.id, r), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: (ruleId: string) => api.deleteStockRule(item.id, ruleId), onSuccess: onChanged });
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  // Rules keep a 12-digit UPC as its 13-digit EAN: "ends with" matches either spelling.
  const has = (barcode: string) => rules.some((r) => !r.code.startsWith("label:") && r.code.endsWith(barcode.replace(/\D/g, "")));
  const suggestions = [
    item.barcode && !has(item.barcode) ? { code: item.barcode, text: translateText("its barcode ({v0})", { v0: item.barcode }) } : null,
    item.labelCode && !rules.some((r) => r.code === `label:${item.labelCode}`) ? { code: `label:${item.labelCode}`, text: translateText("its QR label ({v0})", { v0: item.labelCode }) } : null,
  ].filter((x): x is { code: string; text: string } => x !== null);

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (code.trim()) save.mutate({ code: code.trim(), behaviour: "use", step: 1 }, { onSuccess: () => setCode("") });
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{translateText("When it's scanned")}</h3>
      {rules.length === 0 && <p className="text-sm text-base-content/70">{translateText("No codes yet — scanning one can count it in or out.")}</p>}
      <ul className="space-y-2">
        {rules.map((r) => (
          <RuleRow key={`${r.id}-${r.behaviour}-${r.step}`} rule={r} canEdit={canEdit} busy={save.isPending || remove.isPending} onSave={(b, step) => save.mutate({ code: r.code, behaviour: b, step })} onRemove={() => remove.mutate(r.id)} />
        ))}
      </ul>
      {canEdit && (
        <>
          {suggestions.map((sug) => (
            <button key={sug.code} type="button" className="btn btn-soft btn-primary btn-sm btn-wrap" disabled={save.isPending} onClick={() => save.mutate({ code: sug.code, behaviour: "use", step: 1 })}>
              <span className="icon-[tabler--plus] size-4" />{tr("Count with {v0}", { v0: sug.text })}</button>
          ))}
          <form className="flex flex-wrap items-end gap-2" onSubmit={onAdd}>
            <div className="min-w-0 grow">
              <label className="label-text" htmlFor={`stock-code-${item.id}`}>
                {translateText("Another code (a pack's barcode, a bin's label…)")}</label>
              <div className="input">
                <input id={`stock-code-${item.id}`} className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder={translateText("Type or scan it")} inputMode="text" />
                <button type="button" className="btn btn-text btn-sm btn-square my-auto" aria-label={translateText("Scan it")} onClick={() => setScanning(true)}>
                  <span className="icon-[tabler--barcode] size-5" />
                </button>
              </div>
            </div>
            <button type="submit" className="btn btn-soft btn-primary" disabled={!code.trim() || save.isPending}>
              {translateText("Add")}</button>
          </form>
        </>
      )}
      {(save.error ?? remove.error) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
      {scanning && (
        <Scanner
          onResult={(c) => {
            setScanning(false);
            setCode(c);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}

/** "Keep at least N": at or below it, the item goes on the shopping list. Blank = only when it runs out. */
function KeepAtLeast({ itemId, value, quantity, canEdit, onChanged }: { itemId: string; value: number | null; quantity: number; canEdit: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const save = useMutation({ mutationFn: (minQuantity: number | null) => api.updateItem(itemId, { minQuantity }), onSuccess: onChanged });
  const parsed = draft.trim() === "" ? null : Math.max(0, Math.floor(Number(draft)));
  const dirty = parsed !== value && (parsed === null || Number.isFinite(parsed));
  const low = value != null ? quantity <= value : quantity === 0;
  if (!canEdit) {
    return value != null ? <p className="text-sm text-base-content/70">{tr("Keep at least {v0}", { v0: value })}{low ? translateText(" — on the shopping list") : ""}</p> : null;
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate(parsed);
      }}
    >
      <label htmlFor={`keep-${itemId}`}>{translateText("Keep at least")}</label>
      <input
        id={`keep-${itemId}`}
        type="number"
        min={0}
        max={100000}
        inputMode="numeric"
        className="input input-sm w-20"
        placeholder="—"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {dirty ? (
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
          {translateText("Save")}</button>
      ) : (
        <span className="text-base-content/70">
          {low ? translateText("On the shopping list") : value != null ? translateText("On the shopping list at or below this") : translateText("On the shopping list when it runs out")}
        </span>
      )}
      {save.isError && <span className="w-full text-error">{save.error.message}</span>}
    </form>
  );
}

function RuleRow({ rule, canEdit, busy, onSave, onRemove }: { rule: StockRule; canEdit: boolean; busy: boolean; onSave: (b: StockBehaviour, step: number) => void; onRemove: () => void }) {
  const [behaviour, setBehaviour] = useState(rule.behaviour);
  const [step, setStep] = useState(rule.step);
  const [confirming, setConfirming] = useState(false);
  const dirty = behaviour !== rule.behaviour || step !== rule.step;
  if (!canEdit) {
    return (
      <li className="text-sm">
        <span className="font-medium">{rule.label}</span> — {BEHAVIOURS.find((b) => b.value === rule.behaviour)?.label}
        {rule.behaviour !== "lookup" ? translateText(", {v0} at a time", { v0: rule.step }) : ""}
      </li>
    );
  }
  return (
    <li className="rounded-box border border-base-content/10 p-2">
      <p className="mb-2 truncate text-sm font-medium">{rule.label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="select select-sm w-auto grow" aria-label={translateText("What scanning {v0} does", { v0: rule.label })} value={behaviour} onChange={(e) => setBehaviour(e.target.value as StockBehaviour)}>
          {BEHAVIOURS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        {behaviour !== "lookup" && (
          <label className="flex items-center gap-1 text-sm">
            <input
              type="number"
              min={1}
              max={1000}
              className="input input-sm w-20"
              aria-label={translateText("How many at a time")}
              value={step}
              onChange={(e) => setStep(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
            />
            {translateText("at a time")}</label>
        )}
        {dirty && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onSave(behaviour, step)}>
            {translateText("Save")}</button>
        )}
        {confirming ? (
          <span className="flex items-center gap-1">
            <button type="button" className="btn btn-error btn-sm" disabled={busy} onClick={onRemove}>
              {translateText("Remove")}</button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(false)}>
              {translateText("Keep")}</button>
          </span>
        ) : (
          <button type="button" className="btn btn-text btn-sm btn-square btn-error ms-auto" aria-label={translateText("Stop counting with {v0}", { v0: rule.label })} onClick={() => setConfirming(true)}>
            <span className="icon-[tabler--trash] size-5" />
          </button>
        )}
      </div>
    </li>
  );
}

const formatWhen = (iso: string) => new Date(iso).toLocaleString(locale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
