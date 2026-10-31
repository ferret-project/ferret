/**
 * Maintenance: what's overdue, due soon and coming up across the household, with
 * "Done" (logs it and schedules the next one), and adding and editing tasks.
 * Also the Maintenance section on an item's page. Rows follow the FlyonUI list
 * pattern used elsewhere; the dialogs reuse the "Dashboard Modal 10" form layout.
 */
import { BarSearch } from "./Nav";
import type { MaintenanceInput, MaintenanceTask } from "@ferret/shared";
import { type IntervalUnit, describeInterval, describeUsage, intervalUnits, today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { type Choice, ItemPicker, PlacePicker } from "./Combobox";
import { AttentionBell } from "./AttentionBell";
import { ProviderPicker } from "./Providers";
import { itemHref, PROVIDERS_HREF } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { HelpLink } from "./HelpLink";
import { money } from "./Overview";
import { Mascot } from "./Mascot";

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

export function Maintenance({ householdName, householdId }: { householdName: string; householdId: string }) {
  const tasks = useQuery({ queryKey: [...maintenanceKey(householdId), "open"], queryFn: () => api.listMaintenance() });
  const canEdit = useCanEdit(householdId);
  const [editing, setEditing] = useState<MaintenanceTask | "new" | null>(null);
  const [doing, setDoing] = useState<MaintenanceTask | null>(null);
  const list = tasks.data?.data ?? [];
  const groups = [
    { key: "overdue", title: "Overdue", tasks: list.filter((t) => t.status === "overdue") },
    { key: "due", title: "Due in the next two weeks", tasks: list.filter((t) => t.status === "due") },
    { key: "upcoming", title: "Coming up", tasks: list.filter((t) => t.status === "upcoming") },
  ].filter((g) => g.tasks.length);

  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label="Back to your stuff">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold">Maintenance</h1>
          <HelpLink page="guide/maintenance.html" label="Maintenance" />
        </div>
        <BarSearch />
        <div className="navbar-end items-center gap-2">
          {/* On a phone the bar is full: providers are under More, the bell on the home screen. */}
          <a href={PROVIDERS_HREF} className="btn btn-text btn-sm btn-circle max-sm:hidden" aria-label="Service providers">
            <span className="icon-[tabler--address-book] size-5" />
          </a>
          <div className="max-sm:hidden">
            <AttentionBell householdId={householdId} />
          </div>
          {canEdit && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
              <span className="icon-[tabler--plus] size-4" />
              Task
            </button>
          )}
        </div>
      </nav>

      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {tasks.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {tasks.isError && <div className="alert alert-soft alert-error">{tasks.error.message}</div>}
        {tasks.data && list.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <Mascot pose="asleep" className="size-32" />
              <h2 className="text-lg font-semibold">Nothing to keep up with yet</h2>
              <p className="max-w-sm text-sm text-base-content/70">
                Track filters, servicing, gutters — anything {householdName} does on a schedule. Upload a manual to an item and Ferret
                suggests what it needs.
              </p>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
                  <span className="icon-[tabler--plus] size-5" />
                  Add a task
                </button>
              )}
            </div>
          </div>
        )}
        {groups.map((g) => (
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
          Maintenance
        </h2>
        {canEdit && (
          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing("new")}>
            <span className="icon-[tabler--plus] size-4" /> Add
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-base-content/70">Nothing scheduled. Upload the manual and Ferret will suggest what it needs.</p>
      ) : (
        <ul className="card divide-y divide-base-content/10 px-4">
          {list.map((t) => (
            <TaskRow key={t.id} task={t} canEdit={canEdit} onDone={() => setDoing(t)} onEdit={() => setEditing(t)} />
          ))}
        </ul>
      )}
      {editing && (
        <TaskModal householdId={householdId} itemId={itemId} task={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      )}
      {doing && <DoneModal householdId={householdId} task={doing} onClose={() => setDoing(null)} />}
    </section>
  );
}

const STATUS = {
  overdue: { dot: "bg-error", text: "text-error" },
  due: { dot: "bg-warning", text: "text-warning" },
  upcoming: { dot: "bg-primary/40", text: "text-base-content/70" },
  done: { dot: "bg-success", text: "text-success" },
} as const;

function TaskRow(props: { task: MaintenanceTask; showItem?: boolean; canEdit: boolean; onDone: () => void; onEdit: () => void }) {
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
        <span className={`block text-xs ${STATUS[t.status].text}`}>{dueText(t)}</span>
        {t.part && (
          <span className={`block truncate text-xs ${t.part.left < t.part.uses ? "text-warning" : "text-base-content/70"}`}>
            Uses {t.part.uses} × {t.part.name} · {t.part.left === 0 ? "none" : t.part.left} left
          </span>
        )}
      </button>
      {props.canEdit && t.status !== "done" && (
        <button type="button" className="btn btn-soft btn-success btn-sm" onClick={props.onDone} aria-label={`Mark ${t.title} done`}>
          <span className="icon-[tabler--check] size-4" />
          Done
        </button>
      )}
    </li>
  );
}

