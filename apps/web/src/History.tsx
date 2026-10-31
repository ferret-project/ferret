/**
 * An item's history (server: lib/history.ts) at the bottom of its page: what happened to it, newest first — added,
 * each edit in words ("Moved Drill: Garage → Basement"), photos, warranties, claims, maintenance, stock. The latest
 * few show; "Show all" opens the rest, 30 at a time.
 */
import type { ItemHistoryEntry } from "@ferret/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { ago, VIA } from "./Overview";

const FIRST = 5;

/** An icon for each kind of entry. */
function iconFor(e: ItemHistoryEntry) {
  if (e.action === "item.create") return "icon-[tabler--circle-plus]";
  if (e.action === "item.update") return e.summary.startsWith("Moved ") ? "icon-[tabler--arrows-move]" : "icon-[tabler--pencil]";
  if (e.action === "item.stock") return "icon-[tabler--stack-2]";
  if (e.action === "item.usage") return "icon-[tabler--gauge]";
  if (e.action === "item.pairing") return "icon-[tabler--home-link]";
  if (e.action === "item.delete" || e.action === "item.purge") return "icon-[tabler--trash]";
  if (e.action === "item.restore") return "icon-[tabler--restore]";
  if (e.action.startsWith("attachment.")) return /document/.test(e.summary) ? "icon-[tabler--file-text]" : "icon-[tabler--photo]";
  if (e.action.startsWith("warranty.")) return "icon-[tabler--shield-check]";
  if (e.action.startsWith("claim.")) return "icon-[tabler--file-alert]";
  if (e.action === "maintenance.done") return "icon-[tabler--circle-check]";
  if (e.action.startsWith("loan.")) return "icon-[tabler--arrows-exchange]";
  if (e.action.startsWith("maintenance.")) return "icon-[tabler--tool]";
  return "icon-[tabler--point]";
}

export function ItemHistory({ itemId, householdId }: { itemId: string; householdId: string }) {
  const [open, setOpen] = useState(false);
  const history = useInfiniteQuery({
    queryKey: ["item", householdId, itemId, "history"],
    queryFn: ({ pageParam }) => api.itemHistory(itemId, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.more ? pages.reduce((n, p) => n + p.data.length, 0) : undefined),
  });
  // The same line by the same person, again and again (older "Updated Drill" entries, a run of scans): one line.
  const entries: (ItemHistoryEntry & { times: number })[] = [];
  for (const e of history.data?.pages.flatMap((p) => p.data) ?? []) {
    const last = entries.at(-1);
    if (last && last.summary === e.summary && last.by === e.by) last.times++;
    else entries.push({ ...e, times: 1 });
  }
  if (!entries.length) return null;
  const shown = open ? entries : entries.slice(0, FIRST);
  const hidden = entries.length > FIRST || history.hasNextPage;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`history-${itemId}`}>
      <h2 id={`history-${itemId}`} className="text-base-content flex items-center gap-2 font-semibold">
        <span className="icon-[tabler--history] text-primary size-5" />
        History
      </h2>
      <div className="card">
        <div className="card-body gap-0 p-3 sm:p-4">
          <ol>
          {shown.map((e, i) => (
            <li key={e.id} className="flex gap-3">
              {/* The line down the left joins the entries into a timeline. */}
              <div className="flex flex-col items-center">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <span className={`${iconFor(e)} size-4`} />
                </span>
                {i < shown.length - 1 && <span className="w-px grow bg-base-content/15" />}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <p className="break-words text-sm text-base-content">{e.summary}</p>
                <p className="text-xs text-base-content/70" title={new Date(e.at).toLocaleString()}>
                  {e.by ?? (e.action === "recall.found" ? "Ferret" : "Someone")}
                  {e.via !== "web" && ` via ${(VIA[e.via] ?? VIA.web!).label}`} · {ago(e.at)}
                  {e.times > 1 && ` · ${e.times} times`}
                </p>
              </div>
            </li>
          ))}
          </ol>
          {hidden && (
            <div className="flex flex-wrap gap-2">
              {!open ? (
                <button type="button" className="btn btn-text btn-sm" onClick={() => setOpen(true)}>
                  Show all
                </button>
              ) : (
                history.hasNextPage && (
                  <button type="button" className="btn btn-text btn-sm" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
                    {history.isFetchingNextPage && <span className="loading loading-spinner loading-xs" />}
                    Show older
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
