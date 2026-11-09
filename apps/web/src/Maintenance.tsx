import { tn } from "./i18n";
import { currentLanguage } from "./i18n";
import { intervalLabel } from "@ferret/shared/utils";
import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Maintenance: what's overdue, due soon and coming up across the household, with
 * "Done" (logs it and schedules the next one), and adding and editing tasks.
 * Also the Maintenance section on an item's page. Rows follow the FlyonUI list
 * pattern used elsewhere; the dialogs reuse the "Dashboard Modal 10" form layout.
 */
import { BarSearch } from "./Nav";
import type { MaintenanceInput, MaintenanceTask } from "@ferret/shared";
import { type IntervalUnit, addDays, describeInterval, describeUsage, intervalUnits, today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { AttentionBell } from "./AttentionBell";
import { ProviderPicker } from "./Providers";
import { itemHref, PROVIDERS_HREF } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { SuggestedMaintenance } from "./SuggestedMaintenance";
import { HelpLink } from "./HelpLink";
import { Mascot } from "./Mascot";
import { MaintenanceCalendar, thisMonth } from "./MaintenanceCalendar";
import { navigateTo } from "./lib/navigate";
import { money, currencySymbol, toCents } from "./lib/money";

export const maintenanceKey = (householdId: string) => ["maintenance", householdId];

function useRefresh(householdId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: maintenanceKey(householdId) }),
      qc.invalidateQueries({ queryKey: ["overview", householdId] }),
      qc.invalidateQueries({ queryKey: ["providers", householdId] }), // their jobs and totals
      qc.invalidateQueries({ queryKey: ["attention", householdId] }),
      // A task's part comes out of stock when it's done.
      qc.invalidateQueries({ queryKey: ["stock", householdId] }),
      qc.invalidateQueries({ queryKey: ["shopping", householdId] }),
      qc.invalidateQueries({ queryKey: ["item", householdId] }),
    ]);
}

/** List or Month: the address's `view` if it has one, else this device's last choice. */
const VIEW_KEY = "ferret.maintenance.view";
function savedView(): "list" | "month" {
  try {
    return localStorage.getItem(VIEW_KEY) === "month" ? "month" : "list";
  } catch {
    return "list";
  }
}
function maintenanceHref(view: "list" | "month", month?: string) {
  if (view === "list") return "#/maintenance?view=list";
  return `#/maintenance?view=month${month && month !== thisMonth() ? `&month=${month}` : ""}`;
}

