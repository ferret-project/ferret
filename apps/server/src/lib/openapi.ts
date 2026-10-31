/**
 * The REST API described as OpenAPI 3.1, served at /api/v1/openapi.json and
 * shown in the app (Settings → API reference). Request bodies and query
 * parameters come from the same zod schemas the routes validate with, so they
 * can't drift; test/openapi.test.ts fails if a route is added without an entry.
 */
import {
  householdSettingsInput,
  pairingInput,
  homeAssistantConnect,
  homeAssistantApply,
  shareInput,
  itemsBulk,
  usageReadingInput,
  coverageInput,
  weeklyDigestInput,
  loanInput,
  loanPatch,
  importInput,
  scanInput,
  serverAdminInput,
  stockAdjust,
  stockRuleInput,
  apiKeyInput,
  askInput,
  categoryInput,
  categoryPatch,
  claimInput,
  downloadInput,
  claimPatch,
  itemInput,
  itemPatch,
  labelTarget,
  attachLabelInput,
  roomScanCommit,
  templateInput,
  templatePatch,
  collectionInput,
  collectionPatch,
  listQuery,
  locationInput,
  locationPatch,
  maintenanceDone,
  maintenanceInput,
  maintenancePatch,
  notificationChannelInput,
  propertyInput,
  propertyPatch,
  providerInput,
  providerPatch,
  warrantyInput,
  warrantyPatch,
  householdDeleteInput,
  accountDeleteInput,
} from "@ferret/shared";
import { z } from "zod";
import { BROWSER_EVENTS } from "./analytics";
import { DEMO_PARTS } from "./demo-switches";

type Method = "get" | "post" | "put" | "patch" | "delete";
/** How a request proves who it is: an API key or session (the default), a signed-in session only, or nothing. */
type Auth = "any" | "session" | "none";

interface Operation {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodType;
  /** A multipart upload instead of JSON (`form`: its fields, when not an item's `file` + `kind`). */
  upload?: boolean;
  form?: object;
  query?: z.ZodObject;
  auth?: Auth;
  /** Read-only keys and viewers can't call it. */
  writes?: boolean;
  /** What comes back, in words (the shared types in packages/shared describe them exactly). */
  returns?: string;
  /** Not JSON: e.g. "text/csv", "image/*". */
  produces?: string;
  /** 201 for creates; deletes are 204; otherwise 200. */
  status?: 200 | 201 | 202 | 204;
}

const id = (what: string) => `The ${what}'s id`;

