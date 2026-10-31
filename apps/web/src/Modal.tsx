/**
 * A FlyonUI modal driven by React (no FlyonUI JS): the `open` class plus
 * `overlay-open:` variants from flyonui/variants.css. Esc and the backdrop close it.
 * With `title`, it has a header bar like FlyonUI Pro "Dashboard Modal 10" and a
 * scrolling body, for long forms on a phone. On a phone it's a sheet from the bottom edge. Rendered at the end of <body>
 * (a portal), so a dialog opened from inside another dialog's form isn't a
 * form inside a form.
 */
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function Modal({
  id,
  title,
  onClose,
  children,
}: {
  id: string;
  /** Header bar title; without one, the content brings its own heading (with id `${id}-title`). */
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Escape closes only the top dialog (one can open another, e.g. "add a provider" from a task).
    const onKey = (e: KeyboardEvent) => {
      const open = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (e.key === "Escape" && open[open.length - 1] === dialog.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const close = (
    <button type="button" className="btn btn-circle btn-sm btn-text absolute end-3 top-3" aria-label="Close" onClick={onClose}>
      <span className="icon-[tabler--x] size-4 text-base-content" />
    </button>
  );
  return createPortal(
    <>
      <div className="overlay-backdrop fixed inset-0 z-[79] bg-base-300/60" onClick={onClose} aria-hidden />
      {/* React events bubble through portals to whoever opened the dialog: keep a submit here from submitting their form too. */}
      <div
        ref={dialog}
        onSubmit={(e) => e.stopPropagation()}
        id={id}
        className="overlay modal modal-bottom grid-cols-1 open overlay-open:opacity-100 max-sm:px-0 max-sm:pb-0 sm:modal-middle motion-reduce:transition-none"
        role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className={`modal-dialog w-full ${title ? "max-w-175" : "max-w-147"}`}>
          <div className="modal-content max-h-[calc(100dvh-2rem)] max-sm:rounded-b-none">
            {title ? (
              <>
                <div className="modal-header">
                  <h3 id={`${id}-title`} className="text-xl font-semibold text-base-content">
                    {title}
                  </h3>
                  {close}
                </div>
                <div className="modal-body overflow-y-auto pb-(--pad-b) [--pad:1.5rem] [--pad-b:max(var(--pad),env(safe-area-inset-bottom))]">{children}</div>
              </>
            ) : (
              <div className="modal-body relative overflow-y-auto pb-(--pad-b) [--pad:1.5rem] [--pad-b:max(var(--pad),env(safe-area-inset-bottom))] sm:px-10 sm:pt-10 sm:[--pad:2.5rem]">
                {children}
                {close}
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * A long dialog's Cancel/Save row: it stays in view at the bottom (where a thumb reaches) while the form scrolls.
 * Keep destructive actions out of it — put them above, on their own.
 */
export function DialogActions({ children }: { children: ReactNode }) {
  return (
    // --pad and --pad-b are the dialog body's side and bottom padding (set by Modal): the row reaches the
    // dialog's edges, and sticks to its very bottom (sticky offsets count from inside the padding).
    <div className="sticky bottom-[calc(-1*var(--pad-b))] z-10 mx-[calc(-1*var(--pad))] mb-[calc(-1*var(--pad-b))] flex flex-wrap items-center justify-end gap-3 border-t border-base-300 bg-base-100 px-(--pad) pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {children}
    </div>
  );
}
