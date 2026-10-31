/**
 * The home screen's scanner, with scan to count (server: lib/stock.ts). A switch along the top — Auto (each code does
 * what it's set to), Look up, Use, Restock — stays put for the session, so stocking a shelf is scan, scan, scan: each
 * count change shows a toast with Undo, beeps and buzzes, and the camera keeps going. Opening something closes the
 * scanner; a code on several items, or one set to "ask", asks first. Opened from + Add (`adding`), there's no switch:
 * a code you already have asks "you have this — add 1?" (or add it as a separate item), a new one offers to add it.
 */
import type { ScanCandidate, ScanMode, ScanResult } from "@ferret/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { itemHref } from "./lib/route";
import { type Choice, ItemPicker } from "./Combobox";
import { Scanner } from "./Scanner";
import { navigateTo } from "./lib/navigate";

const MODES: { value: ScanMode; label: string; help: string }[] = [
  { value: "auto", label: "Auto", help: "Each code does what it's set to" },
  { value: "lookup", label: "Look up", help: "Open what's scanned" },
  { value: "use", label: "Use", help: "Take one out for each scan" },
  { value: "restock", label: "Restock", help: "Put some in for each scan" },
];
const MODE_KEY = "ferret-scan-mode";

function savedMode(): ScanMode {
  try {
    const m = sessionStorage.getItem(MODE_KEY);
    return MODES.some((x) => x.value === m) ? (m as ScanMode) : "auto";
  } catch {
    return "auto";
  }
}

type Panel =
  | { kind: "pairing"; code: string; type: "homekit" | "matter"; category: string | null }
  | { kind: "saved"; name: string }
  | { kind: "done"; item: ScanCandidate; applied: number; asked: number; movementId: string | null; undone?: boolean }
  | { kind: "choose"; code: string; behaviour: string; step: number; items: ScanCandidate[] }
  | { kind: "ask"; code: string; item: ScanCandidate; step: number }
  | { kind: "have"; code: string; step: number; items: ScanCandidate[] }
  | { kind: "error"; message: string };

/** A short beep (and a buzz, where phones allow it): high when the count changed, low when there was nothing to take. */
function useFeedback() {
  const audio = useRef<AudioContext | null>(null);
  const prepare = () => {
    try {
      audio.current ??= new AudioContext();
      if (audio.current.state === "suspended") void audio.current.resume();
    } catch {
      // no sound here
    }
  };
  useEffect(() => {
    prepare();
    return () => void audio.current?.close().catch(() => {});
  }, []);
  const beep = (ok: boolean) => {
    navigator.vibrate?.(ok ? 60 : [60, 60, 60]);
    const ctx = audio.current;
    if (!ctx || ctx.state !== "running") return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = ok ? 1046 : 330;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  };
  return { prepare, beep };
}