export const OPERATIONS: Operation[] = [
  // ── Account ────────────────────────────────────────────────────────────────
  { method: "get", path: "/me", tag: "Account", summary: "Who you are, and your active household", returns: "{ user, activeHouseholdId }" },
  { method: "get", path: "/openapi.json", tag: "Account", summary: "This description of the API (OpenAPI 3.1)" },
  { method: "post", path: "/usage", tag: "Account", summary: "Count a visit, the Home Screen offer taken, a return or \"Run your own\" (the public demo; nothing about who)", auth: "none", body: z.object({ event: z.enum(BROWSER_EVENTS), ref: z.string().max(200).optional() }), returns: "204" },
  { method: "get", path: "/auth-options", tag: "Account", summary: "Whether sign-up is open, and whether password reset and emailed sign-in links (both need email) are", auth: "none", returns: "{ signUp, passwordReset, signInLink, humanCheck?, demo? }" },
  { method: "get", path: "/invitations/{id}", tag: "Account", summary: "What an invitation link is for", auth: "none", returns: "InvitationPreview" },
  { method: "get", path: "/api-keys", tag: "Account", summary: "Your API keys for this household", auth: "session", returns: "{ data: ApiKeySummary[] }" },
  { method: "post", path: "/api-keys", status: 201, tag: "Account", summary: "Make an API key (shown once)", auth: "session", body: apiKeyInput, returns: "NewApiKey" },
  { method: "delete", path: "/api-keys/{id}", tag: "Account", summary: "Revoke an API key", auth: "session" },
  { method: "post", path: "/sign-in/unlock-request", status: 204, tag: "Account", summary: "Email me a link to sign in again (always 204 — never says whether the account exists)", auth: "none", body: z.object({ email: z.email() }) },
  { method: "post", path: "/sign-in/unlock", tag: "Account", summary: "Use a sign-in link: clears the wrong-password count (410 if used or expired)", auth: "none", body: z.object({ token: z.string() }) },
  { method: "get", path: "/security/sessions", tag: "Account", summary: "Where you're signed in (this session first)", auth: "session", returns: "{ data: SessionSummary[] }" },
  { method: "delete", path: "/security/sessions/{id}", tag: "Account", summary: "Sign out one of your other sessions", auth: "session" },
  { method: "post", path: "/security/sessions/revoke-others", tag: "Account", summary: "Sign out everywhere but here", auth: "session", returns: "{ signedOut }" },
  { method: "get", path: "/security/sign-ins", tag: "Account", summary: "Your last dozen sign-ins and wrong passwords: when, from where, on what", auth: "session", returns: "{ data: SignInEntry[] }" },

  // ── Items ──────────────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/items",
    tag: "Items",
    summary: "List or search items",
    description:
      "Without `q`: newest first, a page at a time. With `q`: words and meaning (semantic search), best first, with `hits` saying why each matched. `locationId` and `categoryId` include everything nested inside.",
    query: listQuery,
    returns: "ItemSearch (items with photoId, place, category, container, contents, labelCode)",
  },
  { method: "post", path: "/items", status: 201, tag: "Items", summary: "Add an item", body: itemInput, writes: true, returns: "ItemListing" },
  { method: "get", path: "/items/{id}", tag: "Items", summary: "One item", returns: "ItemListing" },
  { method: "get", path: "/items/{id}/history", tag: "Items", summary: "What happened to an item, newest first: added, edits (what changed), moves, photos, warranties, maintenance, stock (?limit=, ?offset=)", returns: "{ data: ItemHistoryEntry[], more }" },
  { method: "get", path: "/items/{id}/usage", tag: "Maintenance", summary: "Maintenance by use: what the item counts (miles, hours…), its readings (newest first), the latest, and how fast it goes up per day", returns: "UsageSummary" },
  { method: "post", path: "/items/{id}/usage", tag: "Maintenance", summary: "Log a reading (odometer, hour meter): its maintenance by use is rescheduled from it", body: usageReadingInput, writes: true, returns: "UsageReading" },
  { method: "delete", path: "/usage/{id}", tag: "Maintenance", summary: "Remove a reading (a typo)", writes: true },
  { method: "post", path: "/items/bulk", tag: "Items", summary: "One change to up to 200 things: move (locationId), category (categoryId), tag, untag (tag) or delete", body: itemsBulk, writes: true, returns: "ItemsBulkResult" },
  {
    method: "patch",
    path: "/items/{id}",
    tag: "Items",
    summary: "Change an item",
    description: "Only the fields sent change. `tags` replaces the whole set. Inside a box (`containerItemId`), an item is wherever the box is.",
    body: itemPatch,
    writes: true,
    returns: "ItemListing",
  },
  { method: "delete", path: "/items/{id}", tag: "Items", summary: "Remove an item", description: "Soft delete. A box's contents stay where they are.", writes: true },
  { method: "post", path: "/ask", tag: "Items", summary: "Ask Ferret a question", description: "Answered from your own items and documents, with citations.", body: askInput, returns: "AskAnswer" },
  {
    method: "get",
    path: "/attention",
    tag: "Items",
    summary: "What needs doing now",
    description: "Maintenance overdue or due within a week, warranties ending within 30 days, claims with no news for 14 days, and photo-added items still to name. Urgent first. Entries disappear once dealt with.",
    returns: "{ data: AttentionItem[] }",
  },
  { method: "get", path: "/overview", tag: "Items", summary: "The dashboard: value, gaps, warranties, maintenance, recent changes", returns: "Overview" },

  {
    method: "get",
    path: "/barcodes/{code}",
    tag: "Items",
    summary: "What a scanned barcode is",
    description:
      "From Ferret's own barcode book (learned from saved items, shared by the server), else the online product database when it's switched on. `match` is null when nobody knows it. `have` lists the household's things with this code already — offer to add to one (POST /scan with its itemId, mode restock) before adding another.",
    returns: "{ match: BarcodeMatch | null, online, have: ScanCandidate[] }",
  },
  { method: "get", path: "/items/{id}/product", tag: "Items", summary: "The online database's details for an item's barcode", returns: "ItemProduct" },
  {
    method: "post",
    path: "/items/{id}/product/photo",
    tag: "Items",
    summary: "Attach one of the product's photos",
    body: z.object({ index: z.number().int().min(0).max(7) }),
    writes: true,
    status: 201,
    returns: "Attachment",
  },
  { method: "post", path: "/items/{id}/product/dismiss", tag: "Items", summary: "Hide an item's product suggestions", writes: true, status: 204 },

  // ── Photos and documents ───────────────────────────────────────────────────
  { method: "get", path: "/items/{id}/attachments", tag: "Photos & documents", summary: "An item's photos and documents", returns: "{ data: Attachment[] }" },
  {
    method: "post",
    path: "/items/{id}/attachments",
    status: 201,
    tag: "Photos & documents",
    summary: "Upload a photo or document",
    description:
      "multipart/form-data with `file` and `kind` (photo | document). The type is sniffed, not trusted. Analysis runs in the background (`analyze=false`: don't — nothing to read in it). `main=true`: a photo becomes the item's main photo. Optionally `thumbnail` (≤ 600 px, ≤ 400 KB) and `preview` (≤ 1600 px, ≤ 2 MB, what the vision model looks at) — WebP, JPEG or PNG made by the client; otherwise the server makes them.",
    upload: true,
    writes: true,
    returns: "Attachment",
  },
  { method: "get", path: "/attachments/{id}/content", tag: "Photos & documents", summary: "The original file", produces: "*/*" },
  { method: "get", path: "/attachments/{id}/thumbnail", tag: "Photos & documents", summary: "A small copy (WebP, or JPEG if the client made it), or the original", produces: "image/*" },
  { method: "post", path: "/attachments/{id}/main", tag: "Photos & documents", summary: "Make it the item's main photo", description: "Its picture in lists, and first on its page.", writes: true },
  { method: "post", path: "/attachments/{id}/analyze", tag: "Photos & documents", summary: "Read it again (vision model / docling)", writes: true, returns: "Attachment" },
  { method: "post", path: "/attachments/{id}/dismiss-suggestions", status: 204, tag: "Photos & documents", summary: "Hide its suggestions", writes: true },
  { method: "delete", path: "/attachments/{id}", tag: "Photos & documents", summary: "Remove a photo or document", writes: true },

  // ── Places ─────────────────────────────────────────────────────────────────
  { method: "get", path: "/properties", tag: "Places", summary: "Properties", returns: "{ data: Property[] }" },
  { method: "post", path: "/properties", status: 201, tag: "Places", summary: "Add a property", body: propertyInput, writes: true },
  { method: "patch", path: "/properties/{id}", tag: "Places", summary: "Change a property", body: propertyPatch, writes: true },
  { method: "delete", path: "/properties/{id}", tag: "Places", summary: "Remove an empty property", description: "409 while anything is kept in it.", writes: true },
  {
    method: "get",
    path: "/properties/{id}/map",
    tag: "Places",
    summary: "A map picture of the property's address",
    description: "PNG from Apple Maps, fetched by the server (`?scheme=dark` for dark mode). 404 without an address, or when maps aren't set up (APPLE_MAPS_*).",
    produces: "image/png",
  },
  { method: "get", path: "/locations", tag: "Places", summary: "Locations (flat)", query: z.object({ propertyId: z.string().optional() }), returns: "{ data: Location[] }" },
  { method: "get", path: "/locations/tree", tag: "Places", summary: "Properties with their locations as a tree, counts and values", returns: "PlacesTree" },
  { method: "post", path: "/locations", status: 201, tag: "Places", summary: "Add a location", body: locationInput, writes: true },
  { method: "patch", path: "/locations/{id}", tag: "Places", summary: "Rename or move a location", body: locationPatch, writes: true },
  { method: "delete", path: "/locations/{id}", tag: "Places", summary: "Remove an empty location", description: "409 while anything is kept inside.", writes: true },

  // ── Categories and tags ────────────────────────────────────────────────────
  { method: "get", path: "/categories", tag: "Categories & tags", summary: "Categories as a tree", returns: "{ data: CategoryNode[] }" },
  { method: "post", path: "/categories", status: 201, tag: "Categories & tags", summary: "Add a category", body: categoryInput, writes: true },
  { method: "post", path: "/categories/starter", status: 201, tag: "Categories & tags", summary: "Add the starter set (none yet only)", writes: true },
  { method: "patch", path: "/categories/{id}", tag: "Categories & tags", summary: "Rename, move or change fields", body: categoryPatch, writes: true },
  { method: "delete", path: "/categories/{id}", tag: "Categories & tags", summary: "Remove a category", description: "Its items and subcategories move up a level.", writes: true },
  { method: "get", path: "/tags", tag: "Categories & tags", summary: "Tags with item counts", returns: "{ data: TagSummary[] }" },
  { method: "patch", path: "/tags/{id}", tag: "Categories & tags", summary: "Rename a tag (onto another = merge)", body: z.object({ name: z.string().min(1).max(40) }), writes: true },
  { method: "delete", path: "/tags/{id}", tag: "Categories & tags", summary: "Remove a tag", writes: true },

  // ── Warranties ─────────────────────────────────────────────────────────────
  { method: "get", path: "/warranties", tag: "Warranties", summary: "All warranties, soonest to end first", query: z.object({ status: z.enum(["active", "expiring", "expired"]).optional() }) },
  { method: "get", path: "/items/{id}/warranties", tag: "Warranties", summary: "An item's warranties", returns: "{ data: Warranty[] }" },
  { method: "post", path: "/items/{id}/warranties", status: 201, tag: "Warranties", summary: "Add a warranty", body: warrantyInput, writes: true },
  { method: "patch", path: "/warranties/{id}", tag: "Warranties", summary: "Change a warranty", body: warrantyPatch, writes: true },
  { method: "delete", path: "/warranties/{id}", tag: "Warranties", summary: "Remove a warranty", writes: true },
  { method: "get", path: "/claims", tag: "Warranties", summary: "Warranty claims", query: z.object({ itemId: z.string().optional(), open: z.enum(["true"]).optional() }), returns: "{ data: WarrantyClaim[] }" },
  { method: "get", path: "/warranties/{id}/claims", tag: "Warranties", summary: "A warranty's claims", returns: "{ data: WarrantyClaim[] }" },
  { method: "post", path: "/warranties/{id}/claims", status: 201, tag: "Warranties", summary: "File a claim", body: claimInput, writes: true, returns: "WarrantyClaim" },
  { method: "patch", path: "/claims/{id}", tag: "Warranties", summary: "Update a claim", body: claimPatch, writes: true, returns: "WarrantyClaim" },
  { method: "delete", path: "/claims/{id}", tag: "Warranties", summary: "Remove a claim", writes: true },

  // ── Maintenance ────────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/maintenance",
    tag: "Maintenance",
    summary: "Maintenance tasks, soonest due first",
    query: z.object({ itemId: z.string().optional(), providerId: z.string().optional(), status: z.enum(["open", "all", "overdue", "due", "upcoming", "done"]).optional() }),
    returns: "{ data: MaintenanceTask[] }",
  },
  { method: "post", path: "/maintenance", status: 201, tag: "Maintenance", summary: "Add a task", body: maintenanceInput, writes: true, returns: "MaintenanceTask" },
  { method: "get", path: "/maintenance/{id}", tag: "Maintenance", summary: "One task", returns: "MaintenanceTask" },
  { method: "patch", path: "/maintenance/{id}", tag: "Maintenance", summary: "Change a task", body: maintenancePatch, writes: true, returns: "MaintenanceTask" },
  { method: "delete", path: "/maintenance/{id}", tag: "Maintenance", summary: "Stop tracking a task", writes: true },
  {
    method: "post",
    path: "/maintenance/{id}/done",
    tag: "Maintenance",
    summary: "Mark a task done",
    description: "Logs it (who, cost, provider) and moves the next due date on from the day it was done.",
    body: maintenanceDone,
    writes: true,
    returns: "MaintenanceTask",
  },
  { method: "get", path: "/maintenance/{id}/history", tag: "Maintenance", summary: "When a task was done", returns: "{ data: MaintenanceLogEntry[] }" },
  { method: "get", path: "/providers", tag: "Maintenance", summary: "Service providers, with jobs and spend", returns: "{ data: Provider[] }" },
  { method: "post", path: "/providers", status: 201, tag: "Maintenance", summary: "Add a provider", body: providerInput, writes: true, returns: "Provider" },
  { method: "get", path: "/providers/{id}", tag: "Maintenance", summary: "One provider", returns: "Provider" },
  { method: "patch", path: "/providers/{id}", tag: "Maintenance", summary: "Change a provider", body: providerPatch, writes: true, returns: "Provider" },
  { method: "delete", path: "/providers/{id}", tag: "Maintenance", summary: "Remove a provider", writes: true },
  { method: "get", path: "/providers/{id}/visits", tag: "Maintenance", summary: "The jobs a provider did", returns: "{ data: ProviderVisit[] }" },

  // ── Add from a web address ──────────────────────────────────────────────────
  { method: "post", path: "/items/{id}/downloads", status: 202, tag: "Photos & documents", summary: "Add a photo or PDF from a web address — the server downloads it (public internet only) in the background", body: downloadInput, writes: true, returns: "PendingDownload" },
  { method: "get", path: "/items/{id}/downloads", tag: "Photos & documents", summary: "Downloads still on their way, or failed (with why)", returns: "{ data: PendingDownload[] }" },
  { method: "delete", path: "/downloads/{id}", tag: "Photos & documents", summary: "Dismiss a failed download", writes: true },

  // ── Recently deleted ───────────────────────────────────────────────────────
  { method: "get", path: "/trash/items", tag: "Items", summary: "Items deleted in the last 30 days, newest first", returns: "{ data: DeletedItem[] }" },
  { method: "post", path: "/trash/items/{id}/restore", tag: "Items", summary: "Restore a deleted item (with its photos, warranties and maintenance)", writes: true, returns: "{ id, name }" },
  { method: "delete", path: "/trash/items/{id}", tag: "Items", summary: "Delete a deleted item for good, now", writes: true },

  // ── Stock ──────────────────────────────────────────────────────────────────
  { method: "post", path: "/scan", tag: "Stock", summary: "What scanning a code does: open it, change its count, or ask", description: "`mode`: auto (each code as it's set up), lookup, use or restock. A code on several items answers `choose`: send it again with `itemId`. A viewer's scan only looks up.", body: scanInput, returns: "ScanResult" },
  { method: "get", path: "/items/{id}/stock", tag: "Stock", summary: "An item's count, what its codes do, and its recent changes", returns: "StockSummary" },
  { method: "post", path: "/items/{id}/stock", tag: "Stock", summary: "Change an item's count (never below 0)", body: stockAdjust, writes: true, returns: "{ quantity, applied, movementId }" },
  { method: "put", path: "/items/{id}/stock-rules", tag: "Stock", summary: "Set what scanning a code does to this item", body: stockRuleInput, writes: true, returns: "StockRule" },
  { method: "delete", path: "/items/{id}/stock-rules/{ruleId}", tag: "Stock", summary: "Forget what a code does to this item", writes: true },
  { method: "get", path: "/shopping", tag: "Stock", summary: "The shopping list: tracked things that have run out, or are at or below \"keep at least\" (minQuantity)", returns: "ShoppingList" },
  { method: "post", path: "/stock/movements/{id}/undo", tag: "Stock", summary: "Undo a change to a count", writes: true, returns: "{ itemId, quantity, applied, movementId }" },

  // ── Pairing codes ──────────────────────────────────────────────────────────
  { method: "get", path: "/items/{id}/pairing", tag: "Pairing codes", summary: "An item's HomeKit / Matter pairing codes (not the codes themselves)", returns: "{ data: PairingCodeSummary[] }" },
  { method: "post", path: "/items/{id}/pairing", status: 201, tag: "Pairing codes", summary: "Save a pairing code (X-HM://…, MT:…, or as printed)", body: pairingInput, writes: true, returns: "PairingCodeSummary" },
  { method: "post", path: "/items/{id}/pairing/{pairingId}/reveal", tag: "Pairing codes", summary: "Show a pairing code (a real sign-in, not a key; not viewers; logged)", writes: true, returns: "PairingCodeRevealed" },
  { method: "delete", path: "/items/{id}/pairing/{pairingId}", tag: "Pairing codes", summary: "Remove a pairing code", writes: true },
  { method: "get", path: "/import", tag: "Import", summary: "Recent imports (with how many of their things are still here)", returns: "{ data: ImportBatchSummary[] }" },
  { method: "post", path: "/import", status: 201, tag: "Import", summary: "Import up to 100 things (places and categories by name or path, made if missing); pass batchId to add to one already started", body: importInput, writes: true, returns: "ImportResult" },
  { method: "post", path: "/import/{id}/undo", tag: "Import", summary: "Undo an import: everything it added that's still here goes to Recently deleted", writes: true, returns: "{ removed }" },
  { method: "post", path: "/import/home-assistant/devices", tag: "Import", summary: "Read Home Assistant's floors, areas and devices, duplicates folded (owners/admins, a real sign-in; the token isn't kept)", body: homeAssistantConnect, returns: "HaRegistryView" },
  { method: "post", path: "/import/home-assistant/apply", tag: "Import", summary: "Take what Home Assistant changed since an import (names, makers, rooms) and remember what it says now", body: homeAssistantApply, writes: true, returns: "{ updated }" },
  { method: "get", path: "/household/settings", tag: "Household", summary: "The household's settings: its time zone (null: not chosen — the server's own zone is used)", returns: "HouseholdSettings" },
  { method: "put", path: "/household/settings", tag: "Household", summary: "Set the household's time zone (owners/admins): what \"today\" is, and the hour reminders go out", body: householdSettingsInput, writes: true, returns: "HouseholdSettings" },
  // ── Collections ────────────────────────────────────────────────────────────
  { method: "get", path: "/collections", tag: "Categories & tags", summary: "Collections, with what's owned (and pieces, counting duplicates), on the want list, worth and cost", returns: "{ data: CollectionSummary[] }" },
  { method: "post", path: "/collections", status: 201, tag: "Categories & tags", summary: "Start a collection (a template's fields are its columns)", body: collectionInput, writes: true, returns: "CollectionSummary" },
  { method: "get", path: "/collections/{id}", tag: "Categories & tags", summary: "One collection — its things: GET /items?collectionId=…&wanted=include", returns: "CollectionSummary" },
  { method: "patch", path: "/collections/{id}", tag: "Categories & tags", summary: "Change a collection", body: collectionPatch, writes: true, returns: "CollectionSummary" },
  { method: "delete", path: "/collections/{id}", tag: "Categories & tags", summary: "Remove a collection: owned things stay (out of it), its want list goes to Recently deleted", writes: true },

  // ── Item templates ─────────────────────────────────────────────────────────
  { method: "get", path: "/templates", tag: "Categories & tags", summary: "Item templates: kinds of things with their own fields (coins, trading cards…), with how many things use each", returns: "{ data: ItemTemplate[] }" },
  { method: "post", path: "/templates", status: 201, tag: "Categories & tags", summary: "Add a template", body: templateInput, writes: true, returns: "ItemTemplate" },
  { method: "post", path: "/templates/starter", status: 201, tag: "Categories & tags", summary: "Add the starter templates the household doesn't have yet (coin, trading card, doll, toy, comic, stamp, record, LEGO)", writes: true, returns: "{ data: ItemTemplate[] }" },
  { method: "get", path: "/templates/{id}", tag: "Categories & tags", summary: "One template", returns: "ItemTemplate" },
  { method: "patch", path: "/templates/{id}", tag: "Categories & tags", summary: "Change a template (its things are re-indexed)", body: templatePatch, writes: true, returns: "ItemTemplate" },
  { method: "delete", path: "/templates/{id}", tag: "Categories & tags", summary: "Remove a template (things keep their values)", writes: true },

  // ── Room scans ─────────────────────────────────────────────────────────────
  { method: "get", path: "/room-scans", tag: "Room scans", summary: "Room scans still to finish: being looked at, ready to review, or failed", returns: "{ data: RoomScan[] }" },
  {
    method: "post",
    path: "/room-scans",
    status: 202,
    tag: "Room scans",
    summary: "Photograph a room: the vision model lists what's in it",
    description:
      "multipart/form-data: 1–5 `photo` parts and `locationId` (a room) or `containerItemId` (a box). One AI action per photo (402 when the plan has none left; 501 without the vision model; 403 on the public demo). Answers at once with status `pending`; `ready` when the candidates are in (GET it again) — then add the ones wanted with POST /room-scans/{id}/add.",
    upload: true,
    form: {
      type: "object",
      required: ["photo"],
      properties: { photo: { type: "array", items: { type: "string", format: "binary" } }, locationId: { type: "string" }, containerItemId: { type: "string" } },
    },
    writes: true,
    returns: "RoomScan",
  },
  { method: "get", path: "/room-scans/{id}", tag: "Room scans", summary: "A room scan: its status, what was found (name, category, count, where in which photo)", returns: "RoomScan" },
  { method: "get", path: "/room-scans/{id}/photos/{n}", tag: "Room scans", summary: "One of its photos (0-based)", produces: "image/jpeg" },
  {
    method: "post",
    path: "/room-scans/{id}/add",
    status: 201,
    tag: "Room scans",
    summary: "Add what was ticked, in the scanned room or box",
    description: "Each becomes an item (origin roomscan, linked to the scan). The answer lists them in the order given.",
    body: roomScanCommit,
    writes: true,
    returns: "{ items: { id, name }[] }",
  },
  { method: "delete", path: "/room-scans/{id}", tag: "Room scans", summary: "Dismiss a room scan (its photos are purged later)", writes: true },

  { method: "get", path: "/plan", tag: "Household", summary: "The household's plan (null on a home Ferret: nothing limited) and this period's usage — AI actions, barcode lookups, things, files, people — by person", returns: "PlanReport" },
  { method: "get", path: "/shares", tag: "Sharing", summary: "Share links (owners/admins, a real sign-in): each with its link, views and whether it still opens", returns: "{ data: ShareLinkSummary[] }" },
  { method: "post", path: "/shares", status: 201, tag: "Sharing", summary: "Make a read-only link to the insurance report (or one property), a tag's or a category's things, for 7, 30 or 90 days", body: shareInput, writes: true, returns: "ShareLinkSummary" },
  { method: "post", path: "/shares/{id}/revoke", tag: "Sharing", summary: "Turn a share link off", writes: true },
  { method: "get", path: "/shares/{id}/views", tag: "Sharing", summary: "When a share link was opened, and from where", returns: "{ data: ShareViewEntry[] }" },
  { method: "get", path: "/shared/{token}", tag: "Sharing", summary: "What a share link shows (no account: the link is the key); logged", auth: "none", returns: "SharedView" },
  { method: "get", path: "/shared/{token}/items.csv", tag: "Sharing", summary: "A share link's items as a spreadsheet (no account)", auth: "none", returns: "text/csv" },
  { method: "get", path: "/shared/{token}/files/{id}", tag: "Sharing", summary: "A shown item's photo or document, when the link shares files (no account)", auth: "none", returns: "the file" },
  { method: "get", path: "/shared/{token}/files/{id}/thumbnail", tag: "Sharing", summary: "A shown item's photo, small (no account)", auth: "none", returns: "image/webp" },
  { method: "get", path: "/loans", tag: "Lending", summary: "Things lent out and borrowed, still out (?all=true: and back in the last 90 days); canEmail: borrowers can be reminded", returns: "{ data: LoanSummary[], canEmail }" },
  { method: "get", path: "/items/{id}/loans", tag: "Lending", summary: "An item's loans, past and present", returns: "{ data: LoanSummary[], canEmail }" },
  { method: "post", path: "/items/{id}/loans", status: 201, tag: "Lending", summary: "Lend it to someone (with optional email reminders to them) or record it as borrowed", body: loanInput, writes: true, returns: "LoanSummary" },
  { method: "patch", path: "/loans/{id}", tag: "Lending", summary: "Change a loan: who, when it's due, reminders", body: loanPatch, writes: true, returns: "LoanSummary" },
  { method: "post", path: "/loans/{id}/returned", tag: "Lending", summary: "It's back (or given back): { on? }", writes: true, returns: "LoanSummary" },
  { method: "delete", path: "/loans/{id}", tag: "Lending", summary: "Remove a loan made by mistake", writes: true },
  { method: "get", path: "/borrowed/{token}", tag: "Lending", summary: "The borrower's page from a reminder email (no account)", auth: "none", returns: "BorrowerView" },
  { method: "post", path: "/borrowed/{token}/returned", tag: "Lending", summary: "The borrower says it's back (no account)", auth: "none", returns: "BorrowerView" },
  { method: "post", path: "/borrowed/{token}/stop", tag: "Lending", summary: "The borrower stops the reminders (no account)", auth: "none", returns: "BorrowerView" },
  { method: "get", path: "/recalls", tag: "Recalls", summary: "Open recalls that match your things (barcode, model, or possible: same maker and kind of thing); enabled: the server checks recalls", returns: "{ data: ItemRecall[], enabled }" },
  { method: "get", path: "/items/{id}/recalls", tag: "Recalls", summary: "An item's recalls, open or not", returns: "{ data: ItemRecall[] }" },
  { method: "post", path: "/recalls/{id}", tag: "Recalls", summary: "Not mine (dismissed), dealt with (done), or open again: { status }", writes: true },
  { method: "get", path: "/coverage", tag: "Coverage", summary: "Insurance limits next to what the things they cover are worth", returns: "{ data: CoverageCheck[] }" },
  { method: "post", path: "/coverage", status: 201, tag: "Coverage", summary: "Add a limit: everything, or a category or tag (optionally one property)", body: coverageInput, writes: true, returns: "CoverageCheck" },
  { method: "put", path: "/coverage/{id}", tag: "Coverage", summary: "Change a limit", body: coverageInput, writes: true, returns: "CoverageCheck" },
  { method: "delete", path: "/coverage/{id}", tag: "Coverage", summary: "Remove a limit", writes: true },
  { method: "get", path: "/me/weekly", tag: "Reminders", summary: "Your weekly summary: which day, and by email too (a real sign-in)", returns: "WeeklyDigestSetting" },
  { method: "put", path: "/me/weekly", tag: "Reminders", summary: "Set your weekly summary's day (null: none) and whether it's emailed", body: weeklyDigestInput, returns: "WeeklyDigestSetting" },

  // ── Backups ────────────────────────────────────────────────────────────────
  { method: "get", path: "/server/admin", tag: "Backups", summary: "Who the server admin is (the server admin)", returns: "{ id, name, email }" },
  { method: "put", path: "/server/admin", tag: "Backups", summary: "Hand the server admin over to another confirmed account", body: serverAdminInput, writes: true, returns: "{ id, name, email }" },
  { method: "get", path: "/server/demo", tag: "Server", summary: "The public demo's use: visitors, AI calls today, counts by day (server admin, demo only)", returns: "DemoReport" },
  { method: "get", path: "/server/demo/switches", tag: "Server", summary: "The demo's parts switched off (server admin, demo only)", returns: "{ off }" },
  { method: "put", path: "/server/demo/switches", tag: "Server", summary: "Switch parts of the demo off (the rest on) without redeploying", body: z.object({ off: z.array(z.enum(DEMO_PARTS)) }), writes: true, returns: "{ off }" },
  { method: "get", path: "/server/demo/usage", tag: "Server", summary: "What the demo's hosting has used against its plan (server admin, demo only)", returns: "{ usage: { title, note?, rows, details? } | null, error }" },
  {
    method: "delete",
    path: "/household",
    tag: "Household",
    summary: "Delete the household for good: everything in it, its files and search entries (its owner, signed in — not an API key)",
    description:
      "Body: { confirm: the household's name, password? }. When it's the only household you're in, your account is deleted with it (then your password is needed, or a sign-in in the last 15 minutes). Answers { accountDeleted }.",
    body: householdDeleteInput,
    writes: true,
    returns: "{ accountDeleted: boolean }",
  },
  {
    method: "get",
    path: "/household/invitations",
    tag: "Household",
    summary: "Whether this server emails invitations, and when each pending one was emailed (owners/admins)",
    description: "Invitations themselves are Better Auth's (/api/auth/organization/invite-member — `resend: true` emails one again).",
    returns: "InvitationEmails",
  },
  { method: "get", path: "/household/deletion", tag: "Household", summary: "Whether deleting the household takes your account too (it's the only one you're in)", returns: "HouseholdDeletionInfo" },
  { method: "get", path: "/security/account", tag: "Account", summary: "What deleting your account would take with it, or what stops it", returns: "AccountDeletionInfo" },
  {
    method: "delete",
    path: "/security/account",
    tag: "Account",
    summary: "Delete your account for good, with the households only you are in (signed in — not an API key)",
    description: "Body: { confirm: your email, password? }. Refused while you own a household others are in, or are the server admin with other accounts.",
    body: accountDeleteInput,
    writes: true,
  },
  { method: "get", path: "/server/barcode-lookups", tag: "Server", summary: "Online barcode lookups: on or off, and what's left of the database's daily allowance as of the last lookup (server admin)", returns: "BarcodeLookupStatus" },
  { method: "get", path: "/server/recalls", tag: "Server", summary: "Recall checks: on or off, brands asked about, recalls kept (server admin)", returns: "RecallStatus" },
  { method: "put", path: "/server/recalls", tag: "Server", summary: "Switch recall checks on (each household's brands are sent to the CPSC) or off: { enabled } (server admin)", writes: true, returns: "RecallStatus" },
  { method: "get", path: "/server/errors", tag: "Server", summary: "Failed calls to the services Ferret uses (AI models, Qdrant, docling, Apprise…), counted (server admin)", returns: "{ data: ServiceErrorEntry[] }" },
  { method: "delete", path: "/server/errors", tag: "Server", summary: "Clear the service error log (server admin)", writes: true },
  { method: "delete", path: "/server/errors/{id}", tag: "Server", summary: "Clear one service error (server admin)", writes: true },
  { method: "get", path: "/backup", tag: "Backups", summary: "How the server's backups are doing (the server admin, signed in)", returns: "BackupStatus" },
  { method: "post", path: "/backup", status: 202, tag: "Backups", summary: "Start a backup now (the server admin)", writes: true, returns: "{ queued }" },
  { method: "get", path: "/backup/snapshots", tag: "Backups", summary: "The nightly copies kept, newest first (the server admin)", returns: "{ data: BackupSnapshot[] }" },
  { method: "post", path: "/backup/snapshots/{name}/check", tag: "Backups", summary: "Open a copy the way a restore would (the server admin)", returns: "{ ok, summary }" },

  // ── Labels ─────────────────────────────────────────────────────────────────
  { method: "get", path: "/labels", tag: "QR labels", summary: "This household's labels", query: z.object({ blank: z.enum(["true"]).optional() }), returns: "{ data: Label[] }" },
  { method: "get", path: "/labels/{code}", tag: "QR labels", summary: "What a scanned code opens (in any of your households)", returns: "Label" },
  { method: "post", path: "/labels/blank", status: 201, tag: "QR labels", summary: "Make blank labels to print", body: z.object({ count: z.number().int().min(1).max(300) }), writes: true, returns: "{ codes }" },
  { method: "post", path: "/labels/for", tag: "QR labels", summary: "The label for an item or place (made if needed)", body: labelTarget, writes: true, returns: "Label" },
  {
    method: "post",
    path: "/labels/attach",
    tag: "QR labels",
    summary: "Put a label you already have on an item or place",
    description:
      "A blank Ferret label (its code or its QR's address) on an item or place, or — items and boxes — any other code: a pre-printed asset tag, a sticker from another app. Scanning it then opens the item. 409 when the code is already on something (`details`: its itemId and name).",
    body: attachLabelInput,
    writes: true,
    returns: "{ label: Label } | { ownLabel: OwnLabel }",
  },
  { method: "delete", path: "/labels/own/{id}", tag: "QR labels", summary: "Take a label someone brought off its item", writes: true },
  { method: "put", path: "/labels/{code}", tag: "QR labels", summary: "Put a blank label on an item or place", body: labelTarget, writes: true, returns: "Label" },
  { method: "delete", path: "/labels/{code}", tag: "QR labels", summary: "Take a label off (blank again)", writes: true },

  // ── Export ─────────────────────────────────────────────────────────────────
  { method: "get", path: "/export/items.json", tag: "Export", summary: "Every item for the insurance report", description: "`gone=lost`: what was lost or stolen instead, for a claim.", query: z.object({ propertyId: z.string().optional(), gone: z.enum(["lost"]).optional() }), returns: "{ data: ExportRow[] }" },
  { method: "get", path: "/export/items.csv", tag: "Export", summary: "Every item as a spreadsheet", description: "`gone=lost`: what was lost or stolen, with what happened and when.", query: z.object({ propertyId: z.string().optional(), gone: z.enum(["lost"]).optional() }), produces: "text/csv" },
  { method: "get", path: "/export/everything.zip", tag: "Export", summary: "Everything — data and files, decrypted — as a ZIP (owners and admins, signed in)", produces: "application/zip" },

  // ── Reminders (signed-in session only) ─────────────────────────────────────
  { method: "get", path: "/calendar", tag: "Reminders", summary: "Whether you have a calendar feed", auth: "session" },
  { method: "post", path: "/calendar", status: 201, tag: "Reminders", summary: "Make a calendar feed link (shown once; replaces the old one)", auth: "session", returns: "{ url, webcal }" },
  { method: "delete", path: "/calendar", tag: "Reminders", summary: "Turn the calendar feed off", auth: "session" },
  { method: "get", path: "/push", tag: "Reminders", summary: "Push status for this device", auth: "session", query: z.object({ endpoint: z.string().optional() }) },
  {
    method: "post",
    path: "/push/subscribe",
    status: 204,
    tag: "Reminders",
    summary: "Subscribe this device to push reminders",
    auth: "session",
    body: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  },
  { method: "post", path: "/push/unsubscribe", status: 204, tag: "Reminders", summary: "Unsubscribe a device", auth: "session", body: z.object({ endpoint: z.string() }) },
  { method: "post", path: "/push/test", tag: "Reminders", summary: "Send a test notification to your devices", auth: "session", returns: "{ sent }" },
  { method: "get", path: "/notifications", tag: "Reminders", summary: "Your reminders to other apps (Apprise), and whether the server has Apprise", auth: "session", returns: "{ enabled, data: NotificationChannel[] }" },
  { method: "post", path: "/notifications", status: 201, tag: "Reminders", summary: "Add an Apprise URL (ntfy, Pushover, Telegram…) to get reminders at", auth: "session", body: notificationChannelInput, returns: "NotificationChannel" },
  { method: "delete", path: "/notifications/{id}", tag: "Reminders", summary: "Stop reminders to one of them", auth: "session" },
  { method: "post", path: "/notifications/{id}/test", tag: "Reminders", summary: "Send a test message (502 with the reason if it fails)", auth: "session", returns: "{ sent }" },
];

