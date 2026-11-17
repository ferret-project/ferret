/**
 * #/deleted — "Recently deleted": items removed in the last 30 days, with who
 * removed them and when they go for good. Restore brings one back with its
 * photos, warranties and maintenance; "Delete now" removes it for good early.
 */
import { TopBar } from "./Nav";
import type { DeletedItem } from "@ferret/shared";
import { TRASH_DAYS } from "@ferret/shared/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { itemHref } from "./lib/route";
import { t, ph, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

export function Deleted({ householdId }: { householdId: string }) {
  const deleted = useQuery({ queryKey: ["trash", householdId], queryFn: api.listDeleted });
  const canEdit = useCanEdit(householdId);
  const [restored, setRestored] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="min-h-dvh bg-base-200">
      <TopBar
        title={<Trans>Recently deleted</Trans>}
        back="#/"
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-sm text-base-content/70">
          <Trans>Deleted things stay here for {TRASH_DAYS} days, with their photos, documents, warranties and maintenance, then go
          for good.</Trans>
        </p>
        {restored && (
          <div className="alert alert-soft alert-success flex items-center gap-3 text-sm" role="status">
            <span className="icon-[tabler--circle-check] size-5" />
            <Trans><span className="flex-1">{ph({ name: restored.name })} is back.</span>
            <a href={itemHref(restored.id)} className="btn btn-soft btn-success btn-sm">
              Open
            </a></Trans>
          </div>
        )}
        {deleted.isPending && <span className="loading loading-spinner text-primary mx-auto my-12" />}
        {deleted.isError && <div className="alert alert-soft alert-error">{deleted.error.message}</div>}
        {deleted.data?.data.length === 0 && (
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--trash-off] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>Nothing deleted lately</Trans></h2>
              <p className="max-w-sm text-sm text-base-content/70"><Trans>Anything you remove in the next {TRASH_DAYS} days will wait here in case you change your mind.</Trans></p>
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
        <p className="text-xs text-base-content/70">
          {item.deletedBy ? t`Deleted ${ph({ date: formatDay(item.deletedAt) })} by ${ph({ person: item.deletedBy })}` : t`Deleted ${ph({ date: formatDay(item.deletedAt) })}`} ·{" "}
          {daysLeft === 0 ? t`goes for good today` : plural(daysLeft, { one: "goes for good in # day", other: "goes for good in # days" })}
        </p>
        {(restore.isError || purge.isError) && <p className="text-sm text-error">{restore.error?.message ?? purge.error?.message}</p>}
      </div>
      {canEdit &&
        (confirming ? (
          <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
            <Trans><span className="text-sm text-base-content/80">Gone for good — no undo.</span></Trans>
            <button type="button" className="btn btn-error btn-sm" disabled={purge.isPending} onClick={() => purge.mutate()}>
              <Trans>Delete</Trans>
            </button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setConfirming(false)}>
              <Trans>Keep</Trans>
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
            <button type="button" className="btn btn-soft btn-primary btn-sm" disabled={restore.isPending} onClick={() => restore.mutate()}>
              {restore.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--arrow-back-up] size-4" />}
              <Trans>Restore</Trans>
            </button>
            <button type="button" className="btn btn-text btn-sm btn-error" onClick={() => setConfirming(true)}>
              <Trans>Delete now</Trans>
            </button>
          </div>
        ))}
    </li>
  );
}

const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
