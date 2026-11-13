/**
 * On a thing's page (server: lib/repairs.ts): its repairs (Log a repair — what went wrong, what was done, who, parts,
 * cost, photos, a repair warranty, the maintenance task it belongs to), what owning it has cost, and what replaced it /
 * what it replaced.
 */
import type { ItemLifespan, ItemListing, Repair } from "@ferret/shared";
import { today } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { centsToInput, currencySymbol, money, toCents } from "./lib/money";
import { itemHref } from "./lib/route";
import { DialogActions, Modal } from "./Modal";
import { ProviderPicker } from "./Providers";
import { dueText } from "./Replacements";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

const formatDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "Replaced by New fridge" / "Replaces Old fridge" — both pages link the other. */
export function ReplacedLine({ item }: { item: ItemListing }) {
  if (!item.replacedBy && !item.replaces?.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-content/80">
      <span className="icon-[tabler--replace] size-4 shrink-0" />
      {item.replacedBy && (
        <a href={itemHref(item.replacedBy.id)} className="tap link link-hover text-primary">
          <Trans>Replaced by {ph({ name: item.replacedBy.name })}</Trans>
        </a>
      )}
      {item.replaces?.map((r) => (
        <a key={r.id} href={itemHref(r.id)} className="tap link link-hover text-primary">
          <Trans>Replaces {ph({ name: r.name })}</Trans>
        </a>
      ))}
    </p>
  );
}

/** What owning it has cost: in total and per year, with what went into it. */
export function OwnershipCard({ itemId, householdId, lifespan }: { itemId: string; householdId: string; lifespan?: ItemLifespan | null }) {
  const cost = useQuery({ queryKey: ["item", householdId, itemId, "cost"], queryFn: () => api.ownershipCost(itemId) });
  const c = cost.data;
  // Nothing to add up beyond the price: the price line already says it.
  if (!c || (!c.maintenanceCents && !c.repairCents && !c.backCents)) return null;
  const parts = [
    c.paidCents != null ? t`paid ${ph({ amount: money(c.paidCents) })}` : null,
    c.maintenanceCents ? t`maintenance ${ph({ amount: money(c.maintenanceCents) })}` : null,
    c.repairCents ? t`repairs ${ph({ amount: money(c.repairCents) })}` : null,
    c.backCents ? t`got back ${ph({ amount: money(c.backCents) })}` : null,
  ].filter(Boolean);
  const years = c.years.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <section className="card">
      <div className="card-body gap-1 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--receipt-2] size-5 text-primary" />
          <Trans>Cost of owning it</Trans>
        </h2>
        <p className="text-base-content">
          <span className="text-lg font-semibold">{money(c.totalCents)}</span>{" "}
          {/* Per year only once there's more than a year to spread it over. */}
          {c.years >= 2 && (
            <span className="text-sm text-base-content/70">
              <Trans>· about {ph({ perYear: money(c.perYearCents) })} a year over {years} years</Trans>
            </span>
          )}
        </p>
        <p className="text-sm text-base-content/70">{parts.join(" · ")}</p>
        {lifespan && <p className="text-sm text-base-content/70">{dueText(lifespan)}</p>}
      </div>
    </section>
  );
}

