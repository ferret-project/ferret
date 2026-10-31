/**
 * What an item counts, for maintenance by use (server lib/usage.ts): a car's odometer, a mower's engine hours, a
 * furnace's run hours, a washer's cycles. Its readings, how fast it goes up, and logging a new one. Items that don't
 * count anything show a "Track miles / hours" button instead, so a TV's page stays quiet.
 */
import { describeUsage, today, type UsageUnit, usageUnits } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HelpLink } from "./HelpLink";
import { api } from "./lib/api";

const METER: Record<UsageUnit, string> = { miles: "Odometer", km: "Odometer", hours: "Hour meter", cycles: "Cycle count" };
const UNIT_LABEL: Record<UsageUnit, string> = { miles: "Miles", km: "Kilometres", hours: "Hours (engine, run time)", cycles: "Cycles (washes, uses)" };

/** "about 1,400 miles a month" */
export function describeRate(perDay: number, unit: UsageUnit) {
  const month = perDay * 30.4;
  return month >= 10 ? `about ${describeUsage(Math.round(month), unit)} a month` : `about ${describeUsage(Math.round(perDay * 365), unit)} a year`;
}

const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function UsageCard({ item, householdId, canEdit }: { item: { id: string; name: string }; householdId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const usage = useQuery({ queryKey: ["usage", householdId, item.id], queryFn: () => api.usage(item.id) });
  const [setting, setSetting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const refresh = () => {
    for (const k of ["usage", "item", "maintenance", "attention", "overview"]) void qc.invalidateQueries({ queryKey: [k, householdId] });
  };
  const start = useMutation({
    mutationFn: async (input: { unit: UsageUnit; value: number }) => {
      await api.updateItem(item.id, { usageUnit: input.unit });
      await api.addReading(item.id, { value: input.value });
    },
    onSuccess: () => {
      setSetting(false);
      refresh();
    },
  });
  const add = useMutation({ mutationFn: (input: { value: number; readOn: string }) => api.addReading(item.id, input), onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteReading, onSuccess: refresh });
  const stop = useMutation({ mutationFn: () => api.updateItem(item.id, { usageUnit: null }), onSuccess: refresh });

  const u = usage.data;
  if (!u) return null;
  if (!u.unit) {
    if (!canEdit) return null;
    if (!setting) {
      return (
        <div>
          <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={() => setSetting(true)}>
            <span className="icon-[tabler--gauge] size-4" />
            Track miles / hours
          </button>
        </div>
      );
    }
    return (
      <section className="card" aria-labelledby="usage-title">
        <form
          className="card-body gap-4"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            start.mutate({ unit: String(f.get("unit")) as UsageUnit, value: Number(f.get("value")) });
          }}
        >
          <h2 id="usage-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--gauge] size-5 text-primary" />
            Track what {item.name} counts
          </h2>
          <p className="text-sm text-base-content/70">For maintenance by use — "change the oil every 5,000 miles", "service every 100 hours".</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label-text" htmlFor="usage-unit">
                It counts
              </label>
              <select id="usage-unit" name="unit" className="select" defaultValue="miles">
                {usageUnits.map((un) => (
                  <option key={un} value={un}>
                    {UNIT_LABEL[un]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-text" htmlFor="usage-first">
                It says now
              </label>
              <input id="usage-first" name="value" type="number" min={0} step="any" inputMode="decimal" className="input" required />
            </div>
          </div>
          {start.isError && <div className="alert alert-soft alert-error text-sm">{start.error.message}</div>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-text" onClick={() => setSetting(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={start.isPending}>
              Start tracking
            </button>
          </div>
        </form>
      </section>
    );
  }

  const unit = u.unit;
  const shown = showAll ? u.readings : u.readings.slice(0, 3);
  const error = add.error ?? remove.error ?? stop.error;
  return (
    <section className="card" aria-labelledby="usage-title">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="usage-title" className="card-title flex items-center gap-2">
              <span className="icon-[tabler--gauge] size-5 text-primary" />
              {METER[unit]}
              <HelpLink page="guide/maintenance.html#by-use" label="Maintenance by use" />
            </h2>
            <p className="text-sm text-base-content/70">
              {u.perDay ? describeRate(u.perDay, unit) : u.readings.length < 2 ? "Another reading in a week or two shows how fast it goes up." : ""}
            </p>
          </div>
          <p className="text-2xl font-semibold tabular-nums" aria-label={`Now ${u.now == null ? "unknown" : describeUsage(u.now, unit)}`}>
            {u.now == null ? "—" : describeUsage(u.now, unit)}
          </p>
        </div>
        {canEdit && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              add.mutate({ value: Number(f.get("value")), readOn: String(f.get("readOn")) }, { onSuccess: () => form.reset() });
            }}
          >
            <div className="min-w-0 flex-1 basis-32">
              <label className="label-text" htmlFor="usage-value">
                New reading ({unit})
              </label>
              <input id="usage-value" name="value" type="number" min={0} step="any" inputMode="decimal" className="input" required />
            </div>
            <div className="basis-40">
              <label className="label-text" htmlFor="usage-on">
                On
              </label>
              <input id="usage-on" name="readOn" type="date" className="input" defaultValue={today()} max={today()} required />
            </div>
            <button className="btn btn-primary" disabled={add.isPending}>
              Log it
            </button>
          </form>
        )}
        {error && <div className="alert alert-soft alert-error text-sm">{error.message}</div>}
        {u.readings.length > 0 && (
          <ul className="divide-y divide-base-content/10 text-sm">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <span className="w-28 shrink-0 text-base-content/70">{formatDate(r.readOn)}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium tabular-nums">{describeUsage(r.value, unit)}</span>
                  {r.note && <span className="text-base-content/70"> · {r.note}</span>}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-text btn-xs btn-circle"
                    aria-label={`Remove the reading of ${describeUsage(r.value, unit)}`}
                    onClick={() => window.confirm(`Remove ${describeUsage(r.value, unit)} on ${formatDate(r.readOn)}?`) && remove.mutate(r.id)}
                  >
                    <span className="icon-[tabler--x] size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {u.readings.length > 3 && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Fewer" : `All ${u.readings.length} readings`}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-text btn-sm ms-auto"
              onClick={() => window.confirm(`Stop tracking ${METER[unit].toLowerCase()} readings for ${item.name}? Maintenance by use on it stops counting.`) && stop.mutate()}
            >
              Stop tracking
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
