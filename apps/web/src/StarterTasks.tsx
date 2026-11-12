/**
 * Starter house tasks: a checklist of common upkeep for a home (gutters, smoke alarms, the dryer vent, the water
 * heater…) with sensible intervals and seasons, to tick. Nothing is added until ticked; each ticked one becomes an
 * ordinary maintenance task for the whole household (or a place picked here). Offered from Maintenance and after
 * adding a home in Places. The titles are saved in the language they're shown in — they're the household's own tasks
 * from then on.
 */
import type { MaintenanceInput } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PlacePicker } from "./Combobox";
import { api } from "./lib/api";
import { usePlaces } from "./lib/places";
import { DialogActions, Modal } from "./Modal";
import { t, ph, plural, msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

type Season = "spring" | "fall";
type Starter = { key: string; title: MessageDescriptor; count: number; unit: "month" | "year"; season?: Season; hint?: MessageDescriptor };

/** Common upkeep for a home. Seasonal ones are first due at the start of their season (April / October). */
export const STARTER_TASKS: Starter[] = [
  { key: "smoke", title: msg`Test smoke and CO alarms`, count: 1, unit: "month", hint: msg`Press the test button on each one` },
  { key: "smoke-batteries", title: msg`Replace smoke and CO alarm batteries`, count: 1, unit: "year", season: "fall" },
  { key: "hvac-filter", title: msg`Replace the furnace / AC filter`, count: 3, unit: "month" },
  { key: "furnace", title: msg`Service the furnace`, count: 1, unit: "year", season: "fall" },
  { key: "ac", title: msg`Service the air conditioner`, count: 1, unit: "year", season: "spring" },
  { key: "gutters", title: msg`Clean the gutters`, count: 6, unit: "month", season: "fall" },
  { key: "roof", title: msg`Inspect the roof`, count: 1, unit: "year", season: "spring" },
  { key: "dryer-vent", title: msg`Clean the dryer vent`, count: 1, unit: "year" },
  { key: "water-heater", title: msg`Flush the water heater`, count: 1, unit: "year" },
  { key: "sump-pump", title: msg`Test the sump pump`, count: 3, unit: "month", season: "spring" },
  { key: "outdoor-faucets", title: msg`Shut off and drain outdoor faucets`, count: 1, unit: "year", season: "fall", hint: msg`Before the first freeze` },
  { key: "chimney", title: msg`Have the chimney inspected`, count: 1, unit: "year", season: "fall" },
  { key: "fridge-coils", title: msg`Clean the refrigerator coils`, count: 1, unit: "year" },
  { key: "range-hood", title: msg`Clean the range hood filter`, count: 3, unit: "month" },
  { key: "dishwasher", title: msg`Clean the dishwasher filter`, count: 1, unit: "month" },
  { key: "gfci", title: msg`Test GFCI outlets`, count: 6, unit: "month" },
  { key: "extinguisher", title: msg`Check fire extinguishers`, count: 1, unit: "year" },
  { key: "caulk", title: msg`Check caulk around tubs, sinks and windows`, count: 1, unit: "year", season: "spring" },
  { key: "driveway", title: msg`Seal the driveway`, count: 2, unit: "year", season: "fall" },
];

/** The next start of a season after today: April 1 (spring) or October 1 (fall). */
export function seasonStart(season: Season, from = today()) {
  const year = Number(from.slice(0, 4));
  const day = season === "spring" ? "04-01" : "10-01";
  const thisYear = `${year}-${day}`;
  return thisYear > from ? thisYear : `${year + 1}-${day}`;
}

/** When a starter task is first due: twice-yearly ones at whichever season comes first, the rest at their own. */
function firstDue(s: Starter) {
  if (!s.season) return undefined;
  if (s.unit === "month" && s.count === 6) {
    const spring = seasonStart("spring");
    const fall = seasonStart("fall");
    return spring < fall ? spring : fall;
  }
  return seasonStart(s.season);
}

/** A title reduced to its words, so "Clean gutters" and "Clean the gutters" count as the same task. */
const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !["the", "a", "an", "and", "your"].includes(w))
    .join(" ");

const SEASON_WORDS: Record<Season, MessageDescriptor> = { spring: msg`spring`, fall: msg`fall` };