export function Maintenance({ householdName, householdId, view: asked, month: askedMonth }: { householdName: string; householdId: string; view?: string; month?: string }) {
  const view = asked === "month" || asked === "list" ? asked : savedView();
  const month = askedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(askedMonth) ? askedMonth : thisMonth();
  const show = (v: "list" | "month", m?: string) => {
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
    navigateTo(maintenanceHref(v, m), { replace: true });
  };
  const tasks = useQuery({ queryKey: [...maintenanceKey(householdId), "open"], queryFn: () => api.listMaintenance() });
  const canEdit = useCanEdit(householdId);
  const [editing, setEditing] = useState<MaintenanceTask | "new" | null>(null);
  const [doing, setDoing] = useState<MaintenanceTask | null>(null);
  const list = tasks.data?.data ?? [];
  const groups = [
    { key: "overdue", title: translateText("Overdue"), tasks: list.filter((t) => t.status === "overdue") },
    { key: "due", title: translateText("Due in the next two weeks"), tasks: list.filter((t) => t.status === "due") },
    { key: "upcoming", title: translateText("Coming up"), tasks: list.filter((t) => t.status === "upcoming") },
  ].filter((g) => g.tasks.length);

  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back to your stuff")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold">{translateText("Maintenance")}</h1>
          <HelpLink page="guide/maintenance.html" label={translateText("Maintenance")} />
        </div>
        <BarSearch />
        <div className="navbar-end items-center gap-2">
          {/* On a phone the bar is full: providers are under More, the bell on the home screen. */}
          <a href={PROVIDERS_HREF} className="btn btn-text btn-sm btn-circle max-sm:hidden" aria-label={translateText("Service providers")}>
            <span className="icon-[tabler--address-book] size-5" />
          </a>
          <div className="max-sm:hidden">
            <AttentionBell householdId={householdId} />
          </div>
          {canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
              <span className="icon-[tabler--plus] size-4" />
              {translateText("Task")}</button>
          )}
        </div>
      </nav>

      <main className={`mx-auto flex ${view === "month" ? "max-w-5xl" : "max-w-3xl"} flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]`}>
        {tasks.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {tasks.isError && <div className="alert alert-soft alert-error">{tasks.error.message}</div>}
        {tasks.data && list.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <Mascot pose="asleep" className="size-32" />
              <h2 className="text-lg font-semibold">{translateText("Nothing to keep up with yet")}</h2>
              <p className="max-w-sm text-sm text-base-content/70">{tr("Track filters, servicing, gutters — anything {v0} does on a schedule. Upload a manual to an item and Ferret suggests what it needs.", { v0: householdName })}</p>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                  <span className="icon-[tabler--plus] size-5" />
                  {translateText("Add a task")}</button>
              )}
            </div>
          </div>
        )}
        {list.length > 0 && (
          <div className="join self-start" role="group" aria-label={translateText("Show as")}>
            {(["list", "month"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                className={`btn btn-sm join-item ${view === v ? "btn-primary" : "btn-soft"}`}
                onClick={() => show(v, month)}
              >
                <span className={`size-4 ${v === "list" ? "icon-[tabler--list]" : "icon-[tabler--calendar-month]"}`} />
                {v === "list" ? translateText("List") : translateText("Month")}
              </button>
            ))}
          </div>
        )}
        {view === "month" && list.length > 0 && (
          <MaintenanceCalendar
            tasks={list}
            month={month}
            onMonth={(m) => show("month", m)}
            canEdit={canEdit}
            onDone={setDoing}
            onEdit={setEditing}
          />
        )}
        {view === "list" && <SuggestedMaintenance householdId={householdId} />}
        {view === "list" && groups.map((g) => (
          <section key={g.key} className="card" aria-labelledby={`group-${g.key}`}>
            <div className="card-body gap-2 p-4 sm:p-6">
              <h2 id={`group-${g.key}`} className="flex items-center gap-2 font-semibold text-base-content">
                {g.title}
                <span className={`badge badge-soft badge-sm ${g.key === "overdue" ? "badge-error" : g.key === "due" ? "badge-warning" : "badge-primary"}`}>
                  {g.tasks.length}
                </span>
              </h2>
              <ul className="divide-y divide-base-content/10">
                {g.tasks.map((t) => (
                  <TaskRow key={t.id} task={t} showItem canEdit={canEdit} onDone={() => setDoing(t)} onEdit={() => setEditing(t)} />
                ))}
              </ul>
            </div>
          </section>
        ))}
      </main>

      {editing && <TaskModal householdId={householdId} task={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
      {doing && <DoneModal householdId={householdId} task={doing} onClose={() => setDoing(null)} />}
    </div>
  );
}

/** An item's maintenance, on its page. */
export function ItemMaintenance({ itemId, householdId }: { itemId: string; householdId: string }) {
  const tasks = useQuery({
    queryKey: [...maintenanceKey(householdId), "item", itemId],
    queryFn: () => api.listMaintenance({ itemId, status: "all" }),
  });
  const canEdit = useCanEdit(householdId);
  const [editing, setEditing] = useState<MaintenanceTask | "new" | null>(null);
  const [doing, setDoing] = useState<MaintenanceTask | null>(null);
  const list = tasks.data?.data ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--tool] size-5 text-primary" />
          {translateText("Maintenance")}</h2>
        {canEdit && (
          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing("new")}>
            <span className="icon-[tabler--plus] size-4" /> {translateText("Add")}</button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-base-content/70">{translateText("Nothing scheduled. Upload the manual and Ferret will suggest what it needs.")}</p>
      ) : (
        <ul className="card divide-y divide-base-content/10 px-4">
          {list.map((t) => (
            <TaskRow key={t.id} task={t} canEdit={canEdit} onDone={() => setDoing(t)} onEdit={() => setEditing(t)} />
          ))}
        </ul>
      )}
      <SuggestedMaintenance householdId={householdId} itemId={itemId} />
      {editing && (
        <TaskModal householdId={householdId} itemId={itemId} task={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      )}
      {doing && <DoneModal householdId={householdId} task={doing} onClose={() => setDoing(null)} />}
    </section>
  );
}

export const STATUS = {
  overdue: { dot: "bg-error", get text() { return "text-error"; } },
  due: { dot: "bg-warning", get text() { return "text-warning"; } },
  upcoming: { dot: "bg-primary/40", get text() { return "text-base-content/70"; } },
  done: { dot: "bg-success", get text() { return "text-success"; } },
} as const;

