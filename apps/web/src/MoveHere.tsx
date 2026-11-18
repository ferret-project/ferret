/**
 * "Move things here": a scanning session on a place's page or a box's. Each thing scanned (its QR label, a sticker of
 * its own, or its barcode) moves here at once — beep, a line saying where it came from, Undo — and the camera keeps
 * going. A code on several things asks which. Moving a box brings what's in it (the server keeps them in step).
 */
import type { ItemListing, ScanCandidate } from "@ferret/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { Scanner } from "./Scanner";
import { useFeedback } from "./ScanSession";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

export type MoveTarget = { locationId: string; name: string } | { boxId: string; name: string };

type Moved = { id: string; name: string; from: string | null; was: { locationId: string | null; containerItemId: string | null }; undone?: boolean };
type Panel = { kind: "moved"; moved: Moved } | { kind: "note"; text: string } | { kind: "choose"; items: ScanCandidate[] };

/** Where it was, in words, for "from …". */
function whereOf(it: ItemListing) {
  return it.container ? it.container.name : (it.place ?? null);
}

export function MoveHere({ target, onClose }: { target: MoveTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const { prepare, beep } = useFeedback();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [count, setCount] = useState(0);
  const boxId = "boxId" in target ? target.boxId : null;

  const changed = () => {
    for (const key of ["items", "item", "places", "overview", "misplaced", "room-review", "room-reviews"]) void qc.invalidateQueries({ queryKey: [key] });
  };

  async function move(id: string) {
    const it = await api.getItem(id);
    if (boxId && it.id === boxId) {
      beep(false);
      return setPanel({ kind: "note", text: t`That's ${ph({ name: target.name })} itself.` });
    }
    const here = boxId ? it.container?.id === boxId : !it.container && it.locationId === (target as { locationId: string }).locationId;
    if (here) {
      beep(true);
      return setPanel({ kind: "note", text: t`${ph({ name: it.name })} is already here.` });
    }
    await api.updateItem(it.id, boxId ? { containerItemId: boxId } : { containerItemId: null, locationId: (target as { locationId: string }).locationId });
    // In your hand, so not missing any more.
    if (it.missingSince) await api.markSeen(it.id).catch(() => {});
    beep(true);
    setCount((n) => n + 1);
    setPanel({
      kind: "moved",
      moved: { id: it.id, name: it.name, from: whereOf(it), was: { locationId: it.locationId ?? null, containerItemId: it.container?.id ?? null } },
    });
    changed();
  }

  async function undo(m: Moved) {
    try {
      await api.updateItem(m.id, m.was.containerItemId ? { containerItemId: m.was.containerItemId } : { containerItemId: null, locationId: m.was.locationId });
      setCount((n) => n - 1);
      setPanel({ kind: "moved", moved: { ...m, undone: true } });
      changed();
    } catch (err) {
      setPanel({ kind: "note", text: (err as Error).message });
    }
  }

  async function onResult(code: string) {
    prepare();
    try {
      const found = await api.scan({ code, mode: "lookup" });
      if (found.action === "open" && found.item) await move(found.item.id);
      else if (found.action === "choose") setPanel({ kind: "choose", items: found.items });
      else {
        beep(false);
        setPanel({
          kind: "note",
          text: found.action === "open" ? t`That's a place's label (or a blank one) — scan the things to move.` : t`Nothing here has that code.`,
        });
      }
    } catch (err) {
      beep(false);
      setPanel({ kind: "note", text: (err as Error).message });
    }
    return true;
  }

  const card = "rounded-box bg-base-100 p-3 shadow-lg";
  return (
    <Scanner
      onResult={onResult}
      onClose={onClose}
      paused={panel?.kind === "choose"}
      top={
        <div className="px-3 pb-2 text-center text-white">
          <p className="font-medium"><Trans>Moving things to {ph({ name: target.name })}</Trans></p>
          <p className="text-xs text-white/70">
            {count > 0 ? plural(count, { one: "# moved so far", other: "# moved so far" }) : t`Scan each thing's label or barcode.`}
          </p>
        </div>
      }
      panel={
        panel &&
        (panel.kind === "choose" ? (
          <div className={card} role="dialog" aria-label={t`Which one?`}>
            <p className="mb-2 font-medium"><Trans>Which one are you moving?</Trans></p>
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {panel.items.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className="btn btn-soft btn-primary btn-wrap w-full justify-start text-start"
                    onClick={() => {
                      setPanel(null);
                      move(i.id).catch((err: Error) => setPanel({ kind: "note", text: err.message }));
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{i.name}</span>
                      {i.place && <span className="block truncate text-xs font-normal text-base-content/70">{i.place}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-text btn-sm mt-2" onClick={() => setPanel(null)}>
              <Trans>Never mind</Trans>
            </button>
          </div>
        ) : panel.kind === "note" ? (
          <div className={`${card} flex items-center gap-3`} role="status" aria-live="polite">
            <span className="icon-[tabler--info-circle] size-7 shrink-0 text-info" />
            <p className="min-w-0 flex-1 text-sm">{panel.text}</p>
          </div>
        ) : (
          <div className={`${card} flex items-center gap-3`} role="status" aria-live="polite">
            <span className={`${panel.moved.undone ? "icon-[tabler--arrow-back-up] text-base-content/70" : "icon-[tabler--circle-check] text-success"} size-7 shrink-0`} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{panel.moved.name}</p>
              <p className="truncate text-sm text-base-content/70">
                {panel.moved.undone
                  ? t`Put back`
                  : panel.moved.from
                    ? t`Moved here from ${ph({ from: panel.moved.from })}`
                    : t`Moved here`}
              </p>
            </div>
            {!panel.moved.undone && (
              <button type="button" className="btn btn-soft btn-sm" onClick={() => void undo(panel.moved)}>
                <Trans>Undo</Trans>
              </button>
            )}
          </div>
        ))
      }
    />
  );
}

/** The button that starts it, for people who can edit. */
export function MoveHereButton({ target, className = "btn btn-soft btn-primary btn-sm" }: { target: MoveTarget; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="icon-[tabler--scan] size-4" />
        <Trans>Move things here</Trans>
      </button>
      {open && <MoveHere target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
