import type {
  AccountDeletionInfo,
  HouseholdDeletionInfo,
  BarcodeLookupStatus,
  ApiError,
  ItemOrigin,
  CoverageCheck,
  CoverageInput,
  ItemRecall,
  RecallStatus,
  ServiceErrorEntry,
  WeeklyDigestInput,
  WeeklyDigestSetting,
  BorrowerView,
  LoanInput,
  LoanPatch,
  LoanSummary,
  SharedView,
  ShareInput,
  ShareLinkSummary,
  HouseholdSettings,
  InvitationEmails,
  PlanReport,
  HouseholdSettingsInput,
  ShareViewEntry,
  ItemHistoryEntry,
  HaRegistryView,
  HomeAssistantApply,
  HomeAssistantConnect,
  ImportBatchSummary,
  ImportInput,
  ImportResult,
  PairingCodeRevealed,
  PairingCodeSummary,
  PairingInput,
  ShoppingList,
  ScanInput,
  ScanResult,
  StockRule,
  StockRuleInput,
  StockSummary,
  BackupSnapshot,
  BackupStatus,
  ApiKeyInput,
  ApiKeySummary,
  AskAnswer,
  AttentionItem,
  BarcodeMatch,
  CategoryInput,
  ClaimInput,
  ClaimPatch,
  CategoryNode,
  CategoryPatch,
  ExportRow,
  Attachment,
  AttachmentKind,
  Item,
  ItemInput,
  ItemListing,
  ItemsBulk,
  ItemsBulkResult,
  ItemSort,
  UsageReading,
  UsageReadingInput,
  UsageSummary,
  ItemProduct,
  Label,
  LabelTarget,
  OwnLabel,
  ItemTemplate,
  CollectionInput,
  CollectionPatch,
  CollectionSummary,
  TemplateInput,
  TemplatePatch,
  RoomScan,
  RoomScanCommit,
  ItemPatch,
  InvitationPreview,
  ItemSearch,
  LocationInput,
  LocationPatch,
  MaintenanceDone,
  MaintenanceInput,
  MaintenanceLogEntry,
  MaintenancePatch,
  MaintenanceTask,
  MissingDetail,
  Overview,
  PlacesTree,
  PropertyInput,
  PropertyPatch,
  Provider,
  ProviderInput,
  ProviderPatch,
  ProviderVisit,
  TagSummary,
  NewApiKey,
  DeletedItem,
  NotificationChannel,
  PendingDownload,
  DownloadInput,
  NotificationChannelInput,
  SessionSummary,
  SignInEntry,
  Warranty,
  WarrantyClaim,
  WarrantyInput,
} from "@ferret/shared";
import { photoCopies } from "./photo-copies";

/** The demo's parts its admin can switch off (server lib/demo-switches.ts). */
export type DemoPart = "everything" | "signups" | "uploads" | "photos" | "meaning" | "chat" | "documents" | "email";

/** What a demo's hosting has used, against its plan (server ports.ts HostingUsageReport). */
export interface HostingUsage {
  title: string;
  note?: string;
  rows: { label: string; used: number; included: number; unit?: "bytes" }[];
  details?: { summary: string; rows: { label: string; value: string }[] };
}

/** The public demo's use (Settings → Server → Demo; server lib/demo.ts demoReport). */
export interface DemoReport {
  days: number;
  visitorAccounts: number;
  visitorHouseholds: number;
  visitorDays: number;
  ai: { today: number; perDay: number };
  paused: boolean;
  /** Counts by day (UTC), event and, for visits, `?ref=`; null when they can't be read from here. */
  counts: { day: string; event: string; ref: string | null; n: number }[] | null;
  countsError: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json()) as T | ApiError;
  // The status rides along, so a screen can tell "not here" (404) from other trouble.
  if (!res.ok) {
    const error = (json as ApiError).error;
    throw Object.assign(new Error(error?.message ?? res.statusText), { status: res.status, details: error?.details });
  }
  return json as T;
}