export function TaskRow(props: { task: MaintenanceTask; showItem?: boolean; canEdit: boolean; onDone: () => void; onEdit: () => void; expected?: string }) {
  const t = props.task;
  const where = [props.showItem && t.itemName, t.place && !t.itemName ? t.place : null].filter(Boolean);
  return (
    <li className="flex items-center gap-3 py-3">
      <span className={`size-2.5 shrink-0 rounded-full ${STATUS[t.status].dot}`} aria-hidden />
      <button type="button" className="min-w-0 flex-1 text-start" onClick={props.onEdit} disabled={!props.canEdit && !t.notes}>
        <span className="block truncate font-medium text-base-content">{t.title}</span>
        <span className="block truncate text-sm text-base-content/70">
          {props.showItem && t.itemId ? (
            <a href={itemHref(t.itemId)} className="tap link link-hover" onClick={(e) => e.stopPropagation()}>
              {t.itemName}
            </a>
          ) : (
            where.join(" · ")
          )}
          {(props.showItem && t.itemId) || where.length ? " · " : ""}
          {scheduleText(t)}
          {t.providerName ? ` · ${t.providerName}` : ""}
        </span>
        <span className={`block text-xs ${props.expected ? "text-base-content/70" : STATUS[t.status].text}`}>{props.expected ?? dueText(t)}</span>
        {t.part && !props.expected && (
          <span className={`block truncate text-xs ${partSoon(t.part) ? "text-warning" : "text-base-content/70"}`}>{tr("Uses {v0} × {v1} · ", { v0: t.part.uses, v1: t.part.name })}{t.part.left === 0 ? translateText("none") : t.part.left} {translateText("left")}{t.part.shortOn && t.part.left >= t.part.uses ? translateText(" · buy more before {v0}", { v0: formatDate(t.part.shortOn) }) : ""}
          </span>
        )}
      </button>
      {props.canEdit && t.status !== "done" && !props.expected && (
        <button type="button" className="btn btn-soft btn-success btn-sm" onClick={props.onDone} aria-label={translateText("Mark {v0} done", { v0: t.title })}>
          <span className="icon-[tabler--check] size-4" />
          {translateText("Done")}</button>
      )}
    </li>
  );
}

/** Not enough of its part for next time, or running short within a month (when the shopping list starts saying so). */
const partSoon = (part: NonNullable<MaintenanceTask["part"]>) => part.left < part.uses || (!!part.shortOn && part.shortOn <= addDays(today(), 30));

/** "every 3 months", "every 5,000 miles", "every 5,000 miles or 6 months" */
export function scheduleText(t: MaintenanceTask) {
  const byTime = describeInterval(t.intervalCount, t.intervalUnit, currentLanguage());
  if (!t.usage) return byTime;
  const byUse = translateText("every {v0}", { v0: describeUsage(t.usage.every, t.usage.unit, currentLanguage()) });
  return t.intervalCount ? translateText("{v0} or {v1}", { v0: byUse, v1: t.intervalCount === 1 ? translateText("a {v0}", { v0: t.intervalUnit }) : byTime.replace(/^every /, "") }) : byUse;
}

