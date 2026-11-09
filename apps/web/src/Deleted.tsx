import { tn } from "./i18n";
import { locale } from "./i18n";
import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * #/deleted — "Recently deleted": items removed in the last 30 days, with who
 * removed them and when they go for good. Restore brings one back with its
 * photos, warranties and maintenance; "Delete now" removes it for good early.
 */
import { BarSearch } from "./Nav";
import type { DeletedItem } from "@ferret/shared";
import { TRASH_DAYS } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref } from "./lib/route";

export function Deleted({ householdId }: { householdId: string }) {
  const deleted = useQuery({ queryKey: ["trash", householdId], queryFn: api.listDeleted });
  const canEdit = useCanEdit(householdId);
  const [restored, setRestored] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar sticky top-0 z-10 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start min-w-0 items-center gap-2">
          <a href="#/" className="btn btn-text btn-sm btn-square" aria-label={translateText("Back")}>
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="truncate text-lg font-semibold">{translateText("Recently deleted")}</h1>
        </div>
        <BarSearch />
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-sm text-base-content/70">{tr("Deleted things stay here for {v0} days, with their photos, documents, warranties and maintenance, then go for good.", { v0: TRASH_DAYS })}</p>
        {restored && (
          <div className="alert alert-soft alert-success flex items-center gap-3 text-sm" role="status">
            <span className="icon-[tabler--circle-check] size-5" />
            <span className="flex-1">{tr("{v0} is back.", { v0: restored.name })}</span>
            <a href={itemHref(restored.id)} className="btn btn-soft btn-success btn-sm">
              {translateText("Open")}</a>
          </div>
        )}
        {deleted.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {deleted.isError && <div className="alert alert-soft alert-error">{deleted.error.message}</div>}
        {deleted.data?.data.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--trash-off] size-10 text-primary" />
              <h2 className="text-lg font-semibold">{translateText("Nothing deleted lately")}</h2>
              <p className="max-w-sm text-sm text-base-content/70">{tr("Anything you remove in the next {v0} days will wait here in case you change your mind.", { v0: TRASH_DAYS })}</p>
            </div>
          </div>
        )}
        {deleted.data && deleted.data.data.length > 0 && (
          <ul className="card divide-y divide-base-content/10">
            {deleted.data.data.map((d) => (
              <DeletedRow key={d.id} item={d} householdId={householdId} canEdit={canEdit} onRestored={setRestored} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function DeletedRow(props: {
  item: DeletedItem;
  householdId: string;
  canEdit: boolean;
  onRestored: (item: { id: string; name: string }) => void;
}) {
  const { item, householdId, canEdit } = props;
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () =>
    Promise.all(
      [["trash"], ["items"], ["places"], ["overview"], ["maintenance"], ["attention"]].map((key) =>
        qc.invalidateQueries({ queryKey: [...key, householdId] }),
      ),
    );
  const restore = useMutation({
    mutationFn: () => api.restoreDeleted(item.id),
    onSuccess: (back) => {
      props.onRestored(back);
      return refresh();
    },
  });
  const purge = useMutation({ mutationFn: () => api.deleteForGood(item.id), onSuccess: refresh });
  // The purge goes by the moment it was deleted (+30 days), not by calendar day.
  const daysLeft = Math.max(0, Math.ceil((Date.parse(item.deletedAt) + TRASH_DAYS * 86_400_000 - Date.now()) / 86_400_000));
  const about = [item.brand, item.model].filter(Boolean).join(" ");

  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <div className="avatar avatar-placeholder">
        <div className="size-12 rounded-box bg-base-200 text-base-content/40">
          {item.photoId ? (
            <img src={api.thumbnailUrl(item.photoId)} alt="" className="size-12 rounded-box object-cover opacity-70 grayscale" />
          ) : (
            <span className="icon-[tabler--box] size-6" />
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium text-base-content">{item.name}</h2>
        {about && <p className="truncate text-sm text-base-content/70">{about}</p>}
        <p className="text-xs text-base-content/70">{tr("Deleted {v0}", { v0: formatDay(item.deletedAt) })}{item.deletedBy && translateText(" by {v0}", { v0: item.deletedBy })} · {daysLeft === 0 ? translateText("goes for good today") : tn(daysLeft, "goes for good in {count} day", "goes for good in {count} days")}
        </p>
        {(restore.isError || purge.isError) && <p className="text-sm text-error">{restore.error?.message ?? purge.error?.message}</p>}
      </div>
      {canEdit &&
        (confirming ? (
          <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
            <span className="text-sm text-base-content/80">{translateText("Gone for good — no undo.")}</span>
            <button type="button" className="btn btn-error btn-sm" disabled={purge.isPending} onClick={() => purge.mutate()}>
              {translateText("Delete")}</button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(false)}>
              {translateText("Keep")}</button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
            <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--arrow-back-up] size-4" />}
              {translateText("Restore")}</button>
            <button type="button" className="btn btn-text btn-sm btn-error" onClick={() => setConfirming(true)}>
              {translateText("Delete now")}</button>
          </div>
        ))}
    </li>
  );
}

const formatDay = (iso: string) => new Date(iso).toLocaleDateString(locale(), { month: "short", day: "numeric" });