/**
 * Uploads one file with progress. Uses XHR because fetch can't report upload
 * progress, which matters for big phone photos on a slow connection. A photo goes
 * with its thumbnail and vision copy, made here (lib/photo-copies.ts).
 */
async function upload(itemId: string, file: File, kind: AttachmentKind, onProgress: (fraction: number) => void) {
  const copies = await photoCopies(file);
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/v1/items/${itemId}/attachments`);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 201) return resolve(xhr.response as Attachment);
      const message = (xhr.response as ApiError | null)?.error?.message;
      reject(Object.assign(new Error(message ?? `Upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error("Network error — check your connection and try again"));
    const form = new FormData();
    form.set("file", file);
    form.set("kind", kind);
    if (copies.thumbnail) form.set("thumbnail", copies.thumbnail, "thumbnail");
    if (copies.preview) form.set("preview", copies.preview, "preview");
    xhr.send(form);
  });
}

/** A room scan's photos: the browser's 1600 px copy when it can make one (what the server would keep anyway). */
async function startRoomScan(photos: File[], at: { locationId?: string; containerItemId?: string }) {
  const form = new FormData();
  for (const [i, file] of photos.entries()) {
    const copy = (await photoCopies(file)).preview;
    form.append("photo", copy ?? file, copy ? `room-${i}.jpg` : file.name);
  }
  if (at.locationId) form.set("locationId", at.locationId);
  if (at.containerItemId) form.set("containerItemId", at.containerItemId);
  const res = await fetch("/api/v1/room-scans", { method: "POST", body: form, credentials: "include" });
  const json = (await res.json()) as RoomScan | ApiError;
  if (!res.ok) throw Object.assign(new Error((json as ApiError).error?.message ?? res.statusText), { status: res.status });
  return json as RoomScan;
}

/**
 * A photo cut from another — a room scan's box, or one of the item's own photos cropped (PhotoCrop.tsx): not read again
 * by the model; with `main`, the item's picture from now on (the original is kept).
 */
async function uploadCrop(itemId: string, crop: Blob, opts: { filename?: string; main?: boolean } = {}) {
  const copies = await photoCopies(crop);
  const form = new FormData();
  form.set("file", crop, opts.filename ?? "from-room-scan.jpg");
  form.set("kind", "photo");
  form.set("analyze", "false");
  if (opts.main) form.set("main", "true");
  if (copies.thumbnail) form.set("thumbnail", copies.thumbnail, "thumbnail");
  if (copies.preview) form.set("preview", copies.preview, "preview");
  const res = await fetch(`/api/v1/items/${itemId}/attachments`, { method: "POST", body: form, credentials: "include" });
  if (!res.ok) throw new Error(((await res.json()) as ApiError).error?.message ?? res.statusText);
  return (await res.json()) as Attachment;
}

