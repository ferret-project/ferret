/**
 * "Add from a web address" on an item: paste the address of a photo or a PDF
 * (a manual, a spec sheet) and the server downloads it into the item — public
 * internet only, photos and PDFs only (never web pages or scripts). It runs in
 * the background: downloads on their way show here, then turn into the item's
 * photos/documents; a failed one stays, with why, until dismissed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./lib/api";
import { asWebAddress, siteOf } from "./Links";

export function FromWeb({ itemId, householdId, onArrived }: { itemId: string; householdId: string; onArrived: () => void }) {
  const qc = useQueryClient();
  const key = ["downloads", householdId, itemId];
  const downloads = useQuery({
    queryKey: key,
    queryFn: () => api.listDownloads(itemId),
    // On their way: check back until they've arrived or failed.
    refetchInterval: (q) => (q.state.data?.data.some((d) => d.status === "pending") ? 2000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  // When one stops waiting (arrived or failed), the item's photos and documents may have changed.
  const waiting = downloads.data?.data.filter((d) => d.status === "pending").length ?? 0;
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (waiting < wasWaiting.current) onArrived();
    wasWaiting.current = waiting;
  }, [waiting, onArrived]);

  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [badAddress, setBadAddress] = useState(false);
  const add = useMutation({
    mutationFn: (url: string) => api.addFromWeb(itemId, { url }),
    onSuccess: () => {
      setAddress("");
      setOpen(false);
      return refresh();
    },
  });
  const dismiss = useMutation({ mutationFn: api.dismissDownload, onSuccess: refresh });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = asWebAddress(address);
    setBadAddress(!url);
    if (url) add.mutate(url);
  }

  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <form className="flex flex-col gap-2 rounded-box bg-base-100 p-3" onSubmit={onSubmit}>
          <label className="label-text" htmlFor="from-web-url">
            Address of a photo or PDF
          </label>
          <div className="flex gap-2">
            <input
              id="from-web-url"
              className={`input grow ${badAddress ? "is-invalid" : ""}`}
              placeholder="https://maker.example/manual.pdf"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={2000}
              required
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={add.isPending}>
              {add.isPending && <span className="loading loading-spinner loading-xs" />}
              Add
            </button>
          </div>
          <p className="text-xs text-base-content/70">
            Ferret downloads it from the internet — photos and PDFs only, not web pages. Tip: on a product page, copy the link of
            the image or the manual itself.
          </p>
          {badAddress && <p className="text-sm text-error">That doesn't look like a web address.</p>}
          {add.isError && <p className="text-sm text-error">{add.error.message}</p>}
          <button type="button" className="btn btn-text btn-sm self-start" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="btn btn-soft btn-secondary btn-sm self-start" onClick={() => setOpen(true)}>
          <span className="icon-[tabler--world-download] size-4" />
          Add from a web address
        </button>
      )}

      {downloads.data && downloads.data.data.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Downloads">
          {downloads.data.data.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-box bg-base-100 p-3 text-sm">
              {d.status === "pending" ? (
                <span className="loading loading-spinner loading-sm text-primary shrink-0" />
              ) : (
                <span className="icon-[tabler--alert-triangle] size-5 shrink-0 text-error" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium" title={d.url}>
                  {d.status === "pending" ? "Downloading from " : "Couldn't add from "}
                  {siteOf(d.url)}
                </p>
                {d.error && <p className="text-error">{d.error}</p>}
              </div>
              {d.status === "failed" && (
                <button
                  type="button"
                  className="btn btn-text btn-sm btn-square"
                  aria-label="Dismiss"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(d.id)}
                >
                  <span className="icon-[tabler--x] size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
