/**
 * Item detail: details, photos and documents, plus the uploader.
 * Uploader styling is adapted from FlyonUI Pro "Dashboard Modal 8" and the
 * photo grid from "Gallery 1"; behaviour is plain React (no FlyonUI JS plugins).
 */
import { UsageCard } from "./Usage";
import { BarSearch } from "./Nav";
import { NotFound } from "./NotFound";
import { PhotoViewer } from "./PhotoViewer";
import type {
  Attachment,
  AttachmentKind,
  CategoryField,
  ItemListing,
  ItemPatch,
  MaintenanceInput,
  Warranty,
  WarrantyClaim,
  WarrantyInput,
} from "@ferret/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { ItemEditor } from "./ItemEditor";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { categoryHref, itemHref, placeHref, tagHref, addedHref, roomScanHref } from "./lib/route";
import { ORIGIN_HOW } from "./lib/origin";
import { BoxContents, LabelBadge } from "./Boxes";
import { flattenCategories, useCategories } from "./Catalog";
import { mergeFields, useTemplates } from "./Templates";
import { money } from "./Overview";
import { CollectionBanner } from "./Collections";
import { ItemMaintenance, maintenanceKey } from "./Maintenance";
import { ClaimDialog } from "./Claims";
import { ProductSuggestions } from "./Product";
import { Suggestions } from "./Suggestions";
import { Warranties } from "./Warranties";
import { ItemLinks } from "./Links";
import { FromWeb } from "./FromWeb";
import { useFeatures } from "./lib/features";
import { StockCard } from "./Stock";
import { PairingCard } from "./Pairing";
import { ItemHistory } from "./History";
import { LoanCard } from "./Loans";
import { RecallCard } from "./PayOff";
import { GoneBanner } from "./Gone";
import { PhotoCrop } from "./PhotoCrop";

/**
 * Types offered by the pickers. HEIC is left out on purpose: iPhone Safari then
 * converts camera-roll photos to JPEG, which every browser can display.
 */
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
const ANY_ACCEPT = `${PHOTO_ACCEPT},application/pdf`;

interface Upload {
  key: string;
  file: File;
  kind: AttachmentKind;
  progress: number;
  error?: string;
  /** Only network and server errors are worth retrying; a rejected file won't change. */
  retryable?: boolean;
}