export const api = {
  roomScans: () => request<{ data: RoomScan[] }>("/room-scans"),
  roomScan: (id: string) => request<RoomScan>(`/room-scans/${encodeURIComponent(id)}`),
  roomScanPhotoUrl: (id: string, n: number) => `/api/v1/room-scans/${encodeURIComponent(id)}/photos/${n}`,
  startRoomScan,
  addFromRoomScan: (id: string, input: RoomScanCommit) =>
    request<{ items: { id: string; name: string }[] }>(`/room-scans/${encodeURIComponent(id)}/add`, { method: "POST", body: JSON.stringify(input) }),
  dismissRoomScan: (id: string) => request<void>(`/room-scans/${encodeURIComponent(id)}`, { method: "DELETE" }),
  uploadCrop,
  /** Makes a photo its item's main photo (its picture in lists). */
  setMainPhoto: (id: string) => request<{ id: string; itemId: string }>(`/attachments/${encodeURIComponent(id)}/main`, { method: "POST" }),
  overview: () => request<Overview>("/overview"),
  attention: () => request<{ data: AttentionItem[] }>("/attention"),
  /** Scan to count: what a scanned code does (open it, change its count, or ask). */
  scan: (input: ScanInput) => request<ScanResult>("/scan", { method: "POST", body: JSON.stringify(input) }),
  stock: (itemId: string) => request<StockSummary>(`/items/${itemId}/stock`),
  /** Maintenance by use: an item's readings (odometer, hour meter). */
  usage: (itemId: string) => request<UsageSummary>(`/items/${itemId}/usage`),
  addReading: (itemId: string, input: UsageReadingInput) =>
    request<UsageReading>(`/items/${itemId}/usage`, { method: "POST", body: JSON.stringify(input) }),
  deleteReading: (id: string) => request<void>(`/usage/${id}`, { method: "DELETE" }),
  shopping: () => request<ShoppingList>("/shopping"),
  /** HomeKit / Matter pairing codes on an item: listed without the code; reveal shows it (and is logged). */
  itemHistory: (itemId: string, offset = 0, limit = 30) =>
    request<{ data: ItemHistoryEntry[]; more: boolean }>(`/items/${itemId}/history?limit=${limit}&offset=${offset}`),
  pairing: (itemId: string) => request<{ data: PairingCodeSummary[] }>(`/items/${itemId}/pairing`),
  addPairing: (itemId: string, input: PairingInput) =>
    request<PairingCodeSummary>(`/items/${itemId}/pairing`, { method: "POST", body: JSON.stringify(input) }),
  revealPairing: (itemId: string, pairingId: string) =>
    request<PairingCodeRevealed>(`/items/${itemId}/pairing/${pairingId}/reveal`, { method: "POST" }),
  deletePairing: (itemId: string, pairingId: string) => request<void>(`/items/${itemId}/pairing/${pairingId}`, { method: "DELETE" }),
  adjustStock: (itemId: string, delta: number) =>
    request<{ quantity: number; applied: number; movementId: string | null }>(`/items/${itemId}/stock`, { method: "POST", body: JSON.stringify({ delta }) }),
  undoStock: (movementId: string) =>
    request<{ itemId: string; quantity: number; applied: number }>(`/stock/movements/${movementId}/undo`, { method: "POST" }),
  setStockRule: (itemId: string, rule: StockRuleInput) =>
    request<StockRule>(`/items/${itemId}/stock-rules`, { method: "PUT", body: JSON.stringify(rule) }),
  deleteStockRule: (itemId: string, ruleId: string) => request<void>(`/items/${itemId}/stock-rules/${ruleId}`, { method: "DELETE" }),
  /** Whether you're the server admin (who sees Settings → Server). */
  me: () => request<{ serverAdmin: boolean; features: { fromWeb: boolean; homeAssistant: boolean; roomScan: boolean } }>("/me"),
  backupStatus: () => request<BackupStatus>("/backup"),
  backupNow: () => request<{ queued: boolean }>("/backup", { method: "POST" }),
  backupSnapshots: () => request<{ data: BackupSnapshot[] }>("/backup/snapshots"),
  checkBackup: (name: string) => request<{ ok: boolean; summary: string }>(`/backup/snapshots/${encodeURIComponent(name)}/check`, { method: "POST" }),
  serverAdmin: () => request<{ id: string; name: string; email: string }>("/server/admin"),
  recallStatus: () => request<RecallStatus>("/server/recalls"),
  barcodeLookupStatus: () => request<BarcodeLookupStatus>("/server/barcode-lookups"),
  /** Deleting for good: the active household (its owner), or your account. */
  householdDeletion: () => request<HouseholdDeletionInfo>("/household/deletion"),
  deleteHousehold: (confirm: string, password?: string) =>
    request<{ accountDeleted: boolean }>("/household", { method: "DELETE", body: JSON.stringify({ confirm, password }) }),
  accountDeletion: () => request<AccountDeletionInfo>("/security/account"),
  deleteAccount: (confirm: string, password?: string) => request<void>("/security/account", { method: "DELETE", body: JSON.stringify({ confirm, password }) }),
  demoReport: (days: number) => request<DemoReport>(`/server/demo?days=${days}`),
  demoSwitches: () => request<{ off: DemoPart[] }>("/server/demo/switches"),
  setDemoSwitches: (off: DemoPart[]) => request<{ off: DemoPart[] }>("/server/demo/switches", { method: "PUT", body: JSON.stringify({ off }) }),
  hostingUsage: () => request<{ usage: HostingUsage | null; error: string | null }>("/server/demo/usage"),
  serviceErrors: () => request<{ data: ServiceErrorEntry[] }>("/server/errors"),
  clearServiceErrors: (id?: string) => request<void>(id ? `/server/errors/${id}` : "/server/errors", { method: "DELETE" }),
  setRecallChecks: (enabled: boolean) => request<RecallStatus>("/server/recalls", { method: "PUT", body: JSON.stringify({ enabled }) }),
  setServerAdmin: (email: string) => request<{ id: string; name: string; email: string }>("/server/admin", { method: "PUT", body: JSON.stringify({ email }) }),
  /** What a scanned barcode is (Ferret's barcode book, then the online database). */
  barcode: (code: string) => request<{ match: BarcodeMatch | null; online: boolean }>(`/barcodes/${encodeURIComponent(code)}`),
  itemProduct: (itemId: string) => request<ItemProduct>(`/items/${itemId}/product`),
  useProductPhoto: (itemId: string, index: number) =>
    request<Attachment>(`/items/${itemId}/product/photo`, { method: "POST", body: JSON.stringify({ index }) }),
  dismissProduct: (itemId: string) => request<void>(`/items/${itemId}/product/dismiss`, { method: "POST" }),
  exportItems: (propertyId?: string) =>
    request<{ data: ExportRow[] }>(`/export/items.json${propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : ""}`),
  /** Same-origin, so the download carries the session cookie. */
  exportCsvUrl: (propertyId?: string) => `/api/v1/export/items.csv${propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : ""}`,
  label: (code: string) => request<Label>(`/labels/${encodeURIComponent(code)}`),
  labels: (blank?: boolean) => request<{ data: Label[] }>(`/labels${blank ? "?blank=true" : ""}`),
  blankLabels: (count: number) => request<{ codes: string[] }>("/labels/blank", { method: "POST", body: JSON.stringify({ count }) }),
  labelFor: (target: LabelTarget) => request<Label>("/labels/for", { method: "POST", body: JSON.stringify(target) }),
  assignLabel: (code: string, target: LabelTarget) =>
    request<Label>(`/labels/${encodeURIComponent(code)}`, { method: "PUT", body: JSON.stringify(target) }),
  clearLabel: (code: string) => request<void>(`/labels/${encodeURIComponent(code)}`, { method: "DELETE" }),
  /** A label you already have: a blank Ferret one, or (items) an asset tag or sticker from elsewhere. */
  attachLabel: (code: string, target: LabelTarget) =>
    request<{ label: Label } | { ownLabel: OwnLabel }>("/labels/attach", { method: "POST", body: JSON.stringify({ code, ...target }) }),
  removeOwnLabel: (id: string) => request<void>(`/labels/own/${encodeURIComponent(id)}`, { method: "DELETE" }),
  authOptions: () =>
    request<{
      signUp: boolean;
      passwordReset: boolean;
      signInLink: boolean;
      /** Single sign-on with an OpenID provider (self-hosted): "Sign in with <name>". */
      sso: { providerId: string; name: string } | null;
      /** Signed in by a forward-auth proxy's headers (self-hosted): the app asks for a session by itself. */
      trustedHeader: boolean;
      /** "Are you a person?" before sign-up (Turnstile): the widget's site key. */
      humanCheck?: { siteKey: string };
      /** The public demo: its shared account (shown on the sign-in screen). */
      demo?: { email: string; password: string; paused: boolean; visitorDays: number; off: DemoPart[] };
    }>("/auth-options"),
  invitation: (id: string) => request<InvitationPreview>(`/invitations/${encodeURIComponent(id)}`),
  ask: (question: string) => request<AskAnswer>("/ask", { method: "POST", body: JSON.stringify({ question }) }),
  listItems: (
    q?: string,
    filter: {
      locationId?: string;
      missing?: MissingDetail;
      categoryId?: string;
      tag?: string;
      containerItemId?: string;
      topLevel?: boolean;
      boxes?: boolean;
      /** Things you no longer have (sold, given away, lost…), instead of what you have. */
      gone?: boolean;
      /** Things added this way (by Claude, from a spreadsheet…). */
      origin?: ItemOrigin;
      /** What's in this collection. */
      collectionId?: string;
      /** The want list (things not owned yet): with what's owned, or only it. */
      wanted?: "include" | "only";
      /** Searches: "later" = the sure matches now (and `checking`); "now" = the maybe-matches checked first. */
      judge?: "later" | "now";
      limit?: number;
      offset?: number;
      /** Lists only: the order (last changed first, unless asked). */
      sort?: ItemSort;
      dir?: "asc" | "desc";
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (filter.gone) params.set("gone", "only");
    if (q && filter.judge) params.set("judge", filter.judge);
    if (filter.containerItemId) params.set("containerItemId", filter.containerItemId);
    if (filter.topLevel) params.set("topLevel", "true");
    if (filter.boxes) params.set("boxes", "true");
    if (q) params.set("q", q);
    if (filter.categoryId) params.set("categoryId", filter.categoryId);
    if (filter.tag) params.set("tag", filter.tag);
    if (filter.limit) params.set("limit", String(filter.limit));
    if (filter.offset) params.set("offset", String(filter.offset));
    if (filter.sort) params.set("sort", filter.sort);
    if (filter.dir) params.set("dir", filter.dir);
    if (filter.locationId) params.set("locationId", filter.locationId);
    if (filter.missing) params.set("missing", filter.missing);
    if (filter.origin) params.set("origin", filter.origin);
    if (filter.collectionId) params.set("collectionId", filter.collectionId);
    if (filter.wanted) params.set("wanted", filter.wanted);
    return request<ItemSearch>(`/items${params.size ? `?${params}` : ""}`);
  },
  getItem: (id: string) => request<ItemListing>(`/items/${id}`),
  findByBarcode: (code: string) => request<ItemSearch>(`/items?barcode=${encodeURIComponent(code)}`),
  createItem: (input: Partial<ItemInput> & { name: string }) =>
    request<Item>("/items", { method: "POST", body: JSON.stringify(input) }),
  updateItem: (id: string, patch: ItemPatch) =>
    request<Item>(`/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteItem: (id: string) => request<void>(`/items/${id}`, { method: "DELETE" }),
  /** One change to many things (≤200): move, category, tag, untag, delete. */
  bulkItems: (input: ItemsBulk) => request<ItemsBulkResult>("/items/bulk", { method: "POST", body: JSON.stringify(input) }),
  /** Recently deleted (30 days). */
  listDeleted: () => request<{ data: DeletedItem[] }>("/trash/items"),
  restoreDeleted: (id: string) => request<{ id: string; name: string }>(`/trash/items/${id}/restore`, { method: "POST" }),
  deleteForGood: (id: string) => request<void>(`/trash/items/${id}`, { method: "DELETE" }),

  imports: () => request<{ data: ImportBatchSummary[] }>("/import"),
  importRows: (input: ImportInput) => request<ImportResult>("/import", { method: "POST", body: JSON.stringify(input) }),
  undoImport: (id: string) => request<{ removed: number }>(`/import/${id}/undo`, { method: "POST" }),
  homeAssistantDevices: (input: HomeAssistantConnect) =>
    request<HaRegistryView>("/import/home-assistant/devices", { method: "POST", body: JSON.stringify(input) }),
  applyHomeAssistant: (input: HomeAssistantApply) =>
    request<{ updated: number }>("/import/home-assistant/apply", { method: "POST", body: JSON.stringify(input) }),

  householdSettings: () => request<HouseholdSettings>("/household/settings"),
  invitationEmails: () => request<InvitationEmails>("/household/invitations"),
  plan: () => request<PlanReport>("/plan"),
  /** `householdId`: a household other than the active one (just made). */
  setHouseholdSettings: (input: HouseholdSettingsInput, householdId?: string) =>
    request<HouseholdSettings>("/household/settings", {
      method: "PUT",
      body: JSON.stringify(input),
      headers: householdId ? { "X-Household-Id": householdId } : {},
    }),

  shares: () => request<{ data: ShareLinkSummary[] }>("/shares"),
  createShare: (input: ShareInput) => request<ShareLinkSummary>("/shares", { method: "POST", body: JSON.stringify(input) }),
  revokeShare: (id: string) => request<void>(`/shares/${id}/revoke`, { method: "POST" }),
  shareViews: (id: string) => request<{ data: ShareViewEntry[] }>(`/shares/${id}/views`),
  shared: (token: string) => request<SharedView>(`/shared/${token}`),
  sharedFileUrl: (token: string, id: string) => `/api/v1/shared/${token}/files/${id}`,
  sharedThumbnailUrl: (token: string, id: string) => `/api/v1/shared/${token}/files/${id}/thumbnail`,
  sharedCsvUrl: (token: string) => `/api/v1/shared/${token}/items.csv`,

  loans: (all = false) => request<{ data: LoanSummary[]; canEmail: boolean }>(`/loans${all ? "?all=true" : ""}`),
  itemLoans: (itemId: string) => request<{ data: LoanSummary[]; canEmail: boolean }>(`/items/${itemId}/loans`),
  lend: (itemId: string, input: LoanInput) => request<LoanSummary>(`/items/${itemId}/loans`, { method: "POST", body: JSON.stringify(input) }),
  updateLoan: (id: string, patch: LoanPatch) => request<LoanSummary>(`/loans/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  loanReturned: (id: string) => request<LoanSummary>(`/loans/${id}/returned`, { method: "POST", body: "{}" }),
  deleteLoan: (id: string) => request<void>(`/loans/${id}`, { method: "DELETE" }),
  borrowed: (token: string) => request<BorrowerView>(`/borrowed/${token}`),
  borrowedReturned: (token: string) => request<BorrowerView>(`/borrowed/${token}/returned`, { method: "POST" }),
  borrowedStop: (token: string) => request<BorrowerView>(`/borrowed/${token}/stop`, { method: "POST" }),

  recalls: () => request<{ data: ItemRecall[]; enabled: boolean }>("/recalls"),
  itemRecalls: (itemId: string) => request<{ data: ItemRecall[] }>(`/items/${itemId}/recalls`),
  resolveRecall: (id: string, status: "open" | "dismissed" | "done") => request<void>(`/recalls/${id}`, { method: "POST", body: JSON.stringify({ status }) }),
  coverage: () => request<{ data: CoverageCheck[] }>("/coverage"),
  addCoverage: (input: CoverageInput) => request<CoverageCheck>("/coverage", { method: "POST", body: JSON.stringify(input) }),
  updateCoverage: (id: string, input: CoverageInput) => request<CoverageCheck>(`/coverage/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCoverage: (id: string) => request<void>(`/coverage/${id}`, { method: "DELETE" }),
  weekly: () => request<WeeklyDigestSetting>("/me/weekly"),
  setWeekly: (input: WeeklyDigestInput) => request<WeeklyDigestSetting>("/me/weekly", { method: "PUT", body: JSON.stringify(input) }),

  places: () => request<PlacesTree>("/locations/tree"),
  categories: () => request<{ data: CategoryNode[] }>("/categories"),
  createCategory: (input: CategoryInput) =>
    request<{ id: string }>("/categories", { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (id: string, patch: CategoryPatch) =>
    request<{ id: string }>(`/categories/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteCategory: (id: string) => request<void>(`/categories/${id}`, { method: "DELETE" }),
  starterCategories: () => request<{ data: CategoryNode[] }>("/categories/starter", { method: "POST" }),
  collections: () => request<{ data: CollectionSummary[] }>("/collections"),
  collection: (id: string) => request<CollectionSummary>(`/collections/${encodeURIComponent(id)}`),
  createCollection: (input: CollectionInput) => request<CollectionSummary>("/collections", { method: "POST", body: JSON.stringify(input) }),
  updateCollection: (id: string, patch: CollectionPatch) =>
    request<CollectionSummary>(`/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteCollection: (id: string) => request<void>(`/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  templates: () => request<{ data: ItemTemplate[] }>("/templates"),
  createTemplate: (input: TemplateInput) => request<ItemTemplate>("/templates", { method: "POST", body: JSON.stringify(input) }),
  updateTemplate: (id: string, patch: TemplatePatch) => request<ItemTemplate>(`/templates/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTemplate: (id: string) => request<void>(`/templates/${id}`, { method: "DELETE" }),
  starterTemplates: () => request<{ data: ItemTemplate[] }>("/templates/starter", { method: "POST" }),
  tags: () => request<{ data: TagSummary[] }>("/tags"),
  renameTag: (id: string, name: string) => request<unknown>(`/tags/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteTag: (id: string) => request<void>(`/tags/${id}`, { method: "DELETE" }),
  createProperty: (input: Partial<PropertyInput> & { name: string }) =>
    request<{ id: string }>("/properties", { method: "POST", body: JSON.stringify(input) }),
  updateProperty: (id: string, patch: PropertyPatch) =>
    request<{ id: string }>(`/properties/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProperty: (id: string) => request<void>(`/properties/${id}`, { method: "DELETE" }),
  createLocation: (input: LocationInput) =>
    request<{ id: string }>("/locations", { method: "POST", body: JSON.stringify(input) }),
  updateLocation: (id: string, patch: LocationPatch) =>
    request<{ id: string }>(`/locations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteLocation: (id: string) => request<void>(`/locations/${id}`, { method: "DELETE" }),

  providers: () => request<{ data: Provider[] }>("/providers"),
  provider: (id: string) => request<Provider>(`/providers/${id}`),
  providerVisits: (id: string) => request<{ data: ProviderVisit[] }>(`/providers/${id}/visits`),
  createProvider: (input: ProviderInput) => request<Provider>("/providers", { method: "POST", body: JSON.stringify(input) }),
  updateProvider: (id: string, patch: ProviderPatch) =>
    request<Provider>(`/providers/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProvider: (id: string) => request<void>(`/providers/${id}`, { method: "DELETE" }),
  listMaintenance: (filter: { itemId?: string; providerId?: string; status?: "open" | "all" | "done" } = {}) => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
    return request<{ data: MaintenanceTask[] }>(`/maintenance${params.size ? `?${params}` : ""}`);
  },
  createMaintenance: (input: MaintenanceInput) =>
    request<MaintenanceTask>("/maintenance", { method: "POST", body: JSON.stringify(input) }),
  updateMaintenance: (id: string, patch: MaintenancePatch) =>
    request<MaintenanceTask>(`/maintenance/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMaintenance: (id: string) => request<void>(`/maintenance/${id}`, { method: "DELETE" }),
  maintenanceDone: (id: string, input: MaintenanceDone) =>
    request<MaintenanceTask>(`/maintenance/${id}/done`, { method: "POST", body: JSON.stringify(input) }),
  maintenanceHistory: (id: string) => request<{ data: MaintenanceLogEntry[] }>(`/maintenance/${id}/history`),
  calendarStatus: () =>
    request<{ active: boolean; createdAt: string | null; url: string | null; webcal: string | null }>("/calendar"),
  createCalendar: () => request<{ url: string; webcal: string }>("/calendar", { method: "POST" }),
  deleteCalendar: () => request<void>("/calendar", { method: "DELETE" }),
  pushStatus: (endpoint?: string) =>
    request<{ enabled: boolean; publicKey: string | null; subscribed: boolean }>(
      `/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`,
    ),
  pushSubscribe: (subscription: PushSubscriptionJSON) =>
    request<void>("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) }),
  pushUnsubscribe: (endpoint: string) =>
    request<void>("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),
  pushTest: () => request<{ sent: number }>("/push/test", { method: "POST" }),
  listNotifications: () => request<{ enabled: boolean; data: NotificationChannel[] }>("/notifications"),
  addNotification: (input: NotificationChannelInput) =>
    request<NotificationChannel>("/notifications", { method: "POST", body: JSON.stringify(input) }),
  deleteNotification: (id: string) => request<void>(`/notifications/${id}`, { method: "DELETE" }),
  /** "Email me a link to sign in again" — always succeeds (never says whether the account exists). */
  requestUnlock: (email: string) => request<void>("/sign-in/unlock-request", { method: "POST", body: JSON.stringify({ email }) }),
  useUnlock: (token: string) => request<void>("/sign-in/unlock", { method: "POST", body: JSON.stringify({ token }) }),
  listSessions: () => request<{ data: SessionSummary[] }>("/security/sessions"),
  revokeSession: (id: string) => request<void>(`/security/sessions/${id}`, { method: "DELETE" }),
  revokeOtherSessions: () => request<{ signedOut: number }>("/security/sessions/revoke-others", { method: "POST" }),
  listSignIns: () => request<{ data: SignInEntry[] }>("/security/sign-ins"),
  testNotification: (id: string) => request<{ sent: true }>(`/notifications/${id}/test`, { method: "POST" }),

  /** Add from a web address: the server downloads it (public internet, photos and PDFs only). */
  addFromWeb: (itemId: string, input: DownloadInput) =>
    request<PendingDownload>(`/items/${itemId}/downloads`, { method: "POST", body: JSON.stringify(input) }),
  listDownloads: (itemId: string) => request<{ data: PendingDownload[] }>(`/items/${itemId}/downloads`),
  dismissDownload: (id: string) => request<void>(`/downloads/${id}`, { method: "DELETE" }),
  listAttachments: (itemId: string) => request<{ data: Attachment[] }>(`/items/${itemId}/attachments`),
  uploadAttachment: upload,
  deleteAttachment: (id: string) => request<void>(`/attachments/${id}`, { method: "DELETE" }),
  analyzeAttachment: (id: string) => request<Attachment>(`/attachments/${id}/analyze`, { method: "POST" }),
  dismissSuggestions: (id: string) => request<void>(`/attachments/${id}/dismiss-suggestions`, { method: "POST" }),
  listClaims: (filter: { itemId?: string; open?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (filter.itemId) params.set("itemId", filter.itemId);
    if (filter.open) params.set("open", "true");
    return request<{ data: WarrantyClaim[] }>(`/claims${params.size ? `?${params}` : ""}`);
  },
  fileClaim: (warrantyId: string, input: ClaimInput) =>
    request<WarrantyClaim>(`/warranties/${warrantyId}/claims`, { method: "POST", body: JSON.stringify(input) }),
  updateClaim: (id: string, patch: ClaimPatch) => request<WarrantyClaim>(`/claims/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteClaim: (id: string) => request<void>(`/claims/${id}`, { method: "DELETE" }),
  listWarranties: (itemId: string) => request<{ data: Warranty[] }>(`/items/${itemId}/warranties`),
  addWarranty: (itemId: string, input: WarrantyInput) =>
    request<Warranty>(`/items/${itemId}/warranties`, { method: "POST", body: JSON.stringify(input) }),
  deleteWarranty: (id: string) => request<void>(`/warranties/${id}`, { method: "DELETE" }),
  listApiKeys: () => request<{ data: ApiKeySummary[] }>("/api-keys"),
  createApiKey: (input: ApiKeyInput) => request<NewApiKey>("/api-keys", { method: "POST", body: JSON.stringify(input) }),
  deleteApiKey: (id: string) => request<void>(`/api-keys/${id}`, { method: "DELETE" }),
  /** Same-origin URL, so <img> and links carry the session cookie. */
  attachmentUrl: (id: string) => `/api/v1/attachments/${id}/content`,
  /** Small WebP for grids (falls back to the original server-side). */
  thumbnailUrl: (id: string) => `/api/v1/attachments/${id}/thumbnail`,
};
