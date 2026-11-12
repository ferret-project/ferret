/**
 * Item detail: details, photos and documents, plus the uploader.
 * Uploader styling is adapted from FlyonUI Pro "Dashboard Modal 8" and the
 * photo grid from "Gallery 1"; behaviour is plain React (no FlyonUI JS plugins).
 */
import { ListingButton } from "./Listing";
import { amazonSearchUrl, today } from "@ferret/shared/utils";
import { lastScannedText } from "./lib/last-scanned";
import { UsageCard } from "./Usage";
import { BarSearch } from "./Nav";
import { ItemSearch } from "./ItemSearch";
import { ITEM_SEARCH_EVENT } from "./Search";
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
import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { ItemEditor } from "./ItemEditor";
import { api } from "./lib/api";
import { useCanEdit } from "./lib/auth";
import { categoryHref, itemHref, placeHref, tagHref, addedHref, roomScanHref } from "./lib/route";
import { ORIGIN_HOW } from "./lib/origin";
import { BoxContents, LabelBadge } from "./Boxes";
import { flattenCategories, useCategories } from "./Catalog";
import { mergeFields, useTemplates } from "./Templates";
import { currentCurrency, money } from "./lib/money";
import { CollectionBanner } from "./Collections";
import { ItemMaintenance, maintenanceKey } from "./Maintenance";
import { AiFilledCard } from "./AiFill";
import { ReplacementCard } from "./Replacement";
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
import { t, ph, plural } from "@lingui/core/macro";
import { conditionPhrase } from "./lib/words";
import { Trans } from "@lingui/react/macro";
import { randomId } from "./lib/secure-context";

