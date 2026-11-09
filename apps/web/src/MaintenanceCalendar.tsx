import { tn } from "./i18n";
import { locale } from "./i18n";
import { t as translateText } from "./i18n";
/**
 * Maintenance as a month: each open task on its next due date (overdue ones on today, as in the calendar feed) and
 * its repeats after that, faded — what's expected if each is done on time. Tap a day for its tasks; with no day
 * picked, the list under the grid is the whole month. Phones get dots in the cells, wider screens the tasks' names.
 */
import type { MaintenanceTask } from "@ferret/shared";
import { type TaskOccurrence, addDays, addMonths, taskOccurrences, today } from "@ferret/shared/utils";
import { useMemo, useState } from "react";
import { TaskRow } from "./Maintenance";

/** `short`: not enough of the task's part left by then (its `part.shortOn` or later). */
type Entry = { task: MaintenanceTask; kind: TaskOccurrence["kind"]; short: boolean };

/** The locale's first day of the week, as JS counts them (0 = Sunday). */
function weekStart() {
  try {
    const info = new Intl.Locale(locale()) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay; // 1 = Monday … 7 = Sunday
    return firstDay ? firstDay % 7 : 0;
  } catch {
    return 0;
  }
}

const dayOfWeek = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale(), { ...opts, timeZone: "UTC" });

/** This month, yyyy-mm. */
export const thisMonth = () => today().slice(0, 7);

/** Where a task's chip sits: overdue red, due in two weeks amber, later blue; a repeat faded and dashed. */
function chip(e: Entry) {
  if (e.kind === "overdue") return "bg-error/15 text-error";
  if (e.kind === "expected") return "border border-dashed border-base-content/25 text-base-content/70";
  return e.task.status === "due" ? "bg-warning/15 text-warning" : "bg-primary/10 text-primary";
}
function dot(e: Entry) {
  if (e.kind === "overdue") return "bg-error";
  if (e.kind === "expected") return "border border-base-content/50";
  return e.task.status === "due" ? "bg-warning" : "bg-primary";
}

