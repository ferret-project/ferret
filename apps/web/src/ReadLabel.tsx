/**
 * "Read a label" in the item editor: photograph a rating plate, a label or a receipt, and what the vision model reads
 * off it lands in the form being edited — empty fields filled straight away, a different value for one already filled
 * offered with Use — before anything is saved. The photo is kept with the thing's photos (a label is worth having),
 * read by the same background job as any photo (jobs/analyze.ts), so the editor waits for it here.
 */
import type { AttachmentSuggestions } from "@ferret/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { useFeatures } from "./lib/features";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

/** How long to wait for the reading before giving up (it carries on in the background). */
const WAIT_MS = 3 * 60_000;
const EVERY_MS = 2500;

export function ReadLabel({ itemId, householdId, onRead }: { itemId: string; householdId: string; onRead: (s: AttachmentSuggestions) => void }) {
  const qc = useQueryClient();
  const features = useFeatures();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "uploading" | "reading" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState(false);
  const stop = useRef(false);
  useEffect(() => {
    // Set again on every mount (React's dev mode mounts twice): only a real close stops the wait.
    stop.current = false;
    return () => {
      stop.current = true;
    };
  }, []);
  if (!features?.photoAi) return null;

  async function read(file: File) {
    setError(null);
    setState("uploading");
    try {
      const added = await api.uploadAttachment(itemId, file, "photo", () => {});
      void qc.invalidateQueries({ queryKey: ["attachments", householdId, itemId] });
      setState("reading");
      const until = Date.now() + WAIT_MS;
      while (!stop.current && Date.now() < until) {
        await new Promise((r) => setTimeout(r, EVERY_MS));
        const now = (await api.listAttachments(itemId)).data.find((a) => a.id === added.id);
        if (!now || now.analysisStatus === "pending") continue;
        if (now.analysisStatus === "done" && now.analysis) {
          onRead(now.analysis.suggestions);
          setUsed(true);
          void qc.invalidateQueries({ queryKey: ["attachments", householdId, itemId] });
          setState("idle");
          return;
        }
        break;
      }
      if (stop.current) return;
      setState("failed");
      setError(t`Couldn't read it this time. The photo is kept with its photos.`);
    } catch (err) {
      setState("failed");
      setError((err as Error).message);
    }
  }

  const busy = state === "uploading" || state === "reading";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button type="button" className="btn btn-soft btn-primary btn-sm btn-wrap" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--scan] size-4" />}
        {state === "uploading" ? t`Sending the photo…` : state === "reading" ? t`Reading it…` : t`Read a label or receipt`}
      </button>
      {state === "idle" && !error && !used && (
        <span className="text-base-content/70 text-xs">
          <Trans>AI fills in what it can read: brand, model, serial number, price…</Trans>
        </span>
      )}
      {error && (
        <span className="text-sm text-error" role="status">
          {error}
        </span>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void read(file);
        }}
      />
    </div>
  );
}