export function ItemPage({ itemId, householdId }: { itemId: string; householdId: string }) {
  const qc = useQueryClient();
  const item = useQuery({ queryKey: ["item", householdId, itemId], queryFn: () => api.getItem(itemId) });
  const attachmentsKey = ["attachments", householdId, itemId];
  const attachments = useQuery({
    queryKey: attachmentsKey,
    queryFn: () => api.listAttachments(itemId),
    // Photo analysis finishes in the background; check back until it's done.
    refetchInterval: (q) => (q.state.data?.data.some((a) => a.analysisStatus === "pending") ? 4000 : false),
  });
  const refreshAttachments = () => qc.invalidateQueries({ queryKey: attachmentsKey });
  const remove = useMutation({ mutationFn: api.deleteAttachment, onSuccess: refreshAttachments });
  const reanalyze = useMutation({ mutationFn: api.analyzeAttachment, onSuccess: refreshAttachments });
  const applySuggestion = useMutation({
    mutationFn: (patch: ItemPatch) => api.updateItem(itemId, patch),
    onSuccess: (updated) => {
      qc.setQueryData(["item", householdId, itemId], updated);
      void qc.invalidateQueries({ queryKey: ["items", householdId] });
      void qc.invalidateQueries({ queryKey: ["attention", householdId] }); // e.g. a "New item" got its name
    },
  });
  const warrantiesKey = ["warranties", householdId, itemId];
  const warranties = useQuery({ queryKey: warrantiesKey, queryFn: () => api.listWarranties(itemId) });
  const refreshWarranties = () => qc.invalidateQueries({ queryKey: warrantiesKey });
  const addWarranty = useMutation({
    mutationFn: (input: WarrantyInput) => api.addWarranty(itemId, input),
    onSuccess: refreshWarranties,
  });
  const removeWarranty = useMutation({ mutationFn: api.deleteWarranty, onSuccess: refreshWarranties });
  const dismiss = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map(api.dismissSuggestions)),
    onSuccess: refreshAttachments,
  });
  const tasks = useQuery({
    queryKey: [...maintenanceKey(householdId), "item", itemId],
    queryFn: () => api.listMaintenance({ itemId, status: "all" }),
  });
  const addTask = useMutation({
    mutationFn: (input: MaintenanceInput) => api.createMaintenance(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: maintenanceKey(householdId) }),
  });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [editing, setEditing] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const canEdit = useCanEdit(householdId);
  const features = useFeatures();
  const claims = useQuery({ queryKey: ["claims", householdId, itemId], queryFn: () => api.listClaims({ itemId }) });
  const [claimDialog, setClaimDialog] = useState<{ warranty?: Warranty; claim?: WarrantyClaim } | null>(null);
  const categories = useCategories(householdId);
  const templates = useTemplates(householdId);

  const patch = (key: string, changes: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...changes } : u)));

  function start(upload: Upload) {
    api
      .uploadAttachment(itemId, upload.file, upload.kind, (progress) => patch(upload.key, { progress }))
      .then(async () => {
        await qc.invalidateQueries({ queryKey: attachmentsKey });
        setUploads((list) => list.filter((u) => u.key !== upload.key));
      })
      .catch((err: Error & { status?: number }) =>
        patch(upload.key, { error: err.message, retryable: !err.status || err.status >= 500 }),
      );
  }

  function addFiles(files: Iterable<File>, kind?: AttachmentKind) {
    const added = [...files].map((file) => ({
      key: crypto.randomUUID(),
      file,
      // Dropped/picked files: PDFs are documents, images are photos unless the caller says otherwise.
      kind: kind ?? (file.type === "application/pdf" ? "document" : "photo"),
      progress: 0,
    }));
    setUploads((list) => [...list, ...added]);
    added.forEach(start);
  }

  function retry(upload: Upload) {
    const fresh = { ...upload, progress: 0, error: undefined, retryable: undefined };
    patch(upload.key, fresh);
    start(fresh);
  }

  function confirmRemove(a: Attachment) {
    if (window.confirm(`Remove ${a.filename}?`)) remove.mutate(a.id);
  }

  const [viewing, setViewing] = useState<number | null>(null); // the photo shown full screen
  const [cropping, setCropping] = useState<Attachment | null>(null); // the photo being cropped (PhotoCrop.tsx)

  if (item.isError && (item.error as Error & { status?: number }).status === 404) {
    return (
      <Shell title="">
        <NotFound what="item" wrap={false} />
      </Shell>
    );
  }
  if (item.isError) {
    return (
      <Shell title="Item">
        <div className="alert alert-soft alert-error">{item.error.message}</div>
      </Shell>
    );
  }
  if (!item.data) {
    return (
      <Shell title="">
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner loading-lg text-primary" />
        </div>
      </Shell>
    );
  }

  const photos = attachments.data?.data.filter((a) => a.kind === "photo") ?? [];
  const documents = attachments.data?.data.filter((a) => a.kind === "document") ?? [];
  const details = [
    item.data.brand,
    item.data.model,
    item.data.valueCents != null ? money(item.data.valueCents, true) : null,
    item.data.quantity !== 1 ? `${item.data.quantity} of them` : null,
    item.data.condition && `${item.data.condition[0]!.toUpperCase()}${item.data.condition.slice(1)} condition`,
  ].filter(Boolean);
  const purchase = [
    item.data.purchaseDate &&
      `Bought ${new Date(`${item.data.purchaseDate}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`,
    item.data.purchasePriceCents != null && `for ${money(item.data.purchasePriceCents, true)}`,
  ]
    .filter(Boolean)
    .join(" ");

  // The uploader is open while there's nothing yet, something's uploading, or someone asked for it.
  const showUploader = addingFiles || uploads.length > 0 || (attachments.data?.data.length ?? 1) === 0;

  return (
    <Shell
      title={item.data.name}
      wide
      action={
        canEdit && (
          <button type="button" className="btn btn-soft btn-primary btn-sm shrink-0" aria-label="Edit" onClick={() => setEditing(true)}>
            <span className="icon-[tabler--pencil] size-4" />
            {/* A narrow bar (a small phone, or big text): the pencil alone. */}
            <span className="@max-[20rem]:hidden">Edit</span>
          </button>
        )
      }
    >
      {editing && <ItemEditor item={item.data} householdId={householdId} onClose={() => setEditing(false)} />}
      {/* ① Details */}
      {/* Sold, given away, lost…: what happened, and "Bring it back". */}
      <GoneBanner item={item.data} householdId={householdId} />
      {/* On a wide screen: the photos beside the details, as a product page shows them. */}
      <div className={`grid gap-6 ${photos.length ? "lg:grid-cols-2" : ""}`}>
      {photos.length > 0 && (
        <PhotoHero photos={photos} name={item.data.name} onOpen={setViewing} />
      )}
      <section className="card self-start">
        <div className="card-body gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-base-content flex items-center gap-2 text-xl font-semibold lg:text-2xl">
              {item.data.name}
              {item.data.favorite && <span className="icon-[tabler--star-filled] text-warning size-5" aria-label="Favourite" />}
            </h1>
            {/* Its QR label (and any labels people brought), beside its name — like a room's. */}
            <LabelBadge target={{ itemId }} code={item.data.labelCode} ownLabels={item.data.ownLabels} name={item.data.name} householdId={householdId} />
          </div>
          {item.data.container && (
            <a href={itemHref(item.data.container.id)} className="tap link link-hover text-primary flex items-center gap-1 text-sm">
              <span className="icon-[tabler--package] size-4 shrink-0" />
              In {item.data.container.name}
            </a>
          )}
          {item.data.locationId && item.data.place ? (
            <a href={placeHref(item.data.locationId)} className="tap link link-hover text-primary flex items-center gap-1 text-sm">
              <span className="icon-[tabler--map-pin] size-4 shrink-0" />
              {item.data.place}
            </a>
          ) : canEdit ? (
            <button type="button" className="tap link link-hover text-base-content/70 flex items-center gap-1 text-sm" onClick={() => setEditing(true)}>
              <span className="icon-[tabler--map-pin-question] size-4 shrink-0" />
              Where is it kept? Add a place
            </button>
          ) : null}
          <p className="text-base-content/70 text-sm">{details.join(" · ") || "No details yet"}</p>
          {item.data.description && <p className="text-base-content/80 mt-1">{item.data.description}</p>}
          {item.data.serialNumber && (
            <p className="text-base-content/80 text-sm">Serial: {item.data.serialNumber}</p>
          )}
          {purchase && <p className="text-base-content/80 text-sm">{purchase}</p>}
          {item.data.heir && <p className="text-base-content/80 text-sm">Goes to {item.data.heir}</p>}
          <Classification
            item={item.data}
            fields={mergeFields(
              flattenCategories(categories.data ?? []).find((c) => c.id === item.data.categoryId)?.allFields ?? [],
              templates.data?.find((t) => t.id === item.data.templateId),
            )}
          />
          {item.data.notes && <p className="text-base-content/80 mt-2 whitespace-pre-line">{item.data.notes}</p>}
          {item.data.links && item.data.links.length > 0 && <ItemLinks links={item.data.links} />}
          <AddedLine item={item.data} />
          <div className="mt-2 flex flex-col gap-2">
            <CollectionBanner householdId={householdId} item={item.data} />
          </div>
        </div>
      </section>
      </div>

      {/* A recall that matches it: before anything else. */}
      <RecallCard itemId={itemId} householdId={householdId} />
      <JumpLinks
        sections={[
          ["item-photos", "Photos", photos.length],
          ["item-warranties", "Warranties", warranties.data?.data.length ?? 0],
          ["item-maintenance", "Maintenance", tasks.data?.data.length ?? 0],
          ["item-documents", "Documents", documents.length],
          ["item-history", "History", 0],
        ]}
      />

      {canEdit && <ProductSuggestions item={item.data} householdId={householdId} />}
      {canEdit && attachments.data && (
        <Suggestions
          item={item.data}
          attachments={attachments.data.data}
          warranties={warranties.data?.data ?? []}
          tasks={tasks.data?.data ?? []}
          onApply={(p) => applySuggestion.mutate(p)}
          onAddTask={(t) => addTask.mutate(t)}
          onAddWarranty={(w) => addWarranty.mutate(w)}
          onDismiss={(ids) => dismiss.mutate(ids)}
          busy={applySuggestion.isPending || dismiss.isPending || addWarranty.isPending || addTask.isPending}
        />
      )}
      {applySuggestion.isError && <div className="alert alert-soft alert-error">{applySuggestion.error.message}</div>}

      {/* A box: what's in it comes first. */}
      {item.data.isContainer && <BoxContents box={item.data} householdId={householdId} />}




      {attachments.isError && <div className="alert alert-soft alert-error">{attachments.error.message}</div>}

      {/* ③ Photos */}
      <section id="item-photos" className="flex scroll-mt-20 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <SectionTitle icon="icon-[tabler--photo]" title="Photos" count={photos.length} />
          {canEdit && !showUploader && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => setAddingFiles(true)}>
              <span className="icon-[tabler--plus] size-4" />
              Add photos or documents
            </button>
          )}
        </div>
        {/* ② The uploader: open when there's nothing yet, or when asked. */}
        {canEdit && showUploader && (
          <section className="flex flex-col gap-3" aria-label="Add photos and documents">
            <div className="grid grid-cols-2 gap-2">
              <PickerButton icon="icon-[tabler--camera]" label="Take photo" accept="image/*" capture onFiles={(f) => addFiles(f, "photo")} />
              <PickerButton
                icon="icon-[tabler--receipt]"
                label="Scan document"
                accept="image/*"
                capture
                onFiles={(f) => addFiles(f, "document")}
              />
            </div>
            <DropZone onFiles={(f) => addFiles(f)} />
            {features?.fromWeb && <FromWeb itemId={itemId} householdId={householdId} onArrived={refreshAttachments} />}
            {uploads.length > 0 && (
              <ul className="flex flex-col gap-2">
                {uploads.map((u) => (
                  <UploadRow
                    key={u.key}
                    upload={u}
                    onRetry={() => retry(u)}
                    onDismiss={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {photos.length === 0 ? (
          <p className="text-base-content/70 text-sm">No photos yet. A photo makes it easy to recognise later.</p>
        ) : (
          // On a wide screen the big photo is up top, so these are a row of small tiles to manage them.
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
            {photos.map((p, i) => (
              <figure key={p.id} className={`relative ${i === 0 ? "col-span-2 row-span-2 lg:col-span-1 lg:row-span-1" : ""}`}>
                <button type="button" className="block size-full rounded-box focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Show ${p.filename} full screen`} onClick={() => setViewing(i)}>
                  <img
                    src={api.thumbnailUrl(p.id)}
                    alt={p.analysis?.description || `${item.data.name} — ${p.filename}`}
                    loading="lazy"
                    className="rounded-box bg-base-300 aspect-square h-full w-full object-cover"
                  />
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-circle btn-sm absolute end-1.5 top-1.5 border-0 bg-base-100/85"
                    aria-label={`Remove ${p.filename}`}
                    onClick={() => confirmRemove(p)}
                  >
                    <span className="icon-[tabler--trash] size-4" />
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-circle btn-sm absolute start-1.5 top-1.5 border-0 bg-base-100/85"
                    aria-label={`Crop ${p.filename}${i === 0 ? "" : ", or make it the main photo"}`}
                    title="Crop, or make it the main photo"
                    onClick={() => setCropping(p)}
                  >
                    <span className="icon-[tabler--crop] size-4" />
                  </button>
                )}
                {i === 0 && photos.length > 1 && (
                  <span className="badge badge-sm pointer-events-none absolute end-1.5 bottom-1.5 border-0 bg-base-100/90 text-base-content">Main</span>
                )}
                <AnalysisBadge attachment={p} onRetry={canEdit ? () => reanalyze.mutate(p.id) : undefined} />
              </figure>
            ))}
          </div>
        )}
        {cropping && (
          <PhotoCrop
            photo={cropping}
            itemId={itemId}
            isMain={photos[0]?.id === cropping.id}
            onSaved={() => {
              void refreshAttachments();
              void qc.invalidateQueries({ queryKey: ["item", householdId, itemId] });
              void qc.invalidateQueries({ queryKey: ["items", householdId] });
            }}
            onClose={() => setCropping(null)}
          />
        )}
        {viewing !== null && (
          <PhotoViewer
            title={item.data.name}
            photos={photos.map((p) => ({ id: p.id, filename: p.filename, caption: p.analysis?.description, smallCopy: p.originalRemoved }))}
            start={viewing}
            onClose={() => setViewing(null)}
          />
        )}
      </section>
      {/* Small "Track stock / Add code / Lend…" buttons share a row (scrolling sideways if they must); any of them
          that's in use is a full-width card. */}
      <div className="flex flex-wrap gap-2 [&>section]:w-full">
      <StockCard item={item.data} householdId={householdId} canEdit={canEdit && !item.data.disposition} />
      <UsageCard item={item.data} householdId={householdId} canEdit={canEdit && !item.data.disposition} />
      {/* HomeKit / Matter setup codes: shown on request, with their QR for the Home app. */}
      <PairingCard itemId={itemId} householdId={householdId} canEdit={canEdit} />
      {!item.data.disposition && <LoanCard itemId={itemId} itemName={item.data.name} householdId={householdId} canEdit={canEdit} />}
      </div>

      {claimDialog && (
        <ClaimDialog householdId={householdId} itemId={itemId} {...claimDialog} canEdit={canEdit} onClose={() => setClaimDialog(null)} />
      )}
      <div id="item-warranties" className="scroll-mt-20">
      <Warranties
        warranties={warranties.data?.data ?? []}
        claims={claims.data?.data ?? []}
        onFileClaim={canEdit ? (warranty) => setClaimDialog({ warranty }) : undefined}
        onOpenClaim={(claim) => setClaimDialog({ claim })}
        purchaseDate={item.data.purchaseDate}
        onAdd={canEdit ? (w) => addWarranty.mutate(w) : undefined}
        onRemove={canEdit ? (w) => window.confirm("Remove this warranty?") && removeWarranty.mutate(w.id) : undefined}
        busy={addWarranty.isPending || removeWarranty.isPending}
        error={addWarranty.error?.message ?? removeWarranty.error?.message}
      />
      </div>

      <div id="item-maintenance" className="scroll-mt-20">
        <ItemMaintenance itemId={itemId} householdId={householdId} />
      </div>

      {/* ④ Documents */}
      <section id="item-documents" className="flex scroll-mt-20 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <SectionTitle icon="icon-[tabler--files]" title="Documents" count={documents.length} />
          {canEdit && (
            <button
              type="button"
              className="btn btn-text btn-sm"
              onClick={() => {
                setAddingFiles(true);
                document.getElementById("item-photos")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <span className="icon-[tabler--plus] size-4" />
              Add
            </button>
          )}
        </div>
        {documents.length === 0 ? (
          <p className="text-base-content/70 text-sm">Receipts, manuals and warranties go here.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {documents.map((d) => (
              <li key={d.id} className="card">
                <div className="card-body flex-row items-center gap-3 p-3">
                  {/* A PDF's first page, once it's been drawn; else its icon. */}
                  {d.hasThumbnail ? (
                    <a href={api.attachmentUrl(d.id)} target="_blank" rel="noreferrer" className="shrink-0" aria-hidden tabIndex={-1}>
                      <img src={api.thumbnailUrl(d.id)} alt="" loading="lazy" className="h-14 w-11 rounded-field border border-base-content/10 bg-white object-cover object-top" />
                    </a>
                  ) : (
                    <FileIcon contentType={d.contentType} />
                  )}
                  <a
                    href={api.attachmentUrl(d.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="link link-hover min-w-0 flex-1"
                  >
                    <span className="text-base-content/80 block truncate text-sm font-medium">{d.filename}</span>
                    <span className="text-base-content/70 text-xs">
                      {d.originalRemoved ? "Small copy only" : formatSize(d.size)}
                      {d.analysisStatus === "pending" && " · Reading…"}
                      {d.analysisStatus === "failed" && " · Couldn't read it"}
                    </span>
                  </a>
                  {canEdit && d.analysisStatus === "failed" && (
                    <button
                      type="button"
                      className="btn btn-circle btn-text btn-sm"
                      aria-label={`Try reading ${d.filename} again`}
                      onClick={() => reanalyze.mutate(d.id)}
                    >
                      <span className="icon-[tabler--refresh] size-4" />
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-circle btn-text btn-sm"
                      aria-label={`Remove ${d.filename}`}
                      onClick={() => confirmRemove(d)}
                    >
                      <span className="icon-[tabler--trash] size-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div id="item-history" className="scroll-mt-20">
        <ItemHistory itemId={itemId} householdId={householdId} />
      </div>
    </Shell>
  );
}

/** "Added Oct 19, 2026 by Ann, from a spreadsheet (orders.csv)" — the "how" links to everything else added that way. */
function AddedLine({ item: it }: { item: Pick<ItemListing, "createdAt" | "origin" | "originDetail" | "addedBy" | "roomScanId"> }) {
  const when = new Date(it.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const detail = it.originDetail && it.originDetail !== "Home Assistant" ? ` (${it.originDetail})` : "";
  return (
    <p className="mt-2 text-xs text-base-content/70">
      Added {when}
      {it.addedBy ? ` by ${it.addedBy}` : ""}
      {it.origin && (
        <>
          {", "}
          <a href={addedHref(it.origin)} className="link link-hover tap" title="Everything added this way">
            {ORIGIN_HOW[it.origin]}
          </a>
          {detail}
        </>
      )}
      {it.roomScanId && (
        <>
          {" · "}
          <a href={roomScanHref(it.roomScanId)} className="link link-hover tap">
            see the room photo
          </a>
        </>
      )}
    </p>
  );
}

/** A row of links down a long item page: Photos 3 · Warranties · Maintenance 1 · Documents 2 · History. */
function JumpLinks({ sections }: { sections: [id: string, label: string, count: number][] }) {
  return (
    <nav aria-label="On this page" className="-mx-1 flex gap-1 overflow-x-auto px-1">
      {sections.map(([id, label, count]) => (
        <button
          key={id}
          type="button"
          className="btn btn-soft btn-sm shrink-0 gap-1"
          onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          {label}
          {count > 0 && <span className="badge badge-sm badge-primary badge-soft">{count}</span>}
        </button>
      ))}
    </nav>
  );
}

/** Category (a link to everything like it), the category's extra fields, and tags (links to their collections). */
function Classification({ item, fields }: { item: ItemListing; fields: CategoryField[] }) {
  const values = fields.filter((f) => item.customFields?.[f.key] !== undefined && item.customFields?.[f.key] !== "");
  if (!item.categoryId && !item.tags.length && !values.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {values.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          {values.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-base-content/70">{f.label}</dt>
              <dd className="text-base-content/80">
                {String(item.customFields![f.key])}
                {f.unit ? ` ${f.unit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap gap-1.5">
        {item.categoryId && item.category && (
          <a href={categoryHref(item.categoryId)} className="tap badge badge-soft badge-secondary gap-1">
            <span className="icon-[tabler--category] size-3.5" />
            {item.category}
          </a>
        )}
        {item.tags.map((t) => (
          <a key={t} href={tagHref(t)} className="tap badge badge-soft badge-primary gap-1">
            <span className="icon-[tabler--tag] size-3.5" />
            {t}
          </a>
        ))}
      </div>
    </div>
  );
}

function Shell({ title, action, wide, children }: { title: string; action?: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar @container sticky top-0 z-10 gap-2 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-2">
        <a
          href="#/"
          className="btn btn-text btn-circle"
          aria-label="Back"
          // Back to wherever it was opened from (a room, a search…), or home on a fresh visit.
          onClick={(e) => {
            if (window.history.length > 1) {
              e.preventDefault();
              window.history.back();
            }
          }}
        >
          <span className="icon-[tabler--arrow-left] size-5" />
        </a>
        <span className="text-base-content min-w-0 flex-1 truncate font-semibold">{title}</span>
        <BarSearch />
        {action}
      </nav>
      {/* An item's own page uses a wide screen (photos beside the details); the not-found and loading states don't. */}
      <main className={`mx-auto flex max-w-3xl flex-col gap-6 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] ${wide ? "lg:max-w-6xl" : ""}`}>
        {children}
      </main>
    </div>
  );
}

/** Wide screens: the photos big beside the details — one large, the others as thumbnails to switch to; a click shows it full screen. */
function PhotoHero({ photos, name, onOpen }: { photos: Attachment[]; name: string; onOpen: (index: number) => void }) {
  const [shown, setShown] = useState(0);
  const photo = photos[Math.min(shown, photos.length - 1)]!;
  return (
    <section className="flex flex-col gap-3 max-lg:hidden" aria-label="Photos">
      <button
        type="button"
        className="group relative overflow-hidden rounded-box bg-base-300 focus-visible:outline-2 focus-visible:outline-primary"
        aria-label={`Show ${photo.filename} full screen`}
        onClick={() => onOpen(photos.indexOf(photo))}
      >
        <img src={api.attachmentUrl(photo.id)} alt={photo.analysis?.description || name} className="aspect-4/3 w-full object-contain" />
        <span className="badge absolute end-3 bottom-3 gap-1 border-0 bg-base-100/85 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="icon-[tabler--zoom-in] size-4" />
          Full screen
        </span>
      </button>
      {photos.length > 1 && (
        <div className="grid grid-cols-5 gap-2">
          {photos.slice(0, 10).map((p, i) => (
            <button
              key={p.id}
              type="button"
              aria-label={`Show photo ${i + 1}`}
              aria-pressed={p.id === photo.id}
              onClick={() => setShown(i)}
              className={`overflow-hidden rounded-field border-2 ${p.id === photo.id ? "border-primary" : "border-transparent opacity-80 hover:opacity-100"}`}
            >
              <img src={api.thumbnailUrl(p.id)} alt="" loading="lazy" className="aspect-square w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Overlay on a photo tile while the vision model works on it, or if it couldn't. */
function AnalysisBadge({ attachment, onRetry }: { attachment: Attachment; onRetry?: () => void }) {
  if (attachment.analysisStatus === "pending") {
    return (
      <span className="badge badge-soft badge-primary pointer-events-none absolute start-1.5 bottom-1.5 gap-1 bg-base-100/90">
        <span className="icon-[tabler--sparkles] size-3.5 animate-pulse" />
        Analyzing
      </span>
    );
  }
  if (attachment.analysisStatus === "failed" && onRetry) {
    return (
      <button
        type="button"
        className="badge badge-soft badge-error absolute start-1.5 bottom-1.5 gap-1 bg-base-100/90"
        onClick={onRetry}
        aria-label={`Analysis failed for ${attachment.filename}. Try again`}
      >
        <span className="icon-[tabler--refresh] size-3.5" />
        Retry
      </button>
    );
  }
  return null;
}

function SectionTitle({ icon, title, count }: { icon: string; title: string; count: number }) {
  return (
    <h2 className="text-base-content flex items-center gap-2 font-semibold">
      <span className={`${icon} text-primary size-5`} />
      {title}
      {count > 0 && <span className="badge badge-soft badge-primary badge-sm">{count}</span>}
    </h2>
  );
}

/** A button that opens the file picker (or, with `capture`, the camera on phones). */
function PickerButton(props: {
  icon: string;
  label: string;
  accept: string;
  capture?: boolean;
  onFiles: (files: FileList) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn btn-soft btn-primary max-sm:h-auto max-sm:flex-col max-sm:gap-1 max-sm:py-3" onClick={() => input.current?.click()}>
        <span className={`${props.icon} size-5`} />
        {props.label}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={props.accept}
        capture={props.capture ? "environment" : undefined}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          if (e.target.files?.length) props.onFiles(e.target.files);
          e.target.value = ""; // allow picking the same file again
        }}
      />
    </>
  );
}

/** Dashed drop area from Dashboard Modal 8: drag & drop on desktop, tap to choose on phones. */
function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  };
  return (
    <>
      <button
        type="button"
        className={`rounded-box flex w-full cursor-pointer flex-col items-center gap-2 border-2 border-dashed p-6 text-center transition-colors ${
          over ? "border-primary bg-primary/5" : "border-base-content/20 hover:border-primary/60"
        }`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="icon-[tabler--upload] text-base-content size-8" />
        <span className="text-base-content font-semibold">
          <span className="hidden sm:inline">Drag & drop or </span>choose files
        </span>
        <span className="text-base-content/70 text-sm">Photos (JPEG, PNG, WebP) or PDF documents</span>
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={ANY_ACCEPT}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Upload preview card from Dashboard Modal 8: icon, name, size, progress, retry/dismiss on error. */
function UploadRow({ upload, onRetry, onDismiss }: { upload: Upload; onRetry: () => void; onDismiss: () => void }) {
  const percent = Math.round(upload.progress * 100);
  return (
    <li className="rounded-box bg-base-100 p-3" aria-live="polite">
      <div className={`flex items-center gap-3 ${upload.error ? "" : "mb-2"}`}>
        {upload.error ? (
          <span className="rounded-box border-error/30 text-error flex size-9 shrink-0 items-center justify-center border">
            <span className="icon-[tabler--alert-circle] size-5" />
          </span>
        ) : (
          <FileIcon contentType={upload.file.type} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-base-content/80 truncate text-sm font-medium">{upload.file.name}</p>
          {upload.error ? (
            <p className="text-error text-xs">{upload.error}</p>
          ) : (
            <p className="text-base-content/70 text-xs">
              {formatSize(upload.file.size)} · {upload.kind}
            </p>
          )}
        </div>
        {upload.error && (
          <>
            {upload.retryable && (
              <button type="button" className="btn btn-circle btn-text btn-sm" aria-label="Retry upload" onClick={onRetry}>
                <span className="icon-[tabler--refresh] size-4" />
              </button>
            )}
            <button type="button" className="btn btn-circle btn-text btn-sm" aria-label="Dismiss" onClick={onDismiss}>
              <span className="icon-[tabler--x] size-4" />
            </button>
          </>
        )}
      </div>
      {!upload.error && (
        <div className="flex items-center gap-3">
          <div
            className="progress h-2"
            role="progressbar"
            aria-label={`Uploading ${upload.file.name}`}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="progress-bar progress-primary transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-base-content w-10 text-end text-sm">{percent}%</span>
        </div>
      )}
    </li>
  );
}

function FileIcon({ contentType }: { contentType: string }) {
  const icon = contentType === "application/pdf" ? "icon-[tabler--file-type-pdf]" : "icon-[tabler--photo]";
  return (
    <span className="rounded-box border-base-content/20 text-base-content/80 flex size-9 shrink-0 items-center justify-center border">
      <span className={`${icon} size-5`} />
    </span>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
