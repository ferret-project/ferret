/**
 * An item's smart-home pairing codes — HomeKit and Matter (server: lib/pairing.ts). Listed without the code; **Show**
 * asks the server for it (logged) and draws its QR again, so the Home app can scan it off this screen when an
 * accessory is reset. Viewers see that a code exists, not the code. Items without one show an "Add pairing code" button.
 */
import type { PairingCodeRevealed, PairingCodeSummary } from "@ferret/shared";
import { parsePairing } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HelpLink } from "./HelpLink";
import { QrCode } from "./Labels";
import { api } from "./lib/api";
import { Scanner } from "./Scanner";

const KIND = { homekit: "HomeKit", matter: "Matter" } as const;

export function PairingCard({ itemId, householdId, canEdit }: { itemId: string; householdId: string; canEdit: boolean }) {
  const key = ["pairing", householdId, itemId];
  const list = useQuery({ queryKey: key, queryFn: () => api.pairing(itemId) });
  const [adding, setAdding] = useState(false);
  const codes = list.data?.data ?? [];
  if (!list.data) return null;
  if (!codes.length && !adding) {
    return canEdit ? (
      <div>
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setAdding(true)}>
          <span className="icon-[tabler--home-link] size-4" />
          HomeKit / Matter code
        </button>
      </div>
    ) : null;
  }
  return (
    <section className="card" aria-labelledby={`pairing-${itemId}`}>
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={`pairing-${itemId}`} className="card-title flex items-center gap-2">
            <span className="icon-[tabler--home-link] size-5 text-primary" />
            Pairing codes
            <HelpLink page="guide/pairing-codes.html" label="Pairing codes" />
          </h2>
          {canEdit && !adding && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => setAdding(true)}>
              <span className="icon-[tabler--plus] size-4" />
              Add
            </button>
          )}
        </div>
        {codes.length > 0 && (
          <ul className="space-y-3">
            {codes.map((p) => (
              <CodeRow key={p.id} itemId={itemId} code={p} canEdit={canEdit} queryKey={key} />
            ))}
          </ul>
        )}
        {adding && <AddCode itemId={itemId} queryKey={key} onDone={() => setAdding(false)} />}
      </div>
    </section>
  );
}

function CodeRow({ itemId, code, canEdit, queryKey }: { itemId: string; code: PairingCodeSummary; canEdit: boolean; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const [shown, setShown] = useState<PairingCodeRevealed | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const reveal = useMutation({ mutationFn: () => api.revealPairing(itemId, code.id), onSuccess: setShown });
  const remove = useMutation({ mutationFn: () => api.deletePairing(itemId, code.id), onSuccess: () => qc.invalidateQueries({ queryKey }) });
  const title = code.label || code.category || `${KIND[code.kind]} code`;
  const sub = [KIND[code.kind], code.label ? code.category : null, `added ${new Date(code.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`]
    .filter(Boolean)
    .join(" · ");

  async function copy() {
    if (!shown) return;
    await navigator.clipboard.writeText(shown.code.replace(/-/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li className="rounded-box border border-base-content/10 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`${code.kind === "homekit" ? "icon-[tabler--brand-apple]" : "icon-[tabler--home-signal]"} size-6 shrink-0 text-base-content/70`} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{title}</p>
          <p className="text-sm text-base-content/70">{sub}</p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {shown ? (
              <button type="button" className="btn btn-soft btn-sm" onClick={() => setShown(null)}>
                <span className="icon-[tabler--eye-off] size-4" />
                Hide
              </button>
            ) : (
              <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={reveal.isPending} onClick={() => reveal.mutate()}>
                <span className="icon-[tabler--eye] size-4" />
                Show
              </button>
            )}
            {confirming ? (
              <>
                <button type="button" className="btn btn-error btn-sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  Remove
                </button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-text btn-sm btn-square btn-error" aria-label={`Remove the ${KIND[code.kind]} code for ${title}`} onClick={() => setConfirming(true)}>
                <span className="icon-[tabler--trash] size-5" />
              </button>
            )}
          </div>
        )}
      </div>
      {(reveal.error ?? remove.error) && <p className="mt-2 text-sm text-error">{(reveal.error ?? remove.error)!.message}</p>}
      {shown && (
        <div className="mt-3 flex flex-wrap items-center gap-4">
          {shown.payload && (
            <div className="w-40 shrink-0 rounded-box bg-white p-2">
              <QrCode value={shown.payload} className="w-full" />
            </div>
          )}
          <div className="min-w-0 space-y-2">
            <p className="font-mono text-2xl font-semibold tracking-wider tabular-nums" aria-label={`Setup code ${shown.code.split("").join(" ")}`}>
              {shown.code}
            </p>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => void copy()}>
              <span className={`${copied ? "icon-[tabler--check]" : "icon-[tabler--copy]"} size-4`} />
              {copied ? "Copied" : "Copy code"}
            </button>
            <p className="text-sm text-base-content/70">
              {shown.payload ? "In the Home app: Add Accessory, then point the camera at this QR code — or type the code." : "In the Home app: Add Accessory → More options, and type the code."}
            </p>
          </div>
        </div>
      )}
    </li>
  );
}

function AddCode({ itemId, queryKey, onDone }: { itemId: string; queryKey: unknown[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [scanning, setScanning] = useState(false);
  const info = code.trim() ? parsePairing(code) : null;
  const add = useMutation({
    mutationFn: () => api.addPairing(itemId, { code: code.trim(), label: label.trim() || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      onDone();
    },
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (info) add.mutate();
  }
  return (
    <form className="space-y-3 rounded-box bg-base-200 p-3" onSubmit={onSubmit}>
      <div>
        <label className="label-text" htmlFor={`pair-code-${itemId}`}>
          Its QR code, or the code as printed
        </label>
        <div className="input">
          <input
            id={`pair-code-${itemId}`}
            className="grow font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="X-HM://…, MT:…, 123-45-678"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus
          />
          <button type="button" className="btn btn-text btn-sm btn-square my-auto" aria-label="Scan its QR code" onClick={() => setScanning(true)}>
            <span className="icon-[tabler--qrcode] size-5" />
          </button>
        </div>
        <p className="mt-1 text-sm text-base-content/70" aria-live="polite">
          {!code.trim()
            ? "Scan the QR sticker on the device, its box or its manual — or type the 8-digit (HomeKit) or 11-digit (Matter) code."
            : info
              ? `${KIND[info.kind]}${info.category ? ` · ${info.category}` : ""} · ${info.code}${info.payload ? " · with its QR code" : ""}`
              : "That doesn't look like a HomeKit or Matter code yet."}
        </p>
      </div>
      <div>
        <label className="label-text" htmlFor={`pair-label-${itemId}`}>
          Note (optional)
        </label>
        <input id={`pair-label-${itemId}`} className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. the bridge, back door" maxLength={80} />
      </div>
      {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-text" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!info || add.isPending}>
          Save code
        </button>
      </div>
      {scanning && (
        <Scanner
          onResult={(c) => {
            setScanning(false);
            setCode(c);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </form>
  );
}
