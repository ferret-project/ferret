/**
 * The photo or document an AI suggestion was read from, as a small picture beside it — a phone's "IMG_9200.jpg" says
 * nothing, the picture does. Tap it to see it bigger. A file since removed shows a plain icon.
 */
import { useState } from "react";
import { api } from "./lib/api";
import { Modal } from "./Modal";
import { t, ph } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

export function FileThumb({ attachmentId, filename, className = "size-10" }: { attachmentId: string; filename?: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const name = filename ?? t`the file`;
  if (broken) {
    return (
      <span className={`flex shrink-0 items-center justify-center rounded-field bg-base-200 text-base-content/40 ${className}`} title={filename ?? undefined}>
        <span className="icon-[tabler--file] size-5" />
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`tap shrink-0 overflow-hidden rounded-field bg-base-200 ${className}`}
        onClick={() => setOpen(true)}
        aria-label={t`Show ${ph({ name })}, where this was read`}
        title={filename ?? undefined}
      >
        <img src={api.thumbnailUrl(attachmentId)} alt="" loading="lazy" className="size-full object-cover object-top" onError={() => setBroken(true)} />
      </button>
      {open && (
        <Modal id={`file-${attachmentId}`} title={t`Read from ${ph({ name })}`} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <img src={api.thumbnailUrl(attachmentId)} alt="" className="mx-auto max-h-[60dvh] w-auto max-w-full rounded-box object-contain" />
            <a href={api.attachmentUrl(attachmentId)} target="_blank" rel="noopener" className="tap link link-primary self-center text-sm">
              <Trans>Open the original</Trans>
            </a>
          </div>
        </Modal>
      )}
    </>
  );
}
