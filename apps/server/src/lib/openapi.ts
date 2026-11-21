/**
 * The REST API described as OpenAPI 3.1, served at /api/v1/openapi.json and
 * made into the help's API reference (apps/docs/api-pages.mjs). Request bodies and query
 * parameters come from the same zod schemas the routes validate with, so they
 * can't drift; test/openapi.test.ts fails if a route is added without an entry.
 */
import {
  collectibleKinds,
  collectibleSearch,
  collectibleKeyInput,
  taskVideoInput,
  householdSettingsInput,
  pairingInput,
  homeAssistantConnect,
  homeAssistantApply,
  shareInput,
  webhookInput,
  paperlessAddInput,
  paperlessAttachInput,
  paperlessInput,
  webhookPatch,
  itemsBulk,
  usageReadingInput,
  cardGames,
  coverageInput,
  weeklyDigestInput,
  languageInput,
  loanInput,
  loanPatch,
  importInput,
  importKnownInput,
  scanInput,
  serverAdminInput,
  askSettingsInput,
  promptExtraInput,
  stockAdjust,
  stockRuleInput,
  apiKeyInput,
  oauthConnectInput,
  askInput,
  dismissPartInput,
  itemFindQuery,
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
  mergeInput,
  importTriageInput,
  filtersFromTextInput, itemFromTextInput, receiptLinesInput, replacementEstimatesInput,
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
  reviewItemBody,
  repairInput,
  repairPatch,
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
  { method: "get", path: "/openapi.json", tag: "Account", summary: "This description of the API (OpenAPI 3.1)", auth: "none" },
  { method: "post", path: "/usage", tag: "Account", summary: "Count a visit, the Home Screen offer taken, a return or \"Run your own\" (the public demo; nothing about who)", auth: "none", body: z.object({ event: z.enum(BROWSER_EVENTS), ref: z.string().max(200).optional() }), returns: "204" },
  { method: "get", path: "/auth-options", tag: "Account", summary: "Whether sign-up is open, and whether password reset and emailed sign-in links (both need email) are", auth: "none", returns: "{ signUp, passwordReset, signInLink, humanCheck?, demo? }" },
  { method: "get", path: "/invitations/{id}", tag: "Account", summary: "What an invitation link is for", auth: "none", returns: "InvitationPreview" },
  { method: "get", path: "/api-keys", tag: "Account", summary: "Your API keys for this household", auth: "session", returns: "{ data: ApiKeySummary[] }" },
  { method: "post", path: "/api-keys", status: 201, tag: "Account", summary: "Make an API key (shown once)", auth: "session", body: apiKeyInput, returns: "NewApiKey" },
  { method: "delete", path: "/api-keys/{id}", tag: "Account", summary: "Revoke an API key", auth: "session" },
  { method: "get", path: "/oauth/connect", tag: "Account", summary: "An app asking to sign in with OAuth (the \"Connect an app\" screen): what it calls itself, where it sends you back, and your households", auth: "session", query: z.object({ client_id: z.string() }), returns: "OAuthConnectRequest" },
  { method: "post", path: "/oauth/connect", tag: "Account", summary: "Pick the household an app signing in with OAuth gets, and whether it can change things (the next step of the sign-in reads it)", auth: "session", body: oauthConnectInput, returns: "{ ok: true }" },
  { method: "get", path: "/oauth/grants", tag: "Account", summary: "Apps connected to this household with your account (OAuth)", auth: "session", returns: "{ data: OAuthGrantSummary[] }" },
  { method: "delete", path: "/oauth/grants/{id}", tag: "Account", summary: "Disconnect an app: its tokens for this household stop working at once", auth: "session" },
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
  { method: "get", path: "/items/{id}/parts", tag: "Items", summary: "A thing's parts and supplies (items with partOfItemId set to it, or that its maintenance uses), with stock and where to buy them; and parts its manuals list that it doesn't have yet", returns: "{ parts: ItemPart[], suggested: SuggestedPart[] }" },
  { method: "post", path: "/items/{id}/parts/dismiss", tag: "Items", summary: "Dismiss a part a manual suggested", body: dismissPartInput, writes: true, returns: "204" },
  { method: "get", path: "/items/{id}/find", tag: "Items", summary: "Search inside one item: passages of its documents (by section), its photos' text, warranties and notes that have the words, best first", query: itemFindQuery, returns: "ItemFindResult" },
  { method: "post", path: "/items/{id}/ask", tag: "Items", summary: "Ask about one item", description: "Answered only from that item: its details, warranties and the passages of its documents, with citations. Counts as an AI action, like Ask.", body: askInput, returns: "AskAnswer" },
  { method: "post", path: "/items/{id}/seen", tag: "Items", summary: "\"Still here\": seen now (a box with everything in it); found again if it was missing", writes: true, returns: "{ confirmed }" },
  { method: "post", path: "/items/{id}/missing", status: 204, tag: "Items", summary: "\"Can't find it\": missing (listed with ?misplaced=only) until it's seen again or given up as lost", writes: true },
  { method: "get", path: "/items/{id}/repairs", tag: "Repairs", summary: "An item's repairs, newest first: what went wrong, what was done, who, parts, cost, its photos and warranty", returns: "{ data: Repair[] }" },
  { method: "post", path: "/items/{id}/repairs", status: 201, tag: "Repairs", summary: "Log a repair (warrantyEndsOn adds a warranty on the repair to the item). Photos: upload to the item with repairId", body: repairInput, writes: true, returns: "Repair" },
  { method: "patch", path: "/repairs/{id}", tag: "Repairs", summary: "Change a repair", body: repairPatch, writes: true, returns: "Repair" },
  { method: "delete", path: "/repairs/{id}", tag: "Repairs", summary: "Remove a repair (its photos and warranty stay the item's)", writes: true },
  { method: "get", path: "/items/{id}/cost", tag: "Items", summary: "What owning it has cost: paid + maintenance + repairs, less what it sold for — in total and per year owned", returns: "OwnershipCost" },
  { method: "get", path: "/replacements", tag: "Items", summary: "The replacement forecast: things with a lifespan (their own, their category's or the typical one for their kind) by the year they're likely due — past their typical life, then this year and the next (?years=, default 10). Estimates, not advice", returns: "ReplacementForecast" },
  { method: "get", path: "/room-reviews", tag: "Room reviews", summary: "Places with things in them, the next to review first: reviews under way, never reviewed, then longest ago", returns: "{ data: RoomToReview[] }" },
  { method: "get", path: "/room-reviews/{locationId}", tag: "Room reviews", summary: "A place's review: what's still to check, what's been checked, places inside", returns: "RoomReview" },
  { method: "post", path: "/room-reviews/{locationId}", tag: "Room reviews", summary: "Start a review of a place (or carry on the one under way)", writes: true, returns: "RoomReview" },
  { method: "post", path: "/room-reviews/{locationId}/items/{itemId}", tag: "Room reviews", summary: "What the review found: here (seen), moved (locationId: where to), gone (after setting its disposition), missing", body: reviewItemBody, writes: true, returns: "RoomReview" },
  { method: "post", path: "/room-reviews/{locationId}/finish", tag: "Room reviews", summary: "Finish the review: the place's \"last reviewed\", and a line in recent changes", writes: true, returns: "RoomReview" },
  { method: "post", path: "/items/{id}/videos", status: 201, tag: "Items", summary: "Add a how-to video to a thing from a YouTube link (the same video twice is the one already there); GET /items/{id} lists them as `videos`", body: taskVideoInput, writes: true, returns: "TaskVideo" },
  { method: "delete", path: "/items/{id}/videos/{videoId}", tag: "Items", summary: "Remove a how-to video from a thing (`videoId` is the video's own id)", writes: true, returns: "{ ok: true }" },
  { method: "get", path: "/items/{id}/history", tag: "Items", summary: "What happened to an item, newest first: added, edits (what changed), moves, photos, warranties, maintenance, stock (?limit=, ?offset=)", returns: "{ data: ItemHistoryEntry[], more }" },
  { method: "get", path: "/items/{id}/usage", tag: "Maintenance", summary: "Maintenance by use: what the item counts (miles, hours…), its readings (newest first), the latest, and how fast it goes up per day", returns: "UsageSummary" },
  { method: "post", path: "/items/{id}/usage", tag: "Maintenance", summary: "Log a reading (odometer, hour meter): its maintenance by use is rescheduled from it", body: usageReadingInput, writes: true, returns: "UsageReading" },
  { method: "delete", path: "/usage/{id}", tag: "Maintenance", summary: "Remove a reading (a typo)", writes: true },
  { method: "post", path: "/items/bulk", tag: "Items", summary: "One change to up to 200 things: move (locationId), category (categoryId), tag, untag (tag), delete, or analyze (queue the AI for their unread photos and documents)", body: itemsBulk, writes: true, returns: "ItemsBulkResult" },
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
  { method: "get", path: "/summary", tag: "Items", summary: "A household at a glance, for home dashboards (Heimdall, Homepage…): things, their value, what needs attention, what to buy — counts only", returns: "HouseholdSummary" },
  { method: "get", path: "/overview", tag: "Items", summary: "The dashboard: value, gaps, warranties, maintenance, recent changes", returns: "Overview" },

  {
    method: "get",
    path: "/barcodes/{code}",
    tag: "Items",
    query: z.object({ as: z.enum(["any", "music"]).optional() }),
    summary: "What a scanned barcode is",
    description:
      "From Ferret's own barcode book (learned from saved items, shared by the server), else the online product database when it's switched on. `?as=music` for a CD's or record's barcode: MusicBrainz is asked first (when the server admin switched music look-ups on). `match` is null when nobody knows it. `have` lists the household's things with this code already — offer to add to one (POST /scan with its itemId, mode restock) before adding another.",
    returns: "{ match: BarcodeMatch | null, online, have: ScanCandidate[] }",
  },
  { method: "get", path: "/exchange-rates", tag: "Items", summary: "The day's exchange rates (the European Central Bank's), to show prices in other currencies in yours; rates is null when the server doesn't fetch them", returns: "{ rates: ExchangeRates | null }" },
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
      "multipart/form-data with `file` and `kind` (photo | document). The type is sniffed, not trusted. Analysis runs in the background (`analyze=false`: don't — nothing to read in it). `main=true`: a photo becomes the item's main photo. `repairId`: a photo or invoice of one of its repairs (not analysed). Optionally `thumbnail` (≤ 600 px, ≤ 400 KB) and `preview` (≤ 1600 px, ≤ 2 MB, what the vision model looks at) — WebP, JPEG or PNG made by the client; otherwise the server makes them.",
    upload: true,
    writes: true,
    returns: "Attachment",
  },
  {
    method: "get",
    path: "/attachments/search",
    tag: "Photos & documents",
    summary: "Find properties', places' and maintenance tasks' files by words",
    description: "Their names, and what was read in them (a photo's description, a document's text). Each with `of`: what it belongs to. A thing's files are found with the thing (GET /items?q=).",
    query: z.object({ q: z.string() }),
    returns: "{ data: FileHit[] }",
  },
  {
    method: "get",
    path: "/attachments",
    tag: "Photos & documents",
    summary: "A property's, a place's, a maintenance task's or a done record's photos and documents",
    description: "Give one of `propertyId`, `locationId`, `taskId` (its own files and its done records') or `doneId`. A thing's files: GET /items/{id}/attachments.",
    query: z.object({ propertyId: z.string().optional(), locationId: z.string().optional(), taskId: z.string().optional(), doneId: z.string().optional() }),
    returns: "{ data: Attachment[] }",
  },
  {
    method: "post",
    path: "/attachments",
    status: 201,
    tag: "Photos & documents",
    summary: "Add a photo or document to a property, a place, a maintenance task or a done record",
    description:
      "multipart/form-data with `file`, `kind` (photo | document) and one of `propertyId`, `locationId`, `taskId` or `doneId`. A deed or an insurance policy on a property, an inspection report on a room, the plumber's invoice on a done record. A thing's task or done record keeps the file with the thing. Not read by the AI. Optionally `thumbnail` (≤ 600 px, ≤ 400 KB, WebP/JPEG/PNG).",
    upload: true,
    form: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", format: "binary" },
        kind: { type: "string", enum: ["photo", "document"] },
        propertyId: { type: "string" },
        locationId: { type: "string" },
        taskId: { type: "string" },
        doneId: { type: "string" },
        thumbnail: { type: "string", format: "binary" },
      },
    },
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
  { method: "get", path: "/maintenance/suggestions", tag: "Maintenance", summary: "Suggested maintenance: schedules read from manuals and typical upkeep, waiting to be added (POST /maintenance with suggestionId) or dismissed (?itemId= for one item's)", query: z.object({ itemId: z.string().optional() }), returns: "{ data: SuggestedTask[] }" },
  { method: "post", path: "/maintenance/typical", status: 202, tag: "Maintenance", summary: "Ask the AI for typical upkeep: for one thing ({ itemId }), or the household's things not asked about yet — into Suggested maintenance", body: z.object({ itemId: z.string().optional() }), writes: true, returns: "{ queued }" },
  { method: "post", path: "/maintenance/suggestions/{id}/dismiss", tag: "Maintenance", summary: "Not needed: the suggestion is remembered and not offered again", writes: true },
  { method: "post", path: "/maintenance", status: 201, tag: "Maintenance", summary: "Add a task", body: maintenanceInput, writes: true, returns: "MaintenanceTask" },
  { method: "get", path: "/maintenance/{id}", tag: "Maintenance", summary: "One task", returns: "MaintenanceTask" },
  { method: "patch", path: "/maintenance/{id}", tag: "Maintenance", summary: "Change a task", body: maintenancePatch, writes: true, returns: "MaintenanceTask" },
  { method: "delete", path: "/maintenance/{id}", tag: "Maintenance", summary: "Stop tracking a task", writes: true },
  {
    method: "post",
    path: "/maintenance/{id}/done",
    tag: "Maintenance",
    summary: "Mark a task done",
    description: "Logs it (who, cost, provider) and moves the next due date on from the day it was done. `doneId` is the record just made: its invoice or photos go to POST /attachments with `doneId`.",
    body: maintenanceDone,
    writes: true,
    returns: "MaintenanceTask & { doneId }",
  },
  { method: "get", path: "/maintenance/{id}/history", tag: "Maintenance", summary: "When a task was done", returns: "{ data: MaintenanceLogEntry[] }" },
  { method: "post", path: "/maintenance/{id}/videos", status: 201, tag: "Maintenance", summary: "Add a how-to video to a task from a YouTube link (the same video twice is the one already there)", body: taskVideoInput, writes: true, returns: "TaskVideo" },
  { method: "delete", path: "/maintenance/{id}/videos/{videoId}", tag: "Maintenance", summary: "Remove a how-to video from a task (`videoId` is the TaskVideo's id)", writes: true, returns: "{ ok: true }" },
  {
    method: "get",
    path: "/maintenance/videos/search",
    tag: "Maintenance",
    summary: "Search YouTube for how-to videos",
    description: "Only on a server with a YouTube key (`YOUTUBE_API_KEY`): `available: false` without one. The same words within a week are answered from the last search. Writers only.",
    query: z.object({ q: z.string().max(200) }),
    writes: true,
    returns: "{ available, results: VideoHit[] }",
  },
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
  { method: "post", path: "/import/known", tag: "Import", summary: "Which of a file's lines (importKey, up to 5,000) are already in Ferret — gone and recently deleted things count, unless their import was undone", body: importKnownInput, returns: "{ known: string[] }" },
  { method: "post", path: "/import/{id}/undo", tag: "Import", summary: "Undo an import: everything it added that's still here goes to Recently deleted", writes: true, returns: "{ removed }" },
  { method: "post", path: "/import/home-assistant/devices", tag: "Import", summary: "Read Home Assistant's floors, areas and devices, duplicates folded (owners/admins, a real sign-in; the token isn't kept)", body: homeAssistantConnect, returns: "HaRegistryView" },
  { method: "post", path: "/import/home-assistant/apply", tag: "Import", summary: "Take what Home Assistant changed since an import (names, makers, rooms) and remember what it says now", body: homeAssistantApply, writes: true, returns: "{ updated }" },
  { method: "get", path: "/ai-fills", tag: "AI", summary: "Filled in by AI: fields the AI filled in by itself (where the household lets it) that nobody has confirmed yet", returns: "{ data: AiFillEntry[] }" },
  { method: "post", path: "/items/{id}/ai-fills/{field}/confirm", tag: "AI", summary: "It's right: the field's AI mark goes, the value stays", writes: true, returns: "Item" },
  { method: "post", path: "/items/{id}/ai-fills/{field}/undo", tag: "AI", summary: "Undo what the AI filled in: the field is emptied again (a warranty it added is removed)", writes: true, returns: "Item" },
  { method: "post", path: "/import/triage", status: 202, tag: "Import", summary: "Sort an import's lines with AI before importing: starts a run (poll GET /ai-runs/{id}) that says which lines look worth keeping and picks a category from the household's own", body: importTriageInput, writes: true, returns: "{ id }" },
  { method: "get", path: "/ai-runs/{id}", tag: "AI", summary: "AI work you started (sorting an import): pending with how far it got, then its result", returns: "AiRunStatus" },
  { method: "post", path: "/items/{id}/listing", tag: "AI", summary: "Draft listing text for selling it — a title, a description and a suggested asking price — to copy into any marketplace (nothing is saved or posted)", writes: true, returns: "{ title, description, priceCents, priceReasoning }" },
  { method: "post", path: "/items/{id}/replacement-estimate", status: 202, tag: "AI", summary: "Ask the AI to estimate what replacing it would cost today: it appears as replacementEstimate on the item (a suggestion — set replacementCents to use it)", writes: true },
  { method: "post", path: "/items/filters-from-text", tag: "AI", summary: "Plain words → the item list's filters (\"tools bought last year over $100\"): category, place, tag, missing, origin, worth and bought-between, last scanned — from the household's own categories, places and tags", body: filtersFromTextInput, returns: "FiltersFromText" },
  { method: "post", path: "/items/from-text", tag: "AI", summary: "One sentence about a thing (\"DeWalt drill, garage top shelf, $129 last March\") → its fields, for a person to check before adding: name, brand, model, place, box, category, tags, value, bought on and for — places, boxes, categories and tags from the household's own. Nothing is saved", body: itemFromTextInput, returns: "ItemDraft" },
  { method: "post", path: "/replacement-estimates", status: 202, tag: "AI", summary: "Ask for replacement-cost estimates for up to 50 things at once: { itemIds } or { missing: \"value\" } (things with no value, price paid or replacement cost). Each appears as replacementEstimate on its thing", body: replacementEstimatesInput, writes: true, returns: "{ queued, skipped }" },
  { method: "delete", path: "/items/{id}/replacement-estimate", tag: "AI", summary: "Not this estimate: it's cleared (ask again any time)", writes: true },
  { method: "get", path: "/to-confirm", tag: "AI", summary: "Everything the AI suggested that's waiting for a person: things whose photos and receipts have suggestions (with their files), replacement-cost estimates not used yet, and counts of the other lists", returns: "ToConfirm" },
  { method: "post", path: "/attachments/{id}/lines", status: 201, tag: "AI", summary: "Add the other things on a receipt (its analysis's suggestions.lines, as a person ticked and corrected them): each a thing of its own, bought the same day, with a copy of the receipt", body: receiptLinesInput, writes: true, returns: "{ items: { id, name }[] }" },
  { method: "delete", path: "/attachments/{id}/lines", tag: "AI", summary: "Not these: a receipt's other things aren't offered again", writes: true },
  { method: "post", path: "/transcribe", tag: "AI", summary: "Speech to text: a short recording (multipart `audio`, ≤ 4 MB) → { text } — for naming things aloud. Needs SPEECH_URL", upload: true, form: { type: "object", required: ["audio"], properties: { audio: { type: "string", format: "binary" } } }, writes: true, returns: "{ text }" },
  { method: "get", path: "/duplicates", tag: "AI", summary: "Possible duplicates: pairs with the same serial number, the same barcode and name, or that read nearly the same", returns: "{ data: DuplicatePair[] }" },
  { method: "post", path: "/duplicates/not", tag: "AI", summary: "Not a duplicate: the pair { a, b } isn't offered again", body: z.object({ a: z.string(), b: z.string() }), writes: true },
  { method: "post", path: "/items/{id}/merge", tag: "AI", summary: "Merge another item into this one: its details fill the gaps (or replace, per `take`), everything pointing at it moves here, and it goes to Recently deleted", body: mergeInput, writes: true, returns: "Item" },
  { method: "get", path: "/household/settings", tag: "Household", summary: "The household's settings: its time zone (null: not chosen — the server's own zone is used) and its currency (ISO 4217; USD until chosen)", returns: "HouseholdSettings" },
  { method: "put", path: "/household/settings", tag: "Household", summary: "Set the household's time zone and/or currency (owners/admins; only what's sent changes): what \"today\" is, the hour reminders go out, and how amounts are written", body: householdSettingsInput, writes: true, returns: "HouseholdSettings" },
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

  // ── Trading cards ──────────────────────────────────────────────────────────
  { method: "get", path: "/cards/search", tag: "Trading cards", summary: "Cards in a game's catalog (Pokémon: TCGdex; Magic: Scryfall) matching a name, and a number if typed (\"Pikachu 025/165\", \"Lightning Bolt M10 146\")", query: z.object({ game: z.enum(cardGames), q: z.string() }), returns: "{ data: CardInfo[] }" },
  {
    method: "post",
    path: "/cards/read",
    status: 202,
    tag: "Trading cards",
    summary: "Read a photo of a card: the vision model reads its name, number and set, then the catalog's matching cards",
    description: "multipart/form-data: `photo`, and optionally `game` (pokemon or magic). One AI action (402 when the plan has none left; 501 without the vision model; 409 when card look-ups are off). Answers at once with an `id`: GET /cards/read/{id} until `status` is done.",
    upload: true,
    form: { type: "object", required: ["photo"], properties: { photo: { type: "string", format: "binary" }, game: { type: "string", enum: [...cardGames] } } },
    writes: true,
    returns: "{ id }",
  },
  { method: "get", path: "/cards/read/{id}", tag: "Trading cards", summary: "A card photo being read: what was read, and the matching cards", returns: "CardReadStatus" },
  { method: "get", path: "/cards/values", tag: "Trading cards", summary: "Your cards (or one collection's) beside today's price, for Update values; `checking`: prices still being fetched — ask again", query: z.object({ collectionId: z.string().optional() }), returns: "{ data: CardValue[], checking }" },
  { method: "get", path: "/items/{id}/card", tag: "Trading cards", summary: "A card thing's card, with today's prices", returns: "{ card, info: CardInfo | null, price: CardPrice | null }" },
  { method: "post", path: "/items/{id}/card/photo", tag: "Trading cards", summary: "Keep the card's own picture as the thing's photo", writes: true, status: 201, returns: "Attachment" },

  // ── Device support (endoflife.date) ────────────────────────────────────────
  { method: "get", path: "/items/{id}/support", tag: "Items", summary: "A device's software support: tracked (when security updates stop), a model to confirm, or none; off when the server doesn't look", returns: "ItemSupportStatus" },
  { method: "put", path: "/items/{id}/support", tag: "Items", summary: "Track a model's end of support on the thing (the suggestion's product and release)", body: z.object({ product: z.string(), release: z.string() }), writes: true, returns: "ItemSupportStatus" },
  { method: "delete", path: "/items/{id}/support", tag: "Items", summary: "Stop tracking, or say a suggested model isn't it (it isn't offered again)", writes: true, returns: "ItemSupportStatus" },

  { method: "get", path: "/items/{id}/energy", tag: "Items", summary: "A thing's ENERGY STAR entry by its brand and model (or barcode): certified energy use a year and how it compares with the US standard; `pending` while it's looked up — ask again", returns: "ItemEnergy" },

  // ── Collector catalogs ─────────────────────────────────────────────────────
  { method: "get", path: "/collectibles/search", tag: "Collector catalogs", summary: "LEGO sets (Rebrickable: a set number or name), coins (Numista: words, and an issuer code and year) comics (Comic Vine: series and issue number, \"Amazing Spider-Man 300\") films and shows (TMDB: a title, and a year) video games (IGDB: a title) or records (Discogs: a barcode, or artist and title) matching; 409 when that catalog has no key on this server", query: collectibleSearch, returns: "{ data: CollectibleInfo[] }" },
  { method: "get", path: "/collectibles/issuers", tag: "Collector catalogs", summary: "Coin issuers (countries…) whose name has these words, for a coin search's `issuer`", query: z.object({ q: z.string() }), returns: "{ data: CoinIssuer[] }" },
  {
    method: "post",
    path: "/collectibles/read",
    status: 202,
    tag: "Collector catalogs",
    summary: "Read a photo of a LEGO box, a coin, a comic's cover, a film's or game's case, or a record's sleeve: the vision model reads it, then the catalog's matches",
    description: "multipart/form-data: `photo` and `kind` (lego, coin, comic, video, game or record). One AI action (402 when the plan has none left; 501 without the vision model; 409 when that catalog has no key). Answers at once with an `id`: GET /collectibles/read/{id} until `status` is done.",
    upload: true,
    form: { type: "object", required: ["photo", "kind"], properties: { photo: { type: "string", format: "binary" }, kind: { type: "string", enum: [...collectibleKinds] } } },
    writes: true,
    returns: "{ id }",
  },
  { method: "get", path: "/collectibles/read/{id}", tag: "Collector catalogs", summary: "A photo being read: what was read, and the matches", returns: "CollectibleReadStatus" },
  { method: "get", path: "/collectibles/values", tag: "Collector catalogs", summary: "Your coins with an issue and grade, and your records (or one collection's), beside today's price, for Update values; `checking`: prices still being fetched — ask again", query: z.object({ collectionId: z.string().optional() }), returns: "{ data: CollectibleValue[], checking }" },
  { method: "get", path: "/collectibles/{kind}/{id}", tag: "Collector catalogs", summary: "One LEGO set, coin (with its issues: years and mints), comic, film or show (with its seasons), video game (with its platforms) or record from its catalog", returns: "CollectibleInfo" },
  { method: "get", path: "/collectibles/{kind}/{id}/prices", tag: "Collector catalogs", summary: "Prices in your household's currency: a coin issue's by grade (Numista; `issue` needed), a record's by condition and the lowest for sale now (Discogs)", query: z.object({ issue: z.string().optional() }), returns: "{ data: CollectiblePrice[] }" },
  { method: "get", path: "/items/{id}/collectible", tag: "Collector catalogs", summary: "A set, coin or comic thing's catalog entry; a coin's prices and the one for its grade", returns: "{ collectible, info: CollectibleInfo | null, prices: CollectiblePrice[], price: CollectiblePrice | null }" },
  { method: "post", path: "/items/{id}/collectible/photo", tag: "Collector catalogs", summary: "Keep the catalog's picture as the thing's photo", writes: true, status: 201, returns: "Attachment" },

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
  { method: "get", path: "/webhooks", tag: "Webhooks", summary: "The household's webhooks (owners/admins, a real sign-in), the events they can hear about, and whether this server sends them", auth: "session", returns: "{ enabled, local, events, data: WebhookSummary[] }" },
  { method: "post", path: "/webhooks", status: 201, tag: "Webhooks", summary: "Add a webhook: an address and the events to POST there, signed with the secret returned (once here; Show secret later)", auth: "session", body: webhookInput, writes: true, returns: "WebhookSummary & { secret }" },
  { method: "patch", path: "/webhooks/{id}", tag: "Webhooks", summary: "Rename it, change its address or events, pause it — or turn it on again (also after Ferret switched it off for failing)", auth: "session", body: webhookPatch, writes: true, returns: "WebhookSummary" },
  { method: "delete", path: "/webhooks/{id}", tag: "Webhooks", summary: "Remove a webhook and its delivery log", auth: "session", writes: true },
  { method: "post", path: "/webhooks/{id}/test", tag: "Webhooks", summary: "Send a ping event now and say how the receiver answered", auth: "session", writes: true, returns: "{ delivered, status, error }" },
  { method: "post", path: "/webhooks/{id}/secret", tag: "Webhooks", summary: "Show the webhook's signing secret", auth: "session", returns: "{ secret }" },
  { method: "post", path: "/webhooks/{id}/rotate", tag: "Webhooks", summary: "A new signing secret; the old one also signs for a day", auth: "session", writes: true, returns: "{ secret }" },
  { method: "get", path: "/webhooks/{id}/deliveries", tag: "Webhooks", summary: "The last 50 deliveries: event, status, tries, the receiver's answer (kept 30 days)", auth: "session", returns: "{ data: WebhookDelivery[] }" },
  { method: "post", path: "/webhooks/{id}/deliveries/{deliveryId}/retry", tag: "Webhooks", summary: "Send a delivery again (the same event id)", auth: "session", writes: true, returns: "WebhookDelivery" },
  { method: "get", path: "/paperless", tag: "Paperless", summary: "Whether this server can connect to Paperless-ngx, and the household's connection (address, tag, last sync — never the token)", returns: "{ available, local, connection: PaperlessConnection | null }" },
  { method: "put", path: "/paperless", tag: "Paperless", summary: "Connect (or change) the household's Paperless-ngx: its address, an API token, the tag to watch, copy files or link only (owners/admins, a real sign-in); checked with Paperless first", auth: "session", body: paperlessInput, writes: true, returns: "PaperlessConnection" },
  { method: "delete", path: "/paperless", tag: "Paperless", summary: "Disconnect Paperless: the token and the inbox are dropped; copied files stay on their things", auth: "session", writes: true },
  { method: "post", path: "/paperless/sync", tag: "Paperless", summary: "Look for new documents with the tag now (it's also done every 10 minutes)", writes: true, returns: "{ added, connection }" },
  { method: "get", path: "/paperless/documents", tag: "Paperless", summary: "The Paperless inbox: documents with the tag not sorted yet, each with a thing it may belong to — or `status=done` for those sorted (newest 100)", query: z.object({ status: z.enum(["new", "done"]).optional() }), returns: "{ connected, data: PaperlessDocument[] }" },
  { method: "get", path: "/paperless/search", tag: "Paperless", summary: "Search Paperless's documents (whatever their tags), to attach one to a thing", query: z.object({ q: z.string() }), returns: "{ data: PaperlessDocument[] }" },
  { method: "get", path: "/paperless/documents/{id}/thumbnail", tag: "Paperless", summary: "Paperless's small picture of a document (its number in Paperless)", returns: "image" },
  { method: "post", path: "/paperless/documents/{id}/add", status: 201, tag: "Paperless", summary: "Make a new thing from a document (named after it unless a name is given), with its file copied in (or linked) and a link back to Paperless", body: paperlessAddInput, writes: true, returns: "{ item, copied, note }" },
  { method: "post", path: "/paperless/documents/{id}/attach", tag: "Paperless", summary: "Put a document (from the inbox or a search) on a thing: its file copied in (or linked) and a link back to Paperless", body: paperlessAttachInput, writes: true, returns: "{ item, copied, note }" },
  { method: "post", path: "/paperless/documents/{id}/dismiss", tag: "Paperless", summary: "Take a document out of the inbox without doing anything with it", writes: true },
  { method: "post", path: "/paperless/documents/{id}/restore", tag: "Paperless", summary: "Put a dismissed document back in the inbox", writes: true },
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
  { method: "put", path: "/me/language", tag: "Account", summary: "The language Ferret writes to you in — emails, push, notifications (a real sign-in; null: English)", body: languageInput, returns: "{ language }" },
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
  { method: "post", path: "/server/check", tag: "Server", summary: "Check the live server: missing or unreadable files, rows pointing at deleted things, unfinished work, stale backups (server admin; read-only)", returns: "ServerCheckResult" },
  { method: "get", path: "/server/barcode-lookups", tag: "Server", summary: "Online barcode lookups: on or off, and what's left of the database's daily allowance as of the last lookup (server admin)", returns: "BarcodeLookupStatus" },
  { method: "get", path: "/server/ai-fill", tag: "Server", summary: "Let AI fill in: which kinds are on by default for this server's households (server admin)", returns: "Record<AiFillKind, boolean>" },
  { method: "put", path: "/server/ai-fill", tag: "Server", summary: "Turn kinds of AI filling-in on or off by default for households that haven't chosen (server admin)", writes: true, returns: "Record<AiFillKind, boolean>" },
  { method: "get", path: "/server/books", tag: "Server", summary: "Book look-ups (Open Library, by ISBN): on or off, books kept (server admin)", returns: "BookLookupStatus" },
  { method: "get", path: "/server/exchange-rates", tag: "Server", summary: "Exchange rates (Frankfurter: the European Central Bank's): on or off, and the day they're from (server admin)", returns: "ExchangeRateStatus" },
  { method: "put", path: "/server/exchange-rates", tag: "Server", summary: "Switch exchange rates on (fetched daily; nothing about anyone is sent) or off: { enabled } (server admin)", writes: true, returns: "ExchangeRateStatus" },
  { method: "get", path: "/server/support", tag: "Server", summary: "Device support look-ups (endoflife.date): on or off, device models known, things tracked (server admin)", returns: "SupportLookupStatus" },
  { method: "put", path: "/server/support", tag: "Server", summary: "Switch device support look-ups on (endoflife.date's device lists are downloaded daily; nothing about households is sent) or off: { enabled } (server admin)", writes: true, returns: "SupportLookupStatus" },
  { method: "get", path: "/server/open-facts", tag: "Server", summary: "Open Food Facts look-ups (groceries, household goods, toiletries): on or off, products kept (server admin)", returns: "OpenFactsStatus" },
  { method: "put", path: "/server/open-facts", tag: "Server", summary: "Switch Open Food Facts look-ups on (a barcode the product database doesn't know is sent to the Open Food Facts databases) or off: { enabled } (server admin)", writes: true, returns: "OpenFactsStatus" },
  { method: "get", path: "/server/cards", tag: "Server", summary: "Trading card look-ups (TCGdex, Scryfall): on or off, cards kept (server admin)", returns: "CardLookupStatus" },
  { method: "put", path: "/server/cards", tag: "Server", summary: "Switch trading card look-ups on (card names and numbers are sent to TCGdex and Scryfall) or off: { enabled } (server admin)", writes: true, returns: "CardLookupStatus" },
  { method: "get", path: "/server/energy-star", tag: "Server", summary: "ENERGY STAR look-ups: on or off, brands and models kept (server admin)", returns: "EnergyStarStatus" },
  { method: "put", path: "/server/energy-star", tag: "Server", summary: "Switch ENERGY STAR look-ups on (things' brands and models, or barcodes, are sent to data.energystar.gov) or off: { enabled } (server admin)", writes: true, returns: "EnergyStarStatus" },
  { method: "put", path: "/server/books/google", tag: "Server", summary: "Save the Google Books key (asked after Open Library for ISBNs), checked with Google first ({ key }), or remove it ({ key: null }) (server admin)", body: collectibleKeyInput, writes: true, returns: "BookLookupStatus" },
  { method: "get", path: "/server/collectibles", tag: "Server", summary: "Collector catalogs (Rebrickable, Numista, Comic Vine, TMDB, IGDB, Discogs): which have a key (its last four characters), and how much is kept (server admin)", returns: "{ data: CollectibleCatalogStatus[] }" },
  { method: "put", path: "/server/collectibles/{kind}", tag: "Server", summary: "Save a collector catalog's free key, checked with it first ({ key }), or remove it ({ key: null }) to switch the catalog off (server admin)", body: collectibleKeyInput, writes: true, returns: "{ data: CollectibleCatalogStatus[] }" },
  { method: "get", path: "/server/music", tag: "Server", summary: "Music look-ups (MusicBrainz, for Scan music): on or off, records kept (server admin)", returns: "MusicLookupStatus" },
  { method: "put", path: "/server/music", tag: "Server", summary: "Switch music look-ups on (a barcode scanned as music is sent to MusicBrainz) or off: { enabled } (server admin)", writes: true, returns: "MusicLookupStatus" },
  { method: "put", path: "/server/books", tag: "Server", summary: "Switch book look-ups on (a book's ISBN is sent to Open Library) or off: { enabled } (server admin)", writes: true, returns: "BookLookupStatus" },
  { method: "get", path: "/server/ask", tag: "Server", summary: "Ask Ferret: the answering model's context size and how much a question reads with it (server admin)", returns: "AskSettings" },
  { method: "put", path: "/server/ask", tag: "Server", summary: "Set the answering model's context size in tokens: { contextTokens } (null = the default) (server admin)", body: askSettingsInput, writes: true, returns: "AskSettings" },
  { method: "get", path: "/server/prompts", tag: "Server", summary: "AI prompts: each built-in prompt (with placeholders for a household's details) and the extra instructions added to it (server admin)", returns: "{ data: PromptSetting[] }" },
  { method: "put", path: "/server/prompts/{kind}", tag: "Server", summary: "Set the extra instructions added to the end of one built-in prompt (photo, document, describe, roomScan, ask): { extra } (null = none) (server admin)", body: promptExtraInput, writes: true, returns: "{ data: PromptSetting[] }" },
  { method: "get", path: "/server/repair-guides", tag: "Server", summary: "Repair guide links (iFixit): on or off, brands and models asked about and matched (server admin)", returns: "RepairGuideStatus" },
  { method: "put", path: "/server/repair-guides", tag: "Server", summary: "Switch repair guide links on (things' brands and models are sent to iFixit's search) or off: { enabled } (server admin)", writes: true, returns: "RepairGuideStatus" },
  { method: "get", path: "/server/search-index", tag: "Server", summary: "Search by meaning's index: the embedding model and vector store, things embedded, a re-index under way (server admin)", returns: "SearchIndexStatus" },
  { method: "post", path: "/server/search-index/rebuild", tag: "Server", summary: "Re-index everything: clear the vector store and embed every thing again (server admin)", writes: true, returns: "SearchIndexStatus" },
  { method: "get", path: "/server/vehicles", tag: "Server", summary: "Vehicle look-ups (NHTSA): on or off, vehicles decoded, vehicle recalls kept (server admin)", returns: "VehicleLookupStatus" },
  { method: "put", path: "/server/vehicles", tag: "Server", summary: "Switch vehicle look-ups on (VINs are sent to NHTSA to decode, and makes/models/years for recalls) or off: { enabled } (server admin)", writes: true, returns: "VehicleLookupStatus" },
  { method: "get", path: "/server/recalls", tag: "Server", summary: "Recall checks: on or off, brands asked about, recalls kept (server admin)", returns: "RecallStatus" },
  { method: "put", path: "/server/recalls", tag: "Server", summary: "Switch recall checks on (each household's brands are sent to the CPSC) or off: { enabled } (server admin)", writes: true, returns: "RecallStatus" },
  { method: "get", path: "/server/address", tag: "Server", summary: "PUBLIC_URL, and whether it was set (server admin)", returns: "ServerAddress" },
  { method: "get", path: "/server/secrets", tag: "Server", summary: "Where each secret Ferret needs came from — its settings, or made by Ferret — and the push public key; never a secret (server admin)", returns: "ServerSecrets" },
  { method: "get", path: "/server/certificates", tag: "Server", summary: "Certificates for the server's own connections: those trusted, and client certificates with their hosts — never their keys (server admin)", returns: "ServerCertificates" },
  { method: "post", path: "/server/certificates/trusted", status: 201, tag: "Server", summary: "Trust a certificate authority's (or a self-signed service's) certificate: { name, pem } (server admin)", writes: true, returns: "ServerCertificates" },
  { method: "post", path: "/server/certificates/client", status: 201, tag: "Server", summary: "Add a client certificate for mutual TLS, shown only to its hosts: { name, hosts, pkcs12 (base64), password } (server admin)", writes: true, returns: "ServerCertificates" },
  { method: "delete", path: "/server/certificates/{id}", tag: "Server", summary: "Remove a certificate (server admin)", writes: true, returns: "ServerCertificates" },
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
  { method: "get", path: "/export/donations.json", tag: "Export", summary: "Donations: the years anything was donated in (with counts and totals), and one year's donations", description: "`year=2026`: that year's donations, with who they went to, when and what they were worth when given. Ferret records what was given; it says nothing about what's deductible.", query: z.object({ year: z.string().optional() }), returns: "{ years: DonationYear[], data: DonationRow[] }" },
  { method: "get", path: "/export/donations.csv", tag: "Export", summary: "One year's donations as a spreadsheet (this year without `year`)", query: z.object({ year: z.string().optional() }), produces: "text/csv" },
  { method: "get", path: "/export/heirs.json", tag: "Export", summary: "The personal property list: things grouped by who should have them one day (heir), with what identifies each (owners and admins)", returns: "{ data: HeirGroup[] }" },
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
        "Ferret's REST API: the same household inventory the app and Claude (MCP, at /mcp) use. Every call acts in one household. Make an API key in Settings → Claude & API and send it as `Authorization: Bearer ferret_…` (or `x-api-key`).",
    },
    servers: [{ url: `${publicUrl}/api/v1` }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "An API key from Settings → Claude & API (ferret_…)" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key" },
        session: { type: "apiKey", in: "cookie", name: "better-auth.session_token", description: "The app's sign-in" },
      },
    },
    tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
  };
}
