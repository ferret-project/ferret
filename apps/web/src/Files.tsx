/**
 * Photos and documents of a property, a place, a maintenance task or a done record (server: lib/attachments.ts
 * `FileOwner`): a deed or the insurance policy on the house, an inspection report on a room, the plumber's invoice on
 * a done record. Hidden while empty — whoever can edit gets a small "Add a document or photo" button instead (like the
 * item page's empty sections). Not read by the AI: only a thing's files are.
 */
import type { Attachment, FileHit, FileOwnerQuery } from "@ferret/shared";
import { MAINTENANCE_HREF, placeHref, propertyHref } from "./lib/route";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useRef, useState } from "react";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { PhotoViewer } from "./PhotoViewer";
import { ph, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

export const filesKey = (householdId: string, of?: FileOwnerQuery) => ["files", householdId, ...(of ? [JSON.stringify(of)] : [])];

/** What the file picker takes: photos, and PDFs (receipts, manuals, reports). */
export const ACCEPT = "image/*,application/pdf";

export function FilesSection({
  of,
  householdId,
  title,
  emptyLabel,
  only,
  className = "",
}: {
  of: FileOwnerQuery;
  householdId: string;
  title: string;
  emptyLabel?: string;
  /** Show only some of them (a task's own files, not its done records'). */
  only?: (f: Attachment) => boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const key = filesKey(householdId, of);
  const files = useQuery({ queryKey: key, queryFn: () => api.listFiles(of) });
  const picker = useRef<HTMLInputElement>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["attachments", householdId] })]);
  const add = useMutation({
    mutationFn: async (picked: File[]) => {
      for (const f of picked) await api.uploadFile(of, f, f.type.startsWith("image/") ? "photo" : "document");
    },
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteAttachment, onSuccess: refresh });

  const list = (files.data?.data ?? []).filter(only ?? (() => true));
  const photos = list.filter((f) => f.kind === "photo");
  const documents = list.filter((f) => f.kind === "document");
  const pick = () => picker.current?.click();
  const input = (
    <input
      ref={picker}
      type="file"
      hidden
      multiple
      accept={ACCEPT}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.length) add.mutate([...e.target.files]);
        e.target.value = ""; // the same file again
      }}
    />
  );
  const status = (
    <>
      {add.isPending && (
        <p className="flex items-center gap-2 text-sm text-base-content/70">
          <span className="loading loading-spinner loading-xs" /> <Trans>Uploading…</Trans>
        </p>
      )}
      {add.isError && <div className="alert alert-soft alert-error text-sm">{add.error.message}</div>}
      {remove.isError && <div className="alert alert-soft alert-error text-sm">{remove.error.message}</div>}
    </>
  );
  const confirmRemove = (f: Attachment) => window.confirm(t`Remove ${ph({ filename: f.filename })}?`) && remove.mutate(f.id);

  if (!files.data) return null;
  if (!list.length) {
    if (!canEdit) return null;
    return (
      <div className={`flex flex-col items-start gap-2 ${className}`}>
        <button type="button" className="btn btn-soft btn-secondary btn-sm" onClick={pick} disabled={add.isPending}>
          <span className="icon-[tabler--files] size-4" />
          {emptyLabel ?? t`Add a document or photo`}
        </button>
        {input}
        {status}
      </div>
    );
  }

  return (
    <section className={`flex flex-col gap-3 ${className}`} aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-base-content">
          <span className="icon-[tabler--files] size-5 text-primary" />
          {title}
          <span className="badge badge-soft badge-primary badge-sm">{list.length}</span>
        </h2>
        {canEdit && (
          <button type="button" className="btn btn-text btn-sm" onClick={pick} disabled={add.isPending}>
            <span className="icon-[tabler--plus] size-4" />
            <Trans>Add</Trans>
          </button>
        )}
      </div>
      {input}
      {status}
      {photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {photos.map((p, i) => (
            <figure key={p.id} className="relative">
              <button
                type="button"
                className="block size-full rounded-box focus-visible:outline-2 focus-visible:outline-primary"
                aria-label={t`Show ${ph({ filename: p.filename })} full screen`}
                onClick={() => setViewing(i)}
              >
                <img src={api.thumbnailUrl(p.id)} alt={p.filename} loading="lazy" className="aspect-square w-full rounded-box bg-base-300 object-cover" />
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="btn btn-circle btn-sm absolute end-1.5 top-1.5 border-0 bg-base-100/85 text-base-content shadow-sm"
                  aria-label={t`Remove ${ph({ filename: p.filename })}`}
                  onClick={() => confirmRemove(p)}
                >
                  <span className="icon-[tabler--trash] size-4" />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
      {documents.length > 0 && (
        <ul className="flex flex-col gap-2">
          {documents.map((d) => (
            <li key={d.id} className="card">
              <div className="card-body flex-row items-center gap-3 p-3">
                {d.hasThumbnail ? (
                  <a href={api.attachmentUrl(d.id)} target="_blank" rel="noreferrer" className="shrink-0" aria-hidden tabIndex={-1}>
                    <img src={api.thumbnailUrl(d.id)} alt="" loading="lazy" className="h-14 w-11 rounded-field border border-base-content/10 bg-white object-cover object-top" />
                  </a>
                ) : (
                  <FileIcon contentType={d.contentType} />
                )}
                <a href={api.attachmentUrl(d.id)} target="_blank" rel="noreferrer" className="link link-hover min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-base-content/80">{d.filename}</span>
                  <span className="text-xs text-base-content/70">{d.originalRemoved ? t`Small copy only` : formatSize(d.size)}</span>
                </a>
                {canEdit && (
                  <button type="button" className="btn btn-circle btn-text btn-sm" aria-label={t`Remove ${ph({ filename: d.filename })}`} onClick={() => confirmRemove(d)}>
                    <span className="icon-[tabler--trash] size-4" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {viewing !== null && (
        <PhotoViewer
          title={title}
          photos={photos.map((p) => ({ id: p.id, filename: p.filename, caption: undefined, smallCopy: p.originalRemoved }))}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}

/**
 * A done record's files, on its line in a task's "Done before": links to open them, and (for whoever can edit) a
 * paperclip to add the invoice or photos afterwards. `files`: the task's (filesKey with taskId), shared with the dialog.
 */
export function DoneFiles({ householdId, taskId, doneId, files }: { householdId: string; taskId: string; doneId: string; files: Attachment[] }) {
  const qc = useQueryClient();
  const canEdit = useCanEdit(householdId);
  const picker = useRef<HTMLInputElement>(null);
  const add = useMutation({
    mutationFn: async (picked: File[]) => {
      for (const f of picked) await api.uploadFile({ doneId }, f, f.type.startsWith("image/") ? "photo" : "document");
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: filesKey(householdId, { taskId }) }), qc.invalidateQueries({ queryKey: ["attachments", householdId] })]),
  });
  const mine = files.filter((f) => f.doneId === doneId);
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {mine.map((f) => (
        <a key={f.id} href={api.attachmentUrl(f.id)} target="_blank" rel="noreferrer" className="link link-primary tap inline-flex max-w-48 items-center gap-1">
          <span className={`${f.kind === "photo" ? "icon-[tabler--photo]" : "icon-[tabler--file-text]"} size-4 shrink-0`} />
          <span className="truncate">{f.filename}</span>
        </a>
      ))}
      {canEdit && (
        <>
          <button
            type="button"
            className="btn btn-circle btn-text btn-xs"
            aria-label={t`Add the invoice or photos`}
            title={t`Add the invoice or photos`}
            disabled={add.isPending}
            onClick={() => picker.current?.click()}
          >
            {add.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--paperclip] size-4" />}
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            accept={ACCEPT}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              if (e.target.files?.length) add.mutate([...e.target.files]);
              e.target.value = "";
            }}
          />
        </>
      )}
      {add.isError && <span className="text-error">{add.error.message}</span>}
    </span>
  );
}

/**
 * Search's "In documents": a property's, a room's or a task's own files whose name or text matched — each opens the
 * file, with what it belongs to beside it (`data-result`: ↑/↓ reach them like the things above).
 */
export function FileMatches({ files }: { files: FileHit[] }) {
  const where = (f: FileHit) => (f.of.kind === "property" ? propertyHref(f.of.id) : f.of.kind === "place" ? placeHref(f.of.id) : MAINTENANCE_HREF);
  return (
    <section className="mt-4 flex flex-col gap-2" aria-labelledby="file-matches">
      <h2 id="file-matches" className="flex items-center gap-2 text-sm font-medium text-base-content/70">
        <span className="icon-[tabler--files] size-4" />
        <Trans>In documents</Trans>
      </h2>
      <ul className="flex flex-col gap-2">
        {files.map((f) => (
          <li key={f.id} className="card">
            <div className="card-body flex-row items-center gap-3 p-3">
              {f.hasThumbnail ? (
                <img src={api.thumbnailUrl(f.id)} alt="" loading="lazy" className="h-12 w-10 shrink-0 rounded-field border border-base-content/10 bg-white object-cover object-top" />
              ) : (
                <FileIcon contentType={f.contentType} />
              )}
              <div className="min-w-0 flex-1">
                <a href={api.attachmentUrl(f.id)} target="_blank" rel="noreferrer" data-result className="link link-hover block truncate text-sm font-medium text-base-content/80">
                  {f.filename}
                </a>
                <a href={where(f)} className="link link-primary tap text-xs">
                  {f.of.name}
                </a>
                {f.snippet && <p className="line-clamp-2 text-xs text-base-content/70">{f.snippet}</p>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FileIcon({ contentType }: { contentType: string }) {
  const icon = contentType === "application/pdf" ? "icon-[tabler--file-type-pdf]" : "icon-[tabler--photo]";
  return (
    <span className="rounded-box border-base-content/20 text-base-content/80 flex size-9 shrink-0 items-center justify-center border">
      <span className={`${icon} size-5`} />
    </span>
  );
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