/**
 * Types offered by the pickers. HEIC is left out on purpose: iPhone Safari then
 * converts camera-roll photos to JPEG, which every browser can display.
 */
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,image/avif,image/gif";
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
  // Search inside this item (ItemSearch.tsx): from the top bar's search, `/` or ⌘K; closed when another item opens.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    setSearching(false);
    const open = () => {
      setSearching(true);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener(ITEM_SEARCH_EVENT, open);
    return () => window.removeEventListener(ITEM_SEARCH_EVENT, open);
  }, [itemId]);
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
      key: randomId(),
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
    if (window.confirm(t`Remove ${ph({ filename: a.filename })}?`)) remove.mutate(a.id);
  }

  const [viewing, setViewing] = useState<number | null>(null); // the photo shown full screen
  const [cropping, setCropping] = useState<Attachment | null>(null); // the photo being cropped (PhotoCrop.tsx)

  if (item.isError && (item.error as Error & { status?: number }).status === 404) {
    // Merged into another thing (Possible duplicates): that one is where it lives now.
    const into = ((item.error as Error & { details?: { mergedIntoId?: string } }).details)?.mergedIntoId;
    if (into) {
      return (
        <Shell title="">
          <div className="card">
            <div className="card-body items-center gap-3 text-center">
              <span className="icon-[tabler--arrow-merge] size-10 text-primary" />
              <h2 className="text-lg font-semibold"><Trans>This was merged into another</Trans></h2>
              <Trans><a className="btn btn-primary" href={itemHref(into)}>
                Open it
              </a></Trans>
            </div>
          </div>
        </Shell>
      );
    }
    return (
      <Shell title="">
        <NotFound what="item" wrap={false} />
      </Shell>
    );
  }
  if (item.isError) {
    return (
      <Shell title={t`Item`}>
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
    item.data.quantity !== 1 ? t`${ph({ quantity: item.data.quantity })} of them` : null,
    item.data.condition && conditionPhrase(item.data.condition),
  ].filter(Boolean);
  const purchase = [
    item.data.purchaseDate &&
      t`Bought ${ph({ date: new Date(`${item.data.purchaseDate}T00:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) })}`,
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
      onSearch={() => window.dispatchEvent(new Event(ITEM_SEARCH_EVENT))}
      action={
        canEdit && (
          <button type="button" className="btn btn-soft btn-primary btn-sm shrink-0" aria-label={t`Edit`} onClick={() => setEditing(true)}>
            <span className="icon-[tabler--pencil] size-4" />
            <Trans>{/* A narrow bar (a small phone, or big text): the pencil alone. */}
            <span className="@max-[20rem]:hidden">Edit</span></Trans>
          </button>
        )
      }
    >
      {editing && <ItemEditor item={item.data} householdId={householdId} onClose={() => setEditing(false)} />}
      {/* Search inside this item: its documents, photos' text, warranties, notes — and asking about it. */}
      {searching && <ItemSearch itemId={itemId} itemName={item.data.name} householdId={householdId} onClose={() => setSearching(false)} />}
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
              {item.data.favorite && <span className="icon-[tabler--star-filled] text-warning size-5" aria-label={t`Favourite`} />}
            </h1>
            {/* Its QR label (and any labels people brought), beside its name — like a room's. */}
            <LabelBadge target={{ itemId }} code={item.data.labelCode} ownLabels={item.data.ownLabels} name={item.data.name} householdId={householdId} />
          </div>
          {item.data.container && (
            <a href={itemHref(item.data.container.id)} className="tap link link-hover text-primary flex items-center gap-1 text-sm">
              <span className="icon-[tabler--package] size-4 shrink-0" />
              <Trans>In {ph({ name: item.data.container.name })}</Trans>
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
              <Trans>Where is it kept? Add a place</Trans>
            </button>
          ) : null}
          <p className="text-base-content/70 text-sm">{details.join(" · ") || t`No details yet`}</p>
          {item.data.description && <p className="text-base-content/80 mt-1">{item.data.description}</p>}
          {item.data.serialNumber && (
            <p className="text-base-content/80 text-sm"><Trans>Serial: {ph({ serialNumber: item.data.serialNumber })}</Trans></p>
          )}
          {purchase && <p className="text-base-content/80 text-sm">{purchase}</p>}
          <ReturnLine returnBy={item.data.returnBy} gone={Boolean(item.data.disposition)} />
          {item.data.heir && <p className="text-base-content/80 text-sm"><Trans>Goes to {ph({ heir: item.data.heir })}</Trans></p>}
          <Classification
            item={item.data}
            fields={mergeFields(
              flattenCategories(categories.data ?? []).find((c) => c.id === item.data.categoryId)?.allFields ?? [],
              templates.data?.find((tpl) => tpl.id === item.data.templateId),
            )}
          />
          {item.data.notes && <p className="text-base-content/80 mt-2 whitespace-pre-line">{item.data.notes}</p>}
          {(() => {
            // Something kept stocked ("keep at least") can be looked for on Amazon until it has a product link.
            const search = item.data.minQuantity != null && !item.data.disposition ? amazonSearchUrl(item.data, currentCurrency()) : null;
            return (item.data.links?.length || search) ? <ItemLinks links={item.data.links ?? []} search={search} /> : null;
          })()}
          <AddedLine item={item.data} />
          <div className="mt-2 flex flex-col gap-2">
            <CollectionBanner householdId={householdId} item={item.data} />
          </div>
        </div>
      </section>
      </div>

      {/* What the AI filled in by itself: until someone checks it. */}
      <AiFilledCard item={item.data} householdId={householdId} />
      <ReplacementCard item={item.data} householdId={householdId} />
      {!item.data.disposition && <ListingButton item={item.data} householdId={householdId} className="btn btn-text btn-sm self-start" />}
      {/* A recall that matches it: before anything else. */}
      <RecallCard itemId={itemId} householdId={householdId} />
      <JumpLinks
        sections={[
          ["item-photos", t`Photos`, photos.length],
          ["item-warranties", t`Warranties`, warranties.data?.data.length ?? 0],
          ["item-maintenance", t`Maintenance`, tasks.data?.data.length ?? 0],
          ["item-documents", t`Documents`, documents.length],
          ["item-history", t`History`, 0],
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
          onAddTask={(task) => addTask.mutate(task)}
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
          <SectionTitle icon="icon-[tabler--photo]" title={t`Photos`} count={photos.length} />
          {canEdit && !showUploader && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => setAddingFiles(true)}>
              <span className="icon-[tabler--plus] size-4" />
              <Trans>Add photos or documents</Trans>
            </button>
          )}
        </div>
        {/* ② The uploader: open when there's nothing yet, or when asked. */}
        {canEdit && showUploader && (
          <section className="flex flex-col gap-3" aria-label={t`Add photos and documents`}>
            <div className="grid grid-cols-2 gap-2">
              <PickerButton icon="icon-[tabler--camera]" label={t`Take photo`} accept="image/*" capture onFiles={(f) => addFiles(f, "photo")} />
              <PickerButton
                icon="icon-[tabler--receipt]"
                label={t`Scan document`}
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
          <p className="text-base-content/70 text-sm"><Trans>No photos yet. A photo makes it easy to recognise later.</Trans></p>
        ) : (
          // On a wide screen the big photo is up top, so these are a row of small tiles to manage them.
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
            {photos.map((p, i) => (
              <figure key={p.id} className={`relative ${i === 0 ? "col-span-2 row-span-2 lg:col-span-1 lg:row-span-1" : ""}`}>
                <button type="button" className="block size-full rounded-box focus-visible:outline-2 focus-visible:outline-primary" aria-label={t`Show ${ph({ filename: p.filename })} full screen`} onClick={() => setViewing(i)}>
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
                    aria-label={t`Remove ${ph({ filename: p.filename })}`}
                    onClick={() => confirmRemove(p)}
                  >
                    <span className="icon-[tabler--trash] size-4" />
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="btn btn-circle btn-sm absolute start-1.5 top-1.5 border-0 bg-base-100/85"
                    aria-label={i === 0 ? t`Crop ${ph({ filename: p.filename })}` : t`Crop ${ph({ filename: p.filename })}, or make it the main photo`}
                    title={t`Crop, or make it the main photo`}
                    onClick={() => setCropping(p)}
                  >
                    <span className="icon-[tabler--crop] size-4" />
                  </button>
                )}
                {i === 0 && photos.length > 1 && (
                  <span className="badge badge-sm pointer-events-none absolute end-1.5 bottom-1.5 border-0 bg-base-100/90 text-base-content"><Trans>Main</Trans></span>
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
        onRemove={canEdit ? (w) => window.confirm(t`Remove this warranty?`) && removeWarranty.mutate(w.id) : undefined}
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
          <SectionTitle icon="icon-[tabler--files]" title={t`Documents`} count={documents.length} />
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
              <Trans>Add</Trans>
            </button>
          )}
        </div>
        {documents.length === 0 ? (
          <p className="text-base-content/70 text-sm"><Trans>Receipts, manuals and warranties go here.</Trans></p>
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
                      {d.originalRemoved ? t`Small copy only` : formatSize(d.size)}
                      {d.analysisStatus === "pending" && t` · Reading…`}
                      {d.analysisStatus === "failed" && t` · Couldn't read it`}
                    </span>
                  </a>
                  {canEdit && d.analysisStatus === "failed" && (
                    <button
                      type="button"
                      className="btn btn-circle btn-text btn-sm"
                      aria-label={t`Try reading ${ph({ filename: d.filename })} again`}
                      onClick={() => reanalyze.mutate(d.id)}
                    >
                      <span className="icon-[tabler--refresh] size-4" />
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-circle btn-text btn-sm"
                      aria-label={t`Remove ${ph({ filename: d.filename })}`}
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

/**
 * "Added Oct 19, 2026 by Ann, from a spreadsheet (orders.csv)" — the "how" links to everything else added that way —
 * and when its label or barcode was last scanned.
 */
function AddedLine({ item: it }: { item: Pick<ItemListing, "createdAt" | "origin" | "originDetail" | "addedBy" | "roomScanId" | "lastScanned"> }) {
  const when = new Date(it.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const detail = it.originDetail && it.originDetail !== "Home Assistant" ? ` (${it.originDetail})` : "";
  return (
    <p className="mt-2 text-xs text-base-content/70">
      <Trans>Added {when}</Trans>
      {it.addedBy ? t` by ${ph({ addedBy: it.addedBy })}` : ""}
      {it.origin && (
        <>
          {", "}
          <a href={addedHref(it.origin)} className="link link-hover tap" title={t`Everything added this way`}>
            {t(ORIGIN_HOW[it.origin])}
          </a>
          {detail}
        </>
      )}
      {it.roomScanId && (
        <>
          <Trans>{" · "}
          <a href={roomScanHref(it.roomScanId)} className="link link-hover tap">
            see the room photo
          </a></Trans>
        </>
      )}
      {it.lastScanned && (
        <span className="block" title={new Date(it.lastScanned.at).toLocaleString()}>
          {lastScannedText(it.lastScanned)}
        </span>
      )}
    </p>
  );
}

/** "Return by Nov 30 — 5 days left", while the window is open (and it's still here). */
function ReturnLine({ returnBy, gone }: { returnBy: string | null | undefined; gone: boolean }) {
  if (!returnBy || gone) return null;
  const days = Math.round((Date.parse(`${returnBy}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return null;
  const when = new Date(`${returnBy}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const left = days === 0 ? t`last day` : plural(days, { one: "# day left", other: "# days left" });
  return (
    <p className={`flex items-center gap-1 text-sm ${days <= 2 ? "text-warning" : "text-base-content/80"}`}>
      <span className="icon-[tabler--receipt-refund] size-4" />
      <Trans>Return by {when} — {left}</Trans>
    </p>
  );
}

/** A row of links down a long item page: Photos 3 · Warranties · Maintenance 1 · Documents 2 · History. */
function JumpLinks({ sections }: { sections: [id: string, label: string, count: number][] }) {
  return (
    <nav aria-label={t`On this page`} className="-mx-1 flex gap-1 overflow-x-auto px-1">
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
        {item.tags.map((tag) => (
          <a key={tag} href={tagHref(tag)} className="tap badge badge-soft badge-primary gap-1">
            <span className="icon-[tabler--tag] size-3.5" />
            {tag}
          </a>
        ))}
      </div>
    </div>
  );
}

function Shell({ title, action, wide, onSearch, children }: { title: string; action?: React.ReactNode; wide?: boolean; onSearch?: () => void; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-base-200">
      <nav className="navbar @container sticky top-0 z-10 gap-2 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-2">
        <a
          href="#/"
          className="btn btn-text btn-circle"
          aria-label={t`Back`}
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
        <BarSearch onSearch={onSearch} />
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
  const index = Math.min(shown, photos.length - 1);
  const photo = photos[index]!;
  const strip = useRef<HTMLDivElement>(null);
  const many = photos.length > 1;
  const go = (step: number) => setShown((index + step + photos.length) % photos.length);
  // The thumbnail of the photo shown stays in view as the arrows move through a long strip.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [index]);
  const arrow = "btn btn-circle btn-sm absolute top-1/2 -translate-y-1/2 border-0 bg-base-100/85 text-base-content opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100";
  return (
    <section
      className="flex min-w-0 flex-col gap-3 max-lg:hidden"
      aria-label={t`Photos`}
      // ← / → move through the photos while one of them has the keyboard.
      onKeyDown={(e) => {
        if (!many || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        go(e.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      <div className="group relative">
        <button
          type="button"
          className="relative block w-full overflow-hidden rounded-box bg-base-300 focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={t`Show ${ph({ filename: photo.filename })} full screen`}
          onClick={() => onOpen(index)}
        >
          <img src={api.attachmentUrl(photo.id)} alt={photo.analysis?.description || name} className="aspect-4/3 w-full object-contain" />
          <span className="badge absolute end-3 bottom-3 gap-1 border-0 bg-base-100/85 text-base-content opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <span className="icon-[tabler--zoom-in] size-4" />
            <Trans>Full screen</Trans>
          </span>
          {many && (
            <span className="badge absolute end-3 top-3 border-0 bg-base-100/85 text-base-content tabular-nums">
              {index + 1} / {photos.length}
            </span>
          )}
        </button>
        {many && (
          <>
            <button type="button" className={`${arrow} start-3`} aria-label={t`Previous photo`} onClick={() => go(-1)}>
              <span className="icon-[tabler--chevron-left] size-5 rtl:rotate-180" />
            </button>
            <button type="button" className={`${arrow} end-3`} aria-label={t`Next photo`} onClick={() => go(1)}>
              <span className="icon-[tabler--chevron-right] size-5 rtl:rotate-180" />
            </button>
          </>
        )}
      </div>
      {many && (
        // A strip of every photo, scrolling sideways when there are more than fit.
        <div ref={strip} className="flex snap-x gap-2 overflow-x-auto pb-1">
          {photos.map((p, i) => (
            <button
              key={p.id}
              type="button"
              data-index={i}
              aria-label={t`Show photo ${ph({ number: i + 1 })}`}
              aria-pressed={i === index}
              onClick={() => setShown(i)}
              className={`w-20 shrink-0 snap-start overflow-hidden rounded-field border-2 ${i === index ? "border-primary" : "border-transparent opacity-80 hover:opacity-100"}`}
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
        <Trans>Analyzing</Trans>
      </span>
    );
  }
  if (attachment.analysisStatus === "failed" && onRetry) {
    return (
      <button
        type="button"
        className="badge badge-soft badge-error absolute start-1.5 bottom-1.5 gap-1 bg-base-100/90"
        onClick={onRetry}
        aria-label={t`Analysis failed for ${ph({ filename: attachment.filename })}. Try again`}
      >
        <span className="icon-[tabler--refresh] size-3.5" />
        <Trans>Retry</Trans>
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
          <Trans><span className="hidden sm:inline">Drag & drop or </span>choose files</Trans>
        </span>
        <Trans><span className="text-base-content/70 text-sm">Photos (JPEG, PNG, WebP) or PDF documents</span></Trans>
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
              <button type="button" className="btn btn-circle btn-text btn-sm" aria-label={t`Retry upload`} onClick={onRetry}>
                <span className="icon-[tabler--refresh] size-4" />
              </button>
            )}
            <button type="button" className="btn btn-circle btn-text btn-sm" aria-label={t`Dismiss`} onClick={onDismiss}>
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
            aria-label={t`Uploading ${ph({ name: upload.file.name })}`}
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