function dueText(t: MaintenanceTask) {
  if (t.status === "done") return t.lastDoneOn ? translateText("Done {v0}", { v0: formatDate(t.lastDoneOn) }) : translateText("Done");
  // By use: where the counter has to get to (and an estimated date says so).
  const at = t.usage ? translateText(" · at {v0}", { v0: describeUsage(t.usage.dueAt, t.usage.unit, currentLanguage()) }) : "";
  const days = Math.round((Date.parse(`${t.dueOn}T00:00:00`) - Date.parse(`${today()}T00:00:00`)) / 86_400_000);
  if (days < 0) return tn(-days, "{count} day overdue{v2}", "{count} days overdue{v2}", { v2: at });
  if (days === 0) return translateText("Due today{v0}", { v0: at });
  if (t.dueEstimated) return translateText("Due around {v0}{v1}", { v0: formatDate(t.dueOn!), v1: at });
  if (days === 1) return translateText("Due tomorrow{v0}", { v0: at });
  if (days < 14) return translateText("Due in {v0} days{v1}", { v0: days, v1: at });
  return translateText("Due {v0}{v1}", { v0: formatDate(t.dueOn!), v1: at });
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(locale(), { month: "short", day: "numeric", year: "numeric" });

/** Done: when (today by default), with an optional note and cost. */
function DoneModal({ task, householdId, onClose }: { task: MaintenanceTask; householdId: string; onClose: () => void }) {
  const refresh = useRefresh(householdId);
  const [doneBy, setDoneBy] = useState<string | null>(task.providerId);
  const [usePart, setUsePart] = useState(true);
  const done = useMutation({
    mutationFn: (input: { doneOn: string; note: string | null; costCents: number | null; providerId: string | null; usePart: boolean; reading?: number }) =>
      api.maintenanceDone(task.id, input),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    done.mutate({
      doneOn: String(f.get("doneOn")),
      note: String(f.get("note") || "").trim() || null,
      costCents: toCents(f.get("cost")),
      providerId: doneBy,
      usePart,
      reading: task.usage && f.get("reading") ? Number(f.get("reading")) : undefined,
    });
  }
  return (
    <Modal id="maintenance-done" onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <div className="space-y-1 text-center">
          <h3 id="maintenance-done-title" className="text-2xl font-semibold text-base-content">
            {task.title}
          </h3>
          <p className="text-base-content/80">
            {task.usage
              ? translateText("Ferret schedules the next one {v0} from now.", { v0: scheduleText(task) })
              : task.intervalCount
                ? translateText("Ferret schedules the next one {v0} from this day.", { v0: describeInterval(task.intervalCount, task.intervalUnit, currentLanguage()) })
                : translateText("Marks it done.")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="done-on">
              {translateText("Done on")}</label>
            <input id="done-on" name="doneOn" type="date" className="input" defaultValue={today()} max={today()} required />
          </div>
          <div>
            <label className="label-text" htmlFor="done-cost">
              {translateText("Cost")}</label>
            <div className="input">
              <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
              <input id="done-cost" name="cost" className="grow" inputMode="decimal" placeholder={translateText("optional")} />
            </div>
          </div>
          {task.usage && (
            <div className="col-span-2">
              <label className="label-text" htmlFor="done-reading">{tr("What it says now ({v0})", { v0: task.usage.unit })}</label>
              <input
                id="done-reading"
                name="reading"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                className="input"
                defaultValue={task.usage.now ?? undefined}
                required
              />
            </div>
          )}
          <div className="col-span-2">
            <label className="label-text" htmlFor="done-note">
              {translateText("Note")}</label>
            <input id="done-note" name="note" className="input" placeholder={translateText("e.g. MERV 11 filter, 16×25×1")} maxLength={2000} />
          </div>
        </div>
        <ProviderPicker householdId={householdId} id="done-by" label={translateText("Who did it")} value={doneBy} onChange={setDoneBy} noneLabel={translateText("We did")} />
        {task.part && (
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" className="checkbox checkbox-primary mt-0.5" checked={usePart} onChange={(e) => setUsePart(e.target.checked)} />
            <span>
              <span className="label-text block text-base">{tr("Took {v0} {v1} from stock", { v0: task.part.uses, v1: task.part.name })}</span>
              <span className="text-sm text-base-content/70">
                {task.part.left < task.part.uses ? translateText("Only {v0} recorded — it won't go below 0.", { v0: task.part.left }) : translateText("{v0} → {v1} left", { v0: task.part.left, v1: task.part.left - task.part.uses })}
              </span>
            </span>
          </label>
        )}
        {done.isError && <div className="alert alert-soft alert-error">{done.error.message}</div>}
        <div className="flex flex-wrap items-center justify-end gap-4">
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            {translateText("Cancel")}</button>
          <button type="submit" className="btn btn-success" disabled={done.isPending}>
            {done.isPending && <span className="loading loading-spinner loading-sm" />}
            {translateText("Mark done")}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Add or edit a task. On the Maintenance screen it can be for any item or place; on an item's page, for that item. */
export function TaskModal(props: {
  householdId: string;
  task?: MaintenanceTask;
  /** Fixed item (on its page). */
  itemId?: string;
  /** Prefill (e.g. from a manual's suggestion). */
  initial?: Partial<MaintenanceInput>;
  onClose: () => void;
}) {
  const { task, householdId, onClose } = props;
  const refresh = useRefresh(householdId);
  const canEdit = useCanEdit(householdId);
  const [forItem, setForItem] = useState<Choice | null>(
    task?.itemId ? { id: task.itemId, label: task.itemName ?? translateText("Item"), detail: task.place } : null,
  );
  const [place, setPlace] = useState<string | null>(task?.locationId ?? props.initial?.locationId ?? null);
  const [providerId, setProviderId] = useState<string | null>(task?.providerId ?? null);
  const [part, setPart] = useState<Choice | null>(task?.part ? { id: task.part.itemId, label: task.part.name, detail: translateText("{v0} left", { v0: task.part.left }) } : null);
  const history = useQuery({ queryKey: [...maintenanceKey(householdId), "history", task?.id], queryFn: () => api.maintenanceHistory(task!.id), enabled: Boolean(task) });
  const initial = { ...props.initial, ...task };
  const [repeats, setRepeats] = useState(task ? Boolean(task.intervalCount) : props.initial ? Boolean(props.initial.intervalCount) : true);
  // By use: needs the item to count something (and a reading to count from — asked for here if there's none).
  const [byUse, setByUse] = useState(Boolean(task?.usage));
  const itemForUse = props.itemId ?? forItem?.id ?? null;
  const meter = useQuery({ queryKey: ["usage", householdId, itemForUse], queryFn: () => api.usage(itemForUse!), enabled: Boolean(itemForUse) });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: async (input: MaintenanceInput & { firstReading?: number }) => {
      const { firstReading, ...rest } = input;
      if (firstReading != null && rest.itemId) await api.addReading(rest.itemId, { value: firstReading });
      return task ? api.updateMaintenance(task.id, rest) : api.createMaintenance(rest);
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteMaintenance(task!.id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const itemId = props.itemId ?? (String(f.get("itemId") || "") || null);
    save.mutate({
      title: String(f.get("title")).trim(),
      notes: String(f.get("notes") || "").trim() || null,
      itemId,
      locationId: itemId ? null : String(f.get("locationId") || "") || null,
      intervalCount: repeats ? Number(f.get("intervalCount")) : null,
      intervalUnit: repeats ? (String(f.get("intervalUnit")) as IntervalUnit) : null,
      dueOn: String(f.get("dueOn") || "") || undefined,
      attachmentId: initial.attachmentId ?? null,
      ...(!task && props.initial?.suggestionId ? { suggestionId: props.initial.suggestionId } : {}),
      providerId,
      partItemId: part?.id ?? null,
      partQuantity: part ? Math.max(1, Number(f.get("partQuantity")) || 1) : 1,
      usageEvery: useOn ? Number(f.get("usageEvery")) : null,
      firstReading: useOn && f.get("firstReading") ? Number(f.get("firstReading")) : undefined,
    });
  }
  const unit = meter.data?.unit ?? null;
  const useOn = byUse && Boolean(itemForUse) && Boolean(unit);

  const busy = save.isPending || remove.isPending;
  return (
    <Modal id="maintenance-task" title={task ? translateText("Edit maintenance") : translateText("New maintenance task")} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <fieldset className="space-y-4" disabled={!canEdit}>
          <div>
            <label className="label-text" htmlFor="task-title">
              {translateText("What needs doing")}</label>
            <input id="task-title" name="title" className="input" placeholder={translateText("e.g. Replace furnace filter")} defaultValue={initial.title} maxLength={200} required autoFocus />
          </div>

          <div className="space-y-2">
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" className="switch switch-primary" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
              <span className="label-text text-base">{translateText("Repeats")}</span>
            </label>
            {repeats && (
              <div className="flex items-center gap-2">
                <span className="text-base-content/80">{translateText("Every")}</span>
                <input
                  name="intervalCount"
                  type="number"
                  min={1}
                  max={1000}
                  className="input w-20"
                  defaultValue={initial.intervalCount ?? 3}
                  aria-label={translateText("How many")}
                  required
                />
                <select name="intervalUnit" className="select w-32" defaultValue={initial.intervalUnit ?? "month"} aria-label={translateText("Unit")}>
                  {intervalUnits.map((u) => (
                    <option key={u} value={u}>{intervalLabel(u, currentLanguage())}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {itemForUse && (
            <div className="space-y-2">
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" className="switch switch-primary" checked={byUse} onChange={(e) => setByUse(e.target.checked)} />
                <span className="label-text text-base">{repeats ? translateText("Also by use (whichever comes first)") : translateText("By use (miles, hours…)")}</span>
              </label>
              {byUse && !unit && meter.data && (
                <p className="text-sm text-base-content/70">{translateText("First say what it counts — on its page, under Track miles / hours.")}</p>
              )}
              {byUse && unit && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base-content/80">{translateText("Every")}</span>
                  <input name="usageEvery" type="number" min={1} max={10000000} className="input w-28" defaultValue={task?.usage?.every ?? ""} aria-label={translateText("How many {v0}", { v0: unit })} required />
                  <span className="text-base-content/80">{unit}</span>
                  {meter.data?.now == null && (
                    <label className="flex w-full items-center gap-2 text-sm">
                      {translateText("It says now")}<input name="firstReading" type="number" min={0} step="any" className="input input-sm w-32" aria-label={translateText("What it says now, in {v0}", { v0: unit })} required />
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="label-text" htmlFor="task-due">
              {task ? (task.usage ? translateText("Next due by date") : translateText("Next due")) : translateText("First due")}
            </label>
            {/* By use, the date shown is the one by time (the other is an estimate from the readings). */}
            <input id="task-due" name="dueOn" type="date" className="input" defaultValue={(task?.usage ? task.timeDueOn : task?.dueOn) ?? ""} />
            {!task && <p className="helper-text">{translateText("Leave empty: ")}{repeats ? translateText("one interval from today") : useOn ? translateText("when its use gets there") : translateText("today")}.</p>}
          </div>

          {!props.itemId && (
            <div className="space-y-4">
              <ItemPicker householdId={householdId} id="task-item" name="itemId" label={translateText("For an item")} value={forItem} onChange={setForItem} noneLabel={translateText("No item")} />
              {/* A task on an item is wherever the item is; without one, it can be for a place. */}
              {!forItem && (
                <PlacePicker
                  householdId={householdId}
                  id="task-place"
                  name="locationId"
                  label={translateText("Or a place")}
                  value={place}
                  onChange={setPlace}
                  noneLabel={translateText("The whole household")}
                />
              )}
            </div>
          )}

          {/* The consumable it uses up: Done takes it out of stock, and it's on the shopping list in time. */}
          <div className="space-y-2">
            <ItemPicker householdId={householdId} id="task-part" name="partItemId" label={translateText("Uses a part (from stock)")} value={part} onChange={setPart} noneLabel={translateText("Nothing")} exclude={forItem ? [forItem.id] : props.itemId ? [props.itemId] : []} />
            {part && (
              <label className="flex items-center gap-2 text-sm">
                <input name="partQuantity" type="number" min={1} max={1000} className="input input-sm w-20" defaultValue={task?.part?.uses ?? 1} aria-label={translateText("How many each time")} />
                {translateText("each time")}</label>
            )}
          </div>

          <ProviderPicker
            householdId={householdId}
            id="task-provider"
            label={translateText("Who does it")}
            value={providerId}
            onChange={setProviderId}
            noneLabel={translateText("We do it ourselves")}
          />

          <div>
            <label className="label-text" htmlFor="task-notes">
              {translateText("Notes")}</label>
            <textarea id="task-notes" name="notes" className="textarea" rows={2} defaultValue={initial.notes ?? ""} placeholder={translateText("Part numbers, how-to, who to call…")} maxLength={5000} />
          </div>
        </fieldset>

        {task && history.data && history.data.data.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-base-content/70">{translateText("Done before")}</h4>
            <ul className="space-y-1 text-sm">
              {history.data.data.slice(0, 6).map((h) => (
                <li key={h.id} className="flex gap-2">
                  <span className="w-28 shrink-0 text-base-content/70">{formatDate(h.doneOn)}</span>
                  <span className="min-w-0 flex-1 text-base-content/80">
                    {[h.doneByName, h.note, h.costCents != null ? money(h.costCents, true) : null].filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(save.isError || remove.isError) && <div className="alert alert-soft alert-error">{save.error?.message ?? remove.error?.message}</div>}

        {canEdit && task && (
          <div className="flex flex-wrap items-center gap-3 border-t border-base-300 pt-4">
            {confirmDelete ? (
              <>
                <span className="text-sm text-base-content/80">{translateText("Stop tracking it?")}</span>
                <button type="button" className="btn btn-error btn-sm" disabled={busy} onClick={() => remove.mutate()}>
                  {translateText("Remove")}</button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmDelete(false)}>
                  {translateText("Keep")}</button>
              </>
            ) : (
              <button type="button" className="btn btn-text btn-error" onClick={() => setConfirmDelete(true)}>
                <span className="icon-[tabler--trash] size-5" />
                {translateText("Remove")}</button>
            )}
          </div>
        )}

        {canEdit && (
          <DialogActions>
            <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
              {translateText("Cancel")}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {save.isPending && <span className="loading loading-spinner loading-sm" />}
              {task ? translateText("Save") : translateText("Add task")}
            </button>
          </DialogActions>
        )}
      </form>
    </Modal>
  );
}
