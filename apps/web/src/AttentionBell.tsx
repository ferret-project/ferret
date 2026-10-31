/**
 * The bell in the top bar: what needs attention now (GET /attention), with a
 * count badge — red when something is urgent. A list of states, not messages:
 * entries go away once they're dealt with. The dropdown follows the account
 * menu's FlyonUI dropdown (and the list layout of Pro "Dashboard Dropdown 6"),
 * opened and closed by React.
 */
import type { AttentionItem } from "@ferret/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./lib/api";
import { COVERAGE_HREF, itemHref, MAINTENANCE_HREF, roomScanHref, SHOPPING_HREF, settingsHref } from "./lib/route";
import { Mascot } from "./Mascot";

const KIND: Record<AttentionItem["kind"], { icon: string; label: string }> = {
  maintenance: { icon: "icon-[tabler--tool]", label: "Maintenance" },
  warranty: { icon: "icon-[tabler--shield-check]", label: "Warranty" },
  claim: { icon: "icon-[tabler--file-alert]", label: "Claim" },
  review: { icon: "icon-[tabler--photo-check]", label: "To name" },
  roomscan: { icon: "icon-[tabler--scan-eye]", label: "Room scan" },
  backup: { icon: "icon-[tabler--database-exclamation]", label: "Backup" },
  shopping: { icon: "icon-[tabler--shopping-cart]", label: "To buy" },
  loan: { icon: "icon-[tabler--arrows-exchange]", label: "Lent & borrowed" },
  recall: { icon: "icon-[tabler--alert-triangle]", label: "Recall" },
  coverage: { icon: "icon-[tabler--umbrella]", label: "Coverage" },
  service: { icon: "icon-[tabler--plug-connected-x]", label: "Service" },
};

const hrefFor = (a: AttentionItem) =>
  a.kind === "roomscan" ? roomScanHref(a.id) : a.kind === "backup" || a.kind === "service" ? settingsHref("server") : a.kind === "coverage" ? COVERAGE_HREF : a.kind === "shopping" ? SHOPPING_HREF : a.kind === "maintenance" || !a.itemId ? MAINTENANCE_HREF : itemHref(a.itemId);

export function AttentionBell({ householdId }: { householdId: string }) {
  const [open, setOpen] = useState(false);
  const attention = useQuery({
    queryKey: ["attention", householdId],
    queryFn: async () => (await api.attention()).data,
    refetchInterval: 2 * 60_000,
  });
  useEffect(() => {
    if (!open) return;
    void attention.refetch();
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element).closest("#attention-menu")) setOpen(false);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch once per opening
  }, [open]);

  const list = attention.data ?? [];
  const urgent = list.some((a) => a.severity === "urgent");
  const label = list.length ? `${list.length} ${list.length === 1 ? "thing needs" : "things need"} attention` : "Nothing needs attention";

  return (
    <div id="attention-menu" className={`dropdown relative inline-flex ${open ? "open" : ""}`}>
      <button
        type="button"
        className="dropdown-toggle btn btn-text btn-circle relative"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        <span className="icon-[tabler--bell] size-5" />
        {list.length > 0 && (
          <span
            className={`badge badge-sm absolute -end-0.5 -top-0.5 h-5 min-w-5 rounded-full px-1 text-[11px] ${urgent ? "badge-error" : "badge-primary"}`}
            aria-hidden
          >
            {list.length > 9 ? "9+" : list.length}
          </span>
        )}
      </button>
      {open && (
        <div
          // On a phone, a full-width panel under the top bar (an end-aligned menu would run off the screen).
          className="dropdown-menu dropdown-open:opacity-100 absolute end-0 top-full w-88 p-0 max-sm:fixed max-sm:inset-x-3 max-sm:top-15 max-sm:w-auto"
          role="menu"
          aria-label="Needs attention"
        >
          <div className="flex items-center justify-between border-b border-base-content/10 px-4 py-3">
            <h6 className="font-semibold text-base-content">Needs attention</h6>
            {list.length > 0 && <span className={`badge badge-soft badge-sm ${urgent ? "badge-error" : "badge-primary"}`}>{list.length}</span>}
          </div>
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <Mascot pose="asleep" className="size-24" />
              <p className="font-medium text-base-content">All caught up</p>
              <p className="text-sm text-base-content/70">Nothing overdue, ending soon or waiting on you.</p>
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {list.map((a) => (
                <li key={`${a.kind}-${a.id}`}>
                  <a href={hrefFor(a)} className="dropdown-item items-start gap-3 px-4 py-2.5" role="menuitem" onClick={() => setOpen(false)}>
                    <span
                      className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${a.severity === "urgent" ? "bg-error/10 text-error" : "bg-primary/10 text-primary"}`}
                    >
                      <span className={`${KIND[a.kind].icon} size-4`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-base-content">{a.title}</span>
                      <span className={`line-clamp-2 whitespace-normal text-xs ${a.severity === "urgent" ? "text-error" : "text-base-content/70"}`}>{a.detail}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between gap-2 border-t border-base-content/10 p-2">
            <a href={MAINTENANCE_HREF} className="btn btn-text btn-sm" onClick={() => setOpen(false)}>
              <span className="icon-[tabler--tool] size-4" />
              Maintenance
            </a>
            <a href={settingsHref("notifications")} className="btn btn-text btn-sm" onClick={() => setOpen(false)}>
              <span className="icon-[tabler--settings] size-4" />
              Reminder settings
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