export const statusOf = (op: Operation) => op.status ?? (op.method === "delete" ? 204 : 200);

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

/** The OpenAPI document for this server. */
export function openApiDocument(publicUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
      description: m[1] === "code" ? "A label code" : id(op.tag.toLowerCase().replace(/s( &.*)?$/, "")),
    }));
    const queryParams = op.query
      ? Object.entries(op.query.shape).map(([name, schema]) => ({
          name,
          in: "query",
          required: false,
          schema: jsonSchema(schema as z.ZodType),
        }))
      : [];
    const security = op.auth === "none" ? [] : op.auth === "session" ? [{ session: [] }] : [{ apiKey: [] }, { apiKeyHeader: [] }, { session: [] }];
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      tags: [op.tag],
      summary: op.summary,
      description: [op.description, op.writes && "Not for read-only keys or viewers.", op.returns && `Returns: ${op.returns}.`]
        .filter(Boolean)
        .join("\n\n") || undefined,
      operationId: `${op.method}${op.path.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+(\w)/g, (_, c: string) => c.toUpperCase())}`,
      security,
      parameters: [...pathParams, ...queryParams],
      requestBody: op.upload
        ? {
            required: true,
            content: {
              "multipart/form-data": {
                schema: op.form ?? {
                  type: "object",
                  required: ["file"],
                  properties: { file: { type: "string", format: "binary" }, kind: { type: "string", enum: ["photo", "document"] }, analyze: { type: "string", enum: ["false"] } },
                },
              },
            },
          }
        : op.body
          ? { required: true, content: { "application/json": { schema: jsonSchema(op.body) } } }
          : undefined,
      responses: {
        [String(statusOf(op))]:
          statusOf(op) === 204
            ? { description: "Done (no body)" }
            : { description: op.returns ?? "OK", content: { [op.produces ?? "application/json"]: {} } },
        "4XX": { description: "{ error: { code, message } }", content: { "application/json": {} } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Ferret",
      version: "1",
      description:
        "Ferret's REST API: the same household inventory the app and Claude (MCP, at /mcp) use. Every call acts in one household. Make an API key in Settings → API keys and send it as `Authorization: Bearer ferret_…` (or `x-api-key`).",
    },
    servers: [{ url: `${publicUrl}/api/v1` }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "An API key from Settings → API keys (ferret_…)" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key" },
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "The app's sign-in" },
      },
    },
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
  };
}
