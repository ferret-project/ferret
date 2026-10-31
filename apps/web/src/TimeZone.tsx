/**
 * Settings → Household: where the household is. The server keeps time in UTC; this is what "today" means for due dates,
 * overdue and ending soon, and the hour reminders go out (server: lib/household-time.ts). Owners and admins change it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "./lib/api";

/** This device's zone (e.g. America/Denver). */
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The time now in a zone, e.g. "9:41 AM". */
const timeIn = (timeZone: string) => new Date().toLocaleTimeString([], { timeZone, hour: "numeric", minute: "2-digit" });

/** Every zone the browser knows, grouped by region (America, Europe…) for the picker. */
function useZonesByRegion() {
  return useMemo(() => {
    const all: string[] = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [deviceTimeZone(), "UTC"];
    const groups = new Map<string, string[]>();
    for (const z of all.includes("UTC") ? all : [...all, "UTC"]) {
      const region = z.includes("/") ? z.slice(0, z.indexOf("/")) : "Other";
      groups.set(region, [...(groups.get(region) ?? []), z]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, []);
}

export function TimeZoneCard({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["household-settings", householdId], queryFn: api.householdSettings });
  const save = useMutation({
    mutationFn: (timeZone: string | null) => api.setHouseholdSettings({ timeZone }),
    onSuccess: (data) => {
      qc.setQueryData(["household-settings", householdId], data);
      // "Today" may have moved: due, overdue and ending soon are worked out again.
      void qc.invalidateQueries({ queryKey: ["maintenance"] });
      void qc.invalidateQueries({ queryKey: ["attention"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  const zones = useZonesByRegion();
  const device = deviceTimeZone();
  const chosen = settings.data?.timeZone ?? null;
  const inEffect = chosen ?? settings.data?.serverTimeZone;

  return (
    <section className="card" aria-labelledby="time-zone-title">
      <div className="card-body gap-3">
        <h2 id="time-zone-title" className="card-title flex items-center gap-2">
          <span className="icon-[tabler--world] size-5 text-primary" />
          Time zone
        </h2>
        <p className="text-sm text-base-content/70">
          What "today" is for due dates, overdue and ending soon, and when reminders go out — wherever you are when you look.
        </p>
        {settings.isError && <div className="alert alert-soft alert-error text-sm">{settings.error.message}</div>}
        {settings.data && (
          <>
            {canManage ? (
              <div>
                <label className="label-text" htmlFor="household-time-zone">
                  Where this household is
                </label>
                <select
                  id="household-time-zone"
                  className="select"
                  value={chosen ?? ""}
                  disabled={save.isPending}
                  onChange={(e) => save.mutate(e.target.value || null)}
                >
                  <option value="">Not chosen (the server's: {settings.data.serverTimeZone})</option>
                  {zones.map(([region, list]) => (
                    <optgroup key={region} label={region}>
                      {list.map((z) => (
                        <option key={z} value={z}>
                          {z.replace(/_/g, " ")}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-sm">
                <strong>{(inEffect ?? "").replace(/_/g, " ")}</strong>
                {!chosen && " (the server's — the household's owner can choose one)"}
              </p>
            )}
            {inEffect && <p className="text-sm text-base-content/70">It's {timeIn(inEffect)} there now.</p>}
            {canManage && !chosen && device !== settings.data.serverTimeZone && (
              <div className="alert alert-soft alert-info flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 basis-48">This device is in {device.replace(/_/g, " ")}.</span>
                <button type="button" className="btn btn-sm btn-primary" disabled={save.isPending} onClick={() => save.mutate(device)}>
                  Use {device.replace(/_/g, " ")}
                </button>
              </div>
            )}
            {save.isError && <div className="alert alert-soft alert-error text-sm">{save.error.message}</div>}
          </>
        )}
      </div>
    </section>
  );
}