export function MaintenanceCalendar(props: {
  tasks: MaintenanceTask[];
  month: string;
  onMonth: (month: string) => void;
  canEdit: boolean;
  onDone: (t: MaintenanceTask) => void;
  onEdit: (t: MaintenanceTask) => void;
}) {
  const { month, tasks } = props;
  const now = today();
  const [picked, setPicked] = useState<string | null>(null);
  const first = `${month}-01`;
  const last = addDays(addMonths(first, 1), -1);
  const start = addDays(first, -((dayOfWeek(first) - weekStart() + 7) % 7));
  const weeks = Math.ceil((Math.round((Date.parse(last) - Date.parse(start)) / 86_400_000) + 1) / 7);
  const end = addDays(start, weeks * 7 - 1);

  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const task of tasks) {
      for (const o of taskOccurrences(task, start, end, now)) {
        const list = map.get(o.on) ?? [];
        list.push({ task, kind: o.kind, short: !!task.part?.shortOn && o.on >= task.part.shortOn });
        map.set(o.on, list);
      }
    }
    const order = { overdue: 0, due: 1, expected: 2 };
    for (const list of map.values()) list.sort((a, b) => order[a.kind] - order[b.kind] || a.task.title.localeCompare(b.task.title));
    return map;
  }, [tasks, start, end, now]);

  const go = (m: string) => {
    setPicked(null);
    props.onMonth(m);
  };
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
  // The list under the grid: the picked day, or every day of the month with something on it.
  const shown = (picked ? [picked] : days.filter((d) => d >= first && d <= last)).filter((d) => byDay.has(d));
  const anyShort = days.some((d) => byDay.get(d)?.some((e) => e.short));
  const inMonth = [...byDay.entries()].filter(([d]) => d >= first && d <= last).reduce((n, [, l]) => n + l.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <section className="card" aria-labelledby="month-title">
        <div className="card-body gap-3 p-3 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="month-title" className="text-lg font-semibold text-base-content">
              {fmt(first, { month: "long", year: "numeric" })}
            </h2>
            <div className="flex items-center gap-1">
              {month !== thisMonth() && (
                <button type="button" className="btn btn-text btn-sm" onClick={() => go(thisMonth())}>
                  {translateText("Today")}</button>
              )}
              <button type="button" className="btn btn-text btn-sm btn-square" aria-label={translateText("Previous month")} onClick={() => go(addMonths(first, -1).slice(0, 7))}>
                <span className="icon-[tabler--chevron-left] size-5" />
              </button>
              <button type="button" className="btn btn-text btn-sm btn-square" aria-label={translateText("Next month")} onClick={() => go(addMonths(first, 1).slice(0, 7))}>
                <span className="icon-[tabler--chevron-right] size-5" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 text-center text-xs font-medium text-base-content/70" aria-hidden>
            {days.slice(0, 7).map((d) => (
              <span key={d}>
                <span className="sm:hidden">{fmt(d, { weekday: "narrow" })}</span>
                <span className="max-sm:hidden">{fmt(d, { weekday: "short" })}</span>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-box border border-base-content/10 bg-base-content/10">
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              const outside = d < first || d > last;
              const isPicked = picked === d;
              const label = `${fmt(d, { weekday: "long", month: "long", day: "numeric" })}${d === now ? translateText(", today") : ""}: ${
                list.length ? tn(list.length, "{count} task", "{count} tasks") : translateText("nothing due")
              }`;
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={label}
                  aria-pressed={isPicked}
                  onClick={() => setPicked(isPicked ? null : d)}
                  className={`flex min-h-14 min-w-0 flex-col items-stretch gap-1 p-1 text-start sm:min-h-24 sm:p-1.5 ${
                    isPicked ? "bg-primary/10" : outside ? "bg-base-200" : "bg-base-100"
                  } hover:bg-primary/5 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary`}
                >
                  <span
                    className={`mx-auto grid size-6 place-items-center rounded-full text-xs sm:mx-0 ${
                      d === now ? "bg-primary font-semibold text-primary-content" : outside ? "text-base-content/50" : "text-base-content"
                    }`}
                  >
                    {Number(d.slice(8))}
                  </span>
                  {/* Phones: up to three dots. */}
                  {list.length > 0 && (
                    <span className="flex flex-wrap justify-center gap-0.5 sm:hidden" aria-hidden>
                      {list.slice(0, 3).map((e) => (
                        <span key={`${e.task.id}-${e.kind}`} className={`size-1.5 rounded-full ${dot(e)}`} />
                      ))}
                    </span>
                  )}
                  {/* Wider: the tasks' names. */}
                  <span className="flex min-w-0 flex-col gap-0.5 max-sm:hidden" aria-hidden>
                    {list.slice(0, 3).map((e) => (
                      <span key={`${e.task.id}-${e.kind}`} title={e.task.title} className={`truncate rounded px-1 text-xs leading-5 ${chip(e)} ${outside ? "opacity-60" : ""}`}>
                        {e.short && <span className="icon-[tabler--shopping-cart] me-0.5 size-3 align-[-2px]" />}
                        {e.kind === "due" && e.task.dueEstimated ? "~ " : ""}
                        {e.task.title}
                      </span>
                    ))}
                    {list.length > 3 && <span className="px-1 text-xs text-base-content/70">+{list.length - 3} {translateText("more")}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-base-content/70">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-error" aria-hidden /> {translateText("Overdue")}</span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-warning" aria-hidden /> {translateText("Due soon")}</span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" aria-hidden /> {translateText("Later")}</span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full border border-base-content/50" aria-hidden /> {translateText("Expected repeat")}</span>
            {anyShort && (
              <span className="flex items-center gap-1.5">
                <span className="icon-[tabler--shopping-cart] size-3.5" aria-hidden /> {translateText("Not enough parts left by then")}</span>
            )}
          </p>
        </div>
      </section>

      <section className="card" aria-labelledby="month-list">
        <div className="card-body gap-2 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="month-list" className="font-semibold text-base-content">
              {picked ? fmt(picked, { weekday: "long", month: "long", day: "numeric" }) : translateText("All of {v0}", { v0: fmt(first, { month: "long" }) })}
            </h2>
            {picked && (
              <button type="button" className="btn btn-text btn-sm" onClick={() => setPicked(null)}>
                {translateText("Show the whole month")}</button>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-base-content/70">{picked ? translateText("Nothing due that day.") : inMonth ? "" : translateText("Nothing due this month.")}</p>
          ) : (
            shown.map((d) => (
              <div key={d}>
                {!picked && (
                  <h3 className={`pt-2 text-sm font-medium ${d === now ? "text-primary" : "text-base-content/70"}`}>
                    {fmt(d, { weekday: "short", month: "short", day: "numeric" })}
                    {d === now ? translateText(" · Today") : ""}
                  </h3>
                )}
                <ul className="divide-y divide-base-content/10">
                  {byDay.get(d)!.map((e) => (
                    <TaskRow
                      key={`${e.task.id}-${e.kind}`}
                      task={e.task}
                      showItem
                      canEdit={props.canEdit}
                      onDone={() => props.onDone(e.task)}
                      onEdit={() => props.onEdit(e.task)}
                      expected={
                        e.kind === "expected"
                          ? `Expected, if the one before is done on time${e.short ? ` · not enough ${e.task.part!.name} left by then` : ""}`
                          : undefined
                      }
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
