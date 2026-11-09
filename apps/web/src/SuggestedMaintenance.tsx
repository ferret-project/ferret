import { currentLanguage } from "./i18n";
import { t as translateText } from "./i18n";
/**
 * Suggested maintenance (server: lib/suggested-tasks.ts): schedules read from manuals and the AI's typical upkeep for a
 * thing's kind, gathered for the whole household (the Maintenance screen) or one item (its page). Nothing is added by
 * itself: Add opens the task filled in, to adjust; Not needed is remembered.
 */
import type { SuggestedTask } from "@ferret/shared";
import { describeInterval } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { useFeatures } from "./lib/features";
import { itemHref } from "./lib/route";
import { TaskModal, maintenanceKey } from "./Maintenance";

export const suggestedKey = (householdId: string) => [...maintenanceKey(householdId), "suggested"];

export function SuggestedMaintenance({ householdId, itemId }: { householdId: string; itemId?: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const features = useFeatures();
  const list = useQuery({ queryKey: [...suggestedKey(householdId), itemId ?? "all"], queryFn: () => api.suggestedTasks(itemId) });
  const [adding, setAdding] = useState<SuggestedTask | null>(null);
  const [asked, setAsked] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: suggestedKey(householdId) });
  const dismiss = useMutation({ mutationFn: api.dismissSuggestedTask, onSuccess: refresh });
  const typical = useMutation({ mutationFn: () => api.findTypicalUpkeep(itemId), onSuccess: () => setAsked(true) });
  const rows = list.data?.data ?? [];
  if (!canEdit) return null;
  const offerTypical = Boolean(features?.textAi);
  if (!rows.length && !offerTypical) return null;
  // On an item's page with nothing to show: just the small "typical upkeep" button.
  if (!rows.length && itemId) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className="btn btn-text btn-sm" disabled={typical.isPending || asked} onClick={() => typical.mutate()}>
          <span className="icon-[tabler--sparkles] size-4 text-primary" />
          {asked ? translateText("Asked — suggestions appear here") : translateText("Suggest typical upkeep")}
        </button>
        {typical.isError && <span className="text-error">{typical.error.message}</span>}
      </div>
    );
  }
  return (
    <section className="card border border-primary/20" aria-labelledby={`suggested-${itemId ?? "all"}`}>
      <div className="card-body gap-2 p-4 sm:p-6">
        <h2 id={`suggested-${itemId ?? "all"}`} className="flex items-center gap-2 font-semibold">
          <span className="icon-[tabler--sparkles] size-5 text-primary" />
          {translateText("Suggested maintenance")}{rows.length > 0 && <span className="badge badge-soft badge-primary badge-sm">{rows.length}</span>}
        </h2>
        {rows.length === 0 && (
          <p className="text-sm text-base-content/70">
            {translateText("Upkeep read from your manuals shows up here to add. Ferret can also suggest what things like yours usually need.")}</p>
        )}
        <ul className="divide-y divide-base-content/10">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {s.title} — {describeInterval(s.intervalCount, s.intervalUnit, currentLanguage())}
                </span>
                <span className="block text-xs text-base-content/70">
                  {!itemId && (
                    <>
                      <a href={itemHref(s.itemId)} className="tap link link-hover">
                        {s.itemName}
                      </a>
                      {" · "}
                    </>
                  )}
                  {s.source === "manual" ? translateText("from {v0}", { v0: s.filename ?? translateText("its manual") }) : translateText("typical for things like it — check its manual")}
                </span>
              </span>
              <span className="flex gap-1">
                <button type="button" className="btn btn-text btn-primary btn-sm" onClick={() => setAdding(s)} aria-label={translateText("Add {v0}", { v0: s.title })}>
                  {translateText("Add")}</button>
                <button type="button" className="btn btn-text btn-sm" disabled={dismiss.isPending} onClick={() => dismiss.mutate(s.id)} aria-label={translateText("{v0} isn't needed", { v0: s.title })}>
                  {translateText("Not needed")}</button>
              </span>
            </li>
          ))}
        </ul>
        {offerTypical && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-soft btn-sm" disabled={typical.isPending || asked} onClick={() => typical.mutate()}>
              <span className="icon-[tabler--sparkles] size-4" />
              {asked ? translateText("Asked — new suggestions appear here") : itemId ? translateText("Suggest typical upkeep") : translateText("Suggest typical upkeep for my things")}
            </button>
            {typical.isError && <span className="text-sm text-error">{typical.error.message}</span>}
          </div>
        )}
        {dismiss.isError && <div className="alert alert-soft alert-error text-sm">{dismiss.error.message}</div>}
      </div>
      {adding && (
        <TaskModal
          householdId={householdId}
          itemId={adding.itemId}
          initial={{ title: adding.title, intervalCount: adding.intervalCount, intervalUnit: adding.intervalUnit, attachmentId: adding.attachmentId, suggestionId: adding.id }}
          onClose={() => {
            setAdding(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