/** The item page's Repairs section. */
export function ItemRepairs({ item, householdId }: { item: ItemListing; householdId: string }) {
  const canEdit = useCanEdit(householdId);
  const key = ["item", householdId, item.id, "repairs"];
  const repairs = useQuery({ queryKey: key, queryFn: () => api.listRepairs(item.id) });
  const [editing, setEditing] = useState<Repair | "new" | null>(null);
  const list = repairs.data?.data ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--hammer] size-5 text-primary" />
          <Trans>Repairs</Trans>
          {list.length > 0 && <span className="badge badge-soft badge-primary badge-sm">{list.length}</span>}
        </h2>
        {canEdit && !item.disposition && (
          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing("new")}>
            <span className="icon-[tabler--plus] size-4" /> <Trans>Log a repair</Trans>
          </button>
        )}
      </div>
      {repairs.isError && <div className="alert alert-soft alert-error">{repairs.error.message}</div>}
      {list.length === 0 ? (
        <p className="text-sm text-base-content/70"><Trans>Nothing fixed yet. When something is, log it here — it counts in what owning it has cost.</Trans></p>
      ) : (
        <ul className="card divide-y divide-base-content/10 px-4">
          {list.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-base-content">{r.work}</p>
                  <p className="text-sm text-base-content/70">
                    {[formatDay(r.repairedOn), r.providerName, r.costCents != null ? money(r.costCents) : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {canEdit && (
                  <button type="button" className="btn btn-text btn-sm shrink-0" onClick={() => setEditing(r)}>
                    <Trans>Edit</Trans>
                  </button>
                )}
              </div>
              {r.problem && <p className="text-sm text-base-content/80"><Trans>Problem: {ph({ problem: r.problem })}</Trans></p>}
              {r.parts && <p className="text-sm text-base-content/80"><Trans>Parts: {ph({ parts: r.parts })}</Trans></p>}
              {r.warrantyEndsOn && <p className="text-sm text-base-content/80"><Trans>Repair warranty until {ph({ day: formatDay(r.warrantyEndsOn) })}</Trans></p>}
              {r.taskTitle && <p className="text-sm text-base-content/70"><Trans>Part of: {ph({ task: r.taskTitle })}</Trans></p>}
              {r.attachmentIds.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {r.attachmentIds.map((id) => (
                    <a key={id} href={api.attachmentUrl(id)} target="_blank" rel="noreferrer">
                      <img src={api.thumbnailUrl(id)} alt={t`A photo of the repair`} loading="lazy" className="size-16 rounded-field object-cover" />
                    </a>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <RepairDialog item={item} householdId={householdId} repair={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function RepairDialog({ item, householdId, repair, onClose }: { item: ItemListing; householdId: string; repair?: Repair; onClose: () => void }) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState<string | null>(repair?.providerId ?? null);
  const [photos, setPhotos] = useState<File[]>([]);
  const tasks = useQuery({ queryKey: ["maintenance", householdId, "item", item.id], queryFn: () => api.listMaintenance({ itemId: item.id, status: "all" }) });
  const refresh = () => {
    for (const k of [["item", householdId, item.id], ["warranties", householdId], ["overview", householdId]]) void qc.invalidateQueries({ queryKey: k });
  };
  const save = useMutation({
    mutationFn: async (f: FormData) => {
      const text = (name: string) => String(f.get(name) ?? "").trim() || null;
      const fields = {
        repairedOn: String(f.get("repairedOn")),
        work: String(f.get("work")).trim(),
        problem: text("problem"),
        providerId,
        parts: text("parts"),
        costCents: toCents(f.get("cost")),
        taskId: text("taskId"),
      };
      const saved = repair ? await api.updateRepair(repair.id, fields) : await api.createRepair(item.id, { ...fields, warrantyEndsOn: text("warrantyEndsOn") });
      for (const file of photos) await api.uploadAttachment(item.id, file, file.type === "application/pdf" ? "document" : "photo", () => {}, { repairId: saved.id });
      return saved;
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRepair(repair!.id),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save.mutate(new FormData(e.currentTarget));
  };
  const taskList = tasks.data?.data ?? [];
  return (
    <Modal id="repair-dialog" title={repair ? t`Edit the repair` : t`Log a repair`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div>
          <label className="label-text" htmlFor="repair-work">
            <Trans>What was done</Trans>
          </label>
          <input id="repair-work" name="work" className="input" required maxLength={300} defaultValue={repair?.work} placeholder={t`e.g. Replaced the drain pump`} autoFocus />
        </div>
        <div>
          <label className="label-text" htmlFor="repair-problem">
            <Trans>What went wrong</Trans>
          </label>
          <textarea id="repair-problem" name="problem" className="textarea" rows={2} maxLength={2000} defaultValue={repair?.problem ?? ""} placeholder={t`e.g. Wouldn't drain, error E21`} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label-text" htmlFor="repair-on">
              <Trans>When</Trans>
            </label>
            <input id="repair-on" name="repairedOn" type="date" className="input" required max={today()} defaultValue={repair?.repairedOn ?? today()} />
          </div>
          <div>
            <label className="label-text" htmlFor="repair-cost">
              <Trans>Cost</Trans>
            </label>
            <div className="input">
              <span className="my-auto me-1 text-base-content/70">{currencySymbol()}</span>
              <input id="repair-cost" name="cost" className="grow" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]{0,2}" defaultValue={centsToInput(repair?.costCents)} />
            </div>
          </div>
        </div>
        <ProviderPicker householdId={householdId} id="repair-provider" label={t`Who did it`} value={providerId} onChange={setProviderId} noneLabel={t`We did`} />
        <div>
          <label className="label-text" htmlFor="repair-parts">
            <Trans>Parts</Trans>
          </label>
          <input id="repair-parts" name="parts" className="input" maxLength={1000} defaultValue={repair?.parts ?? ""} placeholder={t`e.g. Pump 00436440`} />
        </div>
        {taskList.length > 0 && (
          <div>
            <label className="label-text" htmlFor="repair-task">
              <Trans>Part of a maintenance task</Trans>
            </label>
            <select id="repair-task" name="taskId" className="select" defaultValue={repair?.taskId ?? ""}>
              <option value="">{t`No`}</option>
              {taskList.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </div>
        )}
        {!repair && (
          <div>
            <label className="label-text" htmlFor="repair-warranty">
              <Trans>The repair's own warranty ends</Trans>
            </label>
            <input id="repair-warranty" name="warrantyEndsOn" type="date" className="input max-w-52" />
            <p className="mt-1 text-xs text-base-content/70"><Trans>If the repair is guaranteed, it's added to the warranties.</Trans></p>
          </div>
        )}
        <div>
          <label className="label-text" htmlFor="repair-photos">
            <Trans>Photos or the invoice</Trans>
          </label>
          <input id="repair-photos" type="file" multiple accept="image/*,application/pdf" className="input" onChange={(e) => setPhotos([...(e.target.files ?? [])])} />
          {photos.length > 0 && <p className="mt-1 text-xs text-base-content/70">{plural(photos.length, { one: "# file to add", other: "# files to add" })}</p>}
        </div>
        {repair && (
          <div className="border-t border-base-300 pt-3">
            <button type="button" className="btn btn-text btn-error btn-sm" disabled={remove.isPending} onClick={() => window.confirm(t`Remove this repair? Its photos and warranty stay with the item.`) && remove.mutate()}>
              <span className="icon-[tabler--trash] size-4" />
              <Trans>Remove the repair</Trans>
            </button>
          </div>
        )}
        {(save.isError || remove.isError) && <div className="alert alert-soft alert-error">{(save.error ?? remove.error)!.message}</div>}
        <DialogActions>
          <button type="button" className="btn btn-text" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending && <span className="loading loading-spinner loading-sm" />}
            {repair ? t`Save` : t`Log it`}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}