/** "every 3 months", "every 5,000 miles", "every 5,000 miles or 6 months" */
export function scheduleText(t: MaintenanceTask) {
  const byTime = describeInterval(t.intervalCount, t.intervalUnit);
  if (!t.usage) return byTime;
  const byUse = `every ${describeUsage(t.usage.every, t.usage.unit)}`;
  return t.intervalCount ? `${byUse} or ${t.intervalCount === 1 ? `a ${t.intervalUnit}` : byTime.replace(/^every /, "")}` : byUse;
}

function dueText(t: MaintenanceTask) {
  if (t.status === "done") return t.lastDoneOn ? `Done ${formatDate(t.lastDoneOn)}` : "Done";
  // By use: where the counter has to get to (and an estimated date says so).
  const at = t.usage ? ` · at ${describeUsage(t.usage.dueAt, t.usage.unit)}` : "";
  const days = Math.round((Date.parse(`${t.dueOn}T00:00:00`) - Date.parse(`${today()}T00:00:00`)) / 86_400_000);
  if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} overdue${at}`;
  if (days === 0) return `Due today${at}`;
  if (t.dueEstimated) return `Due around ${formatDate(t.dueOn!)}${at}`;
  if (days === 1) return `Due tomorrow${at}`;
  if (days < 14) return `Due in ${days} days${at}`;
  return `Due ${formatDate(t.dueOn!)}${at}`;
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

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
    const cost = Number.parseFloat(String(f.get("cost") || "").replace(",", "."));
    done.mutate({
      doneOn: String(f.get("doneOn")),
      note: String(f.get("note") || "").trim() || null,
      costCents: Number.isFinite(cost) ? Math.round(cost * 100) : null,
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
              ? `Ferret schedules the next one ${scheduleText(task)} from now.`
              : task.intervalCount
                ? `Ferret schedules the next one ${describeInterval(task.intervalCount, task.intervalUnit)} from this day.`
                : "Marks it done."}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="done-on">
              Done on
            </label>
            <input id="done-on" name="doneOn" type="date" className="input" defaultValue={today()} max={today()} required />
          </div>
          <div>
            <label className="label-text" htmlFor="done-cost">
              Cost
            </label>
            <div className="input">
              <span className="my-auto me-1 text-base-content/70">$</span>
              <input id="done-cost" name="cost" className="grow" inputMode="decimal" placeholder="optional" />
            </div>
          </div>
          {task.usage && (
            <div className="col-span-2">
              <label className="label-text" htmlFor="done-reading">
                What it says now ({task.usage.unit})
              </label>
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
              Note
            </label>
            <input id="done-note" name="note" className="input" placeholder="e.g. MERV 11 filter, 16×25×1" maxLength={2000} />
          </div>
        </div>
        <ProviderPicker householdId={householdId} id="done-by" label="Who did it" value={doneBy} onChange={setDoneBy} noneLabel="We did" />
        {task.part && (
          <label className="flex min-h-11 items-start gap-3">
            <input type="checkbox" className="checkbox checkbox-primary mt-0.5" checked={usePart} onChange={(e) => setUsePart(e.target.checked)} />
            <span>
              <span className="label-text block text-base">
                Took {task.part.uses} {task.part.name} from stock
              </span>
              <span className="text-sm text-base-content/70">
                {task.part.left < task.part.uses ? `Only ${task.part.left} recorded — it won't go below 0.` : `${task.part.left} → ${task.part.left - task.part.uses} left`}
              </span>
            </span>
          </label>
        )}
        {done.isError && <div className="alert alert-soft alert-error">{done.error.message}</div>}
        <div className="flex flex-wrap items-center justify-end gap-4">
          <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-success" disabled={done.isPending}>
            {done.isPending && <span className="loading loading-spinner loading-sm" />}
            Mark done
          </button>
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
    task?.itemId ? { id: task.itemId, label: task.itemName ?? "Item", detail: task.place } : null,
  );
  const [place, setPlace] = useState<string | null>(task?.locationId ?? props.initial?.locationId ?? null);
  const [providerId, setProviderId] = useState<string | null>(task?.providerId ?? null);
  const [part, setPart] = useState<Choice | null>(task?.part ? { id: task.part.itemId, label: task.part.name, detail: `${task.part.left} left` } : null);
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
    <Modal id="maintenance-task" title={task ? "Edit maintenance" : "New maintenance task"} onClose={onClose}>
      <form className="flex flex-col gap-6" onSubmit={onSubmit}>
        <fieldset className="space-y-4" disabled={!canEdit}>
          <div>
            <label className="label-text" htmlFor="task-title">
              What needs doing
            </label>
            <input id="task-title" name="title" className="input" placeholder="e.g. Replace furnace filter" defaultValue={initial.title} maxLength={200} required autoFocus />
          </div>

          <div className="space-y-2">
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" className="switch switch-primary" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
              <span className="label-text text-base">Repeats</span>
            </label>
            {repeats && (
              <div className="flex items-center gap-2">
                <span className="text-base-content/80">Every</span>
                <input
                  name="intervalCount"
                  type="number"
                  min={1}
                  max={1000}
                  className="input w-20"
                  defaultValue={initial.intervalCount ?? 3}
                  aria-label="How many"
                  required
                />
                <select name="intervalUnit" className="select w-32" defaultValue={initial.intervalUnit ?? "month"} aria-label="Unit">
                  {intervalUnits.map((u) => (
                    <option key={u} value={u}>
                      {u}s
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {itemForUse && (
            <div className="space-y-2">
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" className="switch switch-primary" checked={byUse} onChange={(e) => setByUse(e.target.checked)} />
                <span className="label-text text-base">{repeats ? "Also by use (whichever comes first)" : "By use (miles, hours…)"}</span>
              </label>
              {byUse && !unit && meter.data && (
                <p className="text-sm text-base-content/70">First say what it counts — on its page, under Track miles / hours.</p>
              )}
              {byUse && unit && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base-content/80">Every</span>
                  <input name="usageEvery" type="number" min={1} max={10000000} className="input w-28" defaultValue={task?.usage?.every ?? ""} aria-label={`How many ${unit}`} required />
                  <span className="text-base-content/80">{unit}</span>
                  {meter.data?.now == null && (
                    <label className="flex w-full items-center gap-2 text-sm">
                      It says now
                      <input name="firstReading" type="number" min={0} step="any" className="input input-sm w-32" aria-label={`What it says now, in ${unit}`} required />
                    </label>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="label-text" htmlFor="task-due">
              {task ? (task.usage ? "Next due by date" : "Next due") : "First due"}
            </label>
            {/* By use, the date shown is the one by time (the other is an estimate from the readings). */}
            <input id="task-due" name="dueOn" type="date" className="input" defaultValue={(task?.usage ? task.timeDueOn : task?.dueOn) ?? ""} />
            {!task && <p className="helper-text">Leave empty: {repeats ? "one interval from today" : useOn ? "when its use gets there" : "today"}.</p>}
          </div>

          {!props.itemId && (
            <div className="space-y-4">
              <ItemPicker householdId={householdId} id="task-item" name="itemId" label="For an item" value={forItem} onChange={setForItem} noneLabel="No item" />
              {/* A task on an item is wherever the item is; without one, it can be for a place. */}
              {!forItem && (
                <PlacePicker
                  householdId={householdId}
                  id="task-place"
                  name="locationId"
                  label="Or a place"
                  value={place}
                  onChange={setPlace}
                  noneLabel="The whole household"
                />
              )}
            </div>
          )}

          {/* The consumable it uses up: Done takes it out of stock, and it's on the shopping list in time. */}
          <div className="space-y-2">
            <ItemPicker householdId={householdId} id="task-part" name="partItemId" label="Uses a part (from stock)" value={part} onChange={setPart} noneLabel="Nothing" exclude={forItem ? [forItem.id] : props.itemId ? [props.itemId] : []} />
            {part && (
              <label className="flex items-center gap-2 text-sm">
                <input name="partQuantity" type="number" min={1} max={1000} className="input input-sm w-20" defaultValue={task?.part?.uses ?? 1} aria-label="How many each time" />
                each time
              </label>
            )}
          </div>

          <ProviderPicker
            householdId={householdId}
            id="task-provider"
            label="Who does it"
            value={providerId}
            onChange={setProviderId}
            noneLabel="We do it ourselves"
          />

          <div>
            <label className="label-text" htmlFor="task-notes">
              Notes
            </label>
            <textarea id="task-notes" name="notes" className="textarea" rows={2} defaultValue={initial.notes ?? ""} placeholder="Part numbers, how-to, who to call…" maxLength={5000} />
          </div>
        </fieldset>

        {task && history.data && history.data.data.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-base-content/70">Done before</h4>
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
                <span className="text-sm text-base-content/80">Stop tracking it?</span>
                <button type="button" className="btn btn-error btn-sm" disabled={busy} onClick={() => remove.mutate()}>
                  Remove
                </button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-text btn-error" onClick={() => setConfirmDelete(true)}>
                <span className="icon-[tabler--trash] size-5" />
                Remove
              </button>
            )}
          </div>
        )}

        {canEdit && (
          <DialogActions>
            <button type="button" className="btn btn-secondary btn-soft" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {save.isPending && <span className="loading loading-spinner loading-sm" />}
              {task ? "Save" : "Add task"}
            </button>
          </DialogActions>
        )}
      </form>
    </Modal>
  );
}