export function ScanSession({
  householdId,
  adding = false,
  onClose,
  onUnknown,
}: {
  householdId: string;
  adding?: boolean;
  onClose: () => void;
  onUnknown: (code: string) => void;
}) {
  const qc = useQueryClient();
  const [chosenMode, setModeState] = useState<ScanMode>(savedMode);
  const mode: ScanMode = adding ? "add" : chosenMode;
  const [panel, setPanel] = useState<Panel | null>(null);
  const { prepare, beep } = useFeedback();
  const asking = panel?.kind === "choose" || panel?.kind === "ask" || panel?.kind === "pairing" || panel?.kind === "have";

  const setMode = (m: ScanMode) => {
    setModeState(m);
    try {
      sessionStorage.setItem(MODE_KEY, m);
    } catch {
      // this session only
    }
  };

  const changed = () => {
    for (const key of ["items", "item", "stock", "shopping", "attention", "overview"]) void qc.invalidateQueries({ queryKey: [key] });
  };

  /** What to do with a result; true = keep scanning. */
  function handle(result: ScanResult, code: string): boolean {
    switch (result.action) {
      case "open":
        onClose();
        navigateTo(result.label ? `#/l/${result.label}` : itemHref(result.item!.id));
        return false;
      case "unknown":
        onUnknown(result.code);
        return false;
      case "adjusted":
        beep(result.applied !== 0);
        setPanel({ kind: "done", item: result.item, applied: result.applied, asked: result.delta, movementId: result.movementId });
        if (result.applied !== 0) changed();
        return true;
      case "choose":
        setPanel({ kind: "choose", code, behaviour: result.behaviour, step: result.step, items: result.items });
        return true;
      case "ask":
        setPanel({ kind: "ask", code, item: result.item, step: result.step });
        return true;
      case "have":
        setPanel({ kind: "have", code, step: result.step, items: result.items });
        return true;
      case "pairing":
        setPanel({ kind: "pairing", code, type: result.kind, category: result.category });
        return true;
    }
  }

  async function onResult(code: string) {
    try {
      return handle(await api.scan({ code, mode }), code);
    } catch (err) {
      setPanel({ kind: "error", message: (err as Error).message });
      return true;
    }
  }

  /** A follow-up for one item: after "which one?", or an answer to "ask". */
  async function follow(code: string, itemId: string, followMode: ScanMode) {
    try {
      if (!handle(await api.scan({ code, mode: followMode, itemId }), code)) return;
    } catch (err) {
      setPanel({ kind: "error", message: (err as Error).message });
    }
  }

  async function undo(p: Extract<Panel, { kind: "done" }>) {
    if (!p.movementId) return;
    try {
      const r = await api.undoStock(p.movementId);
      setPanel({ ...p, item: { ...p.item, quantity: r.quantity }, undone: true });
      changed();
    } catch (err) {
      setPanel({ kind: "error", message: (err as Error).message });
    }
  }

  const top = adding ? (
    <div className="px-3 pb-2 text-center" onPointerDown={prepare}>
      <p className="font-medium text-white">Scan to add</p>
      <p className="text-xs text-white/70">Something you already have adds to its count</p>
    </div>
  ) : (
    <div className="px-3 pb-2" onPointerDown={prepare}>
      <div className="join w-full" role="radiogroup" aria-label="What a scan does">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            title={m.help}
            className={`btn join-item btn-sm grow ${mode === m.value ? "btn-primary" : "border-white/20 bg-white/10 text-white hover:bg-white/20"}`}
            onClick={() => setMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-center text-xs text-white/70">{MODES.find((m) => m.value === mode)!.help}</p>
    </div>
  );

  return (
    <Scanner
      onResult={onResult}
      onClose={onClose}
      paused={asking}
      fresh={mode}
      panelAt={panel?.kind === "pairing" ? "top" : "bottom"}
      top={top}
      panel={
        panel &&
        (panel.kind === "pairing" ? (
          <PairingPanel householdId={householdId} panel={panel} onSaved={(name) => setPanel({ kind: "saved", name })} onDismiss={() => setPanel(null)} />
        ) : (
          <PanelView
            panel={panel}
            mode={mode}
            onUndo={undo}
            onFollow={follow}
            onDismiss={() => setPanel(null)}
            onOpen={(id) => (onClose(), navigateTo(itemHref(id)))}
            onSeparate={(code) => onUnknown(code)}
          />
        ))
      }
    />
  );
}

function PanelView({
  panel,
  mode,
  onUndo,
  onFollow,
  onDismiss,
  onOpen,
  onSeparate,
}: {
  panel: Panel;
  mode: ScanMode;
  onUndo: (p: Extract<Panel, { kind: "done" }>) => void;
  onFollow: (code: string, itemId: string, mode: ScanMode) => void;
  onDismiss: () => void;
  onOpen: (itemId: string) => void;
  onSeparate: (code: string) => void;
}) {
  const card = "rounded-box bg-base-100 p-3 shadow-lg";
  if (panel.kind === "have") {
    const only = panel.items.length === 1 ? panel.items[0]! : null;
    return (
      <div className={card} role="dialog" aria-label="You have this already">
        {only ? (
          <>
            <p className="text-sm text-base-content/70">You have this</p>
            <p className="truncate font-medium">{only.name}</p>
            {only.place && <p className="truncate text-sm text-base-content/70">{only.place}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-wrap grow" onClick={() => onFollow(panel.code, only.id, "restock")}>
                Add {panel.step} (now {only.quantity + panel.step})
              </button>
              <button type="button" className="btn btn-soft btn-wrap grow" onClick={() => onSeparate(panel.code)}>
                Add as a separate item
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2 font-medium">You have this — add {panel.step} to which?</p>
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {panel.items.map((i) => (
                <li key={i.id}>
                  <button type="button" className="btn btn-soft btn-primary btn-wrap w-full justify-between text-start" onClick={() => onFollow(panel.code, i.id, "restock")}>
                    <span className="min-w-0">
                      <span className="block truncate">{i.name}</span>
                      {i.place && <span className="block truncate text-xs font-normal text-base-content/70">{i.place}</span>}
                    </span>
                    <span className="shrink-0 text-sm font-normal">now {i.quantity + panel.step}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-soft btn-wrap mt-2 w-full" onClick={() => onSeparate(panel.code)}>
              Add as a separate item
            </button>
          </>
        )}
        <div className="mt-2 flex flex-wrap justify-between gap-2">
          <button type="button" className="btn btn-text btn-sm" onClick={onDismiss}>
            Never mind
          </button>
          {only && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => onOpen(only.id)}>
              Open it
            </button>
          )}
        </div>
      </div>
    );
  }
  if (panel.kind === "saved") {
    return (
      <div className={`${card} flex items-center gap-3`} role="status" aria-live="polite">
        <span className="icon-[tabler--home-check] size-7 shrink-0 text-success" />
        <p className="min-w-0 flex-1 text-sm">Saved the pairing code to {panel.name}.</p>
        <button type="button" className="btn btn-text btn-sm" onClick={onDismiss}>
          OK
        </button>
      </div>
    );
  }
  if (panel.kind === "pairing") return null;
  if (panel.kind === "error") {
    return (
      <div className={`${card} flex items-center gap-3`} role="alert">
        <span className="icon-[tabler--alert-triangle] size-6 shrink-0 text-error" />
        <p className="min-w-0 flex-1 text-sm">{panel.message}</p>
        <button type="button" className="btn btn-text btn-sm" onClick={onDismiss}>
          OK
        </button>
      </div>
    );
  }
  if (panel.kind === "done") {
    const none = panel.applied === 0;
    return (
      <div className={`${card} flex items-center gap-3`} role="status" aria-live="polite">
        <span className={`${none ? "icon-[tabler--alert-circle] text-warning" : panel.undone ? "icon-[tabler--arrow-back-up] text-base-content/70" : "icon-[tabler--circle-check] text-success"} size-7 shrink-0`} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{panel.item.name}</p>
          <p className="text-sm text-base-content/70">
            {none
              ? "None left to take"
              : panel.undone
                ? `Undone — ${panel.item.quantity} left`
                : `${panel.applied > 0 ? `+${panel.applied}` : `−${-panel.applied}`} · ${panel.item.quantity} left`}
          </p>
        </div>
        {!none && !panel.undone && panel.movementId && (
          <button type="button" className="btn btn-soft btn-sm" onClick={() => onUndo(panel)}>
            Undo
          </button>
        )}
      </div>
    );
  }
  if (panel.kind === "choose") {
    const verb = panel.behaviour === "use" ? `Use ${panel.step} from` : panel.behaviour === "restock" ? `Add ${panel.step} to` : "Which one?";
    return (
      <div className={card} role="dialog" aria-label="Which one?">
        <p className="mb-2 font-medium">{panel.behaviour === "use" || panel.behaviour === "restock" ? `${verb} which?` : "Which one?"}</p>
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {panel.items.map((i) => (
            <li key={i.id}>
              <button type="button" className="btn btn-soft btn-wrap w-full justify-between text-start" onClick={() => onFollow(panel.code, i.id, mode)}>
                <span className="min-w-0">
                  <span className="block truncate">{i.name}</span>
                  {i.place && <span className="block truncate text-xs font-normal text-base-content/70">{i.place}</span>}
                </span>
                <span className="badge badge-soft shrink-0">{i.quantity}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-text btn-sm mt-2" onClick={onDismiss}>
          Never mind
        </button>
      </div>
    );
  }
  return (
    <div className={card} role="dialog" aria-label={`${panel.item.name}: use, restock or open?`}>
      <p className="font-medium">{panel.item.name}</p>
      <p className="mb-2 text-sm text-base-content/70">{panel.item.quantity} left</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary grow" onClick={() => onFollow(panel.code, panel.item.id, "use")}>
          Use {panel.step}
        </button>
        <button type="button" className="btn btn-soft btn-primary grow" onClick={() => onFollow(panel.code, panel.item.id, "restock")}>
          Add {panel.step}
        </button>
        <button type="button" className="btn btn-soft grow" onClick={() => onOpen(panel.item.id)}>
          Open
        </button>
      </div>
      <button type="button" className="btn btn-text btn-sm mt-2" onClick={onDismiss}>
        Never mind
      </button>
    </div>
  );
}

/** A pairing QR nobody has saved yet: which item is it for? (Saved sealed: lib/pairing.ts.) */
function PairingPanel({
  householdId,
  panel,
  onSaved,
  onDismiss,
}: {
  householdId: string;
  panel: Extract<Panel, { kind: "pairing" }>;
  onSaved: (itemName: string) => void;
  onDismiss: () => void;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<Choice | null>(null);
  const save = useMutation({
    mutationFn: (t: Choice) => api.addPairing(t.id, { code: panel.code }),
    onSuccess: (_, t) => {
      void qc.invalidateQueries({ queryKey: ["pairing", householdId, t.id] });
      onSaved(t.label);
    },
  });
  const what = `${panel.type === "homekit" ? "HomeKit" : "Matter"} code${panel.category ? ` (${panel.category})` : ""}`;
  return (
    <div className="rounded-box bg-base-100 p-3 shadow-lg" role="dialog" aria-label={`Which item is this ${what} for?`}>
      <p className="mb-2 font-medium">A {what} — which item is it for?</p>
      <ItemPicker householdId={householdId} id="pairing-item" name="pairingItem" label="Item" value={target} onChange={setTarget} />
      {save.isError && <p className="mt-2 text-sm text-error">{save.error.message}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-text btn-sm" onClick={onDismiss}>
          Never mind
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!target || save.isPending} onClick={() => target && save.mutate(target)}>
          Save code
        </button>
      </div>
    </div>
  );
}