function howOften(s: Starter) {
  const every =
    s.unit === "month"
      ? plural(s.count, { one: "Every month", other: "Every # months" })
      : plural(s.count, { one: "Every year", other: "Every # years" });
  if (s.season && s.unit === "month" && s.count === 6) return t`Spring and fall`;
  return s.season ? t`${every}, first in ${ph({ season: t(SEASON_WORDS[s.season]) })}` : every;
}

export function StarterTasksButton({ householdId, className = "btn btn-soft btn-sm" }: { householdId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="icon-[tabler--checklist] size-4" />
        <Trans>Common house tasks</Trans>
      </button>
      {open && <StarterTasksDialog householdId={householdId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** `propertyId`: the home just added — its name goes on the tasks when the household has more than one property. */
export function StarterTasksDialog({ householdId, propertyId, onClose }: { householdId: string; propertyId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const places = usePlaces(householdId);
  const existing = useQuery({ queryKey: ["maintenance", householdId, "all"], queryFn: () => api.listMaintenance({ status: "all" }) });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [locationId, setLocationId] = useState<string | null>(null);
  const properties = places.data?.properties ?? [];
  const property = propertyId ? properties.find((p) => p.id === propertyId) : undefined;
  const suffix = property && properties.length > 1 ? ` — ${property.name}` : "";
  const have = new Set((existing.data?.data ?? []).map((task) => titleKey(task.title)));
  const titleOf = (s: Starter) => `${t(s.title)}${suffix}`;
  const open = STARTER_TASKS.filter((s) => !have.has(titleKey(titleOf(s))) && !have.has(titleKey(t(s.title))));
  const add = useMutation({
    mutationFn: async () => {
      for (const s of STARTER_TASKS.filter((x) => ticked.has(x.key))) {
        const input: MaintenanceInput = {
          title: titleOf(s),
          intervalCount: s.count,
          intervalUnit: s.unit,
          locationId,
          ...(s.season ? { dueOn: firstDue(s) } : {}),
          ...(s.hint ? { notes: t(s.hint) } : {}),
        };
        await api.createMaintenance(input);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["maintenance", householdId] }),
    onSuccess: onClose,
  });
  const toggle = (key: string) =>
    setTicked((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <Modal id="starter-tasks" title={property ? t`Common tasks for ${ph({ name: property.name })}` : t`Common house tasks`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-base-content/70">
          <Trans>Tick what applies to your home. Each becomes a task with a reminder — change how often, or remove it, any time. Seasonal ones start in April or October.</Trans>
        </p>
        {existing.isPending && <span className="loading loading-spinner text-primary mx-auto" />}
        {existing.data && open.length === 0 && (
          <div className="alert alert-soft alert-success"><Trans>You already have all of these.</Trans></div>
        )}
        {existing.data && open.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-text btn-sm" onClick={() => setTicked(new Set(open.map((s) => s.key)))}>
                <Trans>Tick all</Trans>
              </button>
              {ticked.size > 0 && (
                <button type="button" className="btn btn-text btn-sm" onClick={() => setTicked(new Set())}>
                  <Trans>Clear</Trans>
                </button>
              )}
            </div>
            <ul className="divide-y divide-base-content/10">
              {open.map((s) => (
                <li key={s.key}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 py-2">
                    <input type="checkbox" className="checkbox checkbox-primary checkbox-sm" checked={ticked.has(s.key)} onChange={() => toggle(s.key)} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{t(s.title)}</span>
                      <span className="block text-sm text-base-content/70">
                        {howOften(s)}
                        {s.hint ? ` · ${t(s.hint)}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {properties.some((p) => (!propertyId || p.id === propertyId) && p.locations.length > 0) && (
              <PlacePicker
                householdId={householdId}
                id="starter-place"
                name="place"
                label={t`For a place (optional)`}
                value={locationId}
                onChange={setLocationId}
                noneLabel={t`The whole household`}
                propertyId={propertyId}
              />
            )}
          </>
        )}
        {add.isError && <div className="alert alert-soft alert-error">{add.error.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {propertyId ? t`Not now` : t`Cancel`}
          </button>
          <button type="button" className="btn btn-primary" disabled={!ticked.size || add.isPending} onClick={() => add.mutate()}>
            {add.isPending && <span className="loading loading-spinner loading-sm" />}
            {ticked.size ? plural(ticked.size, { one: "Add # task", other: "Add # tasks" }) : t`Add tasks`}
          </button>
        </DialogActions>
      </div>
    </Modal>
  );
}
