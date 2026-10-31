/**
 * The MCP server: "talk to my house". Claude connects to /mcp with an API key
 * (Settings → API keys) and works with that key's household through these
 * tools. Each tool calls the same service (lib/inventory.ts) as the REST API.
 *
 * Stateless: a fresh McpServer per request, built for the caller (a read-only
 * key gets only the read tools). Serves both the 2026-07-28 protocol and the
 * older 2025 one, so any current Claude client can connect.
 */
import {
  describeInterval,
  describeUsage,
  itemInput,
  itemPatch,
  itemOrigins,
  loanInput,
  locationInput,
  claimInput,
  claimPatch,
  maintenanceDone,
  maintenanceInput,
  usageReadingInput,
  propertyInput,
  providerInput,
  TRASH_DAYS,
} from "@ferret/shared";
import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import * as z from "zod/v4";
import { attachment, warranty } from "../db/schema";
import * as svc from "../lib/inventory";
import type { CategoryNode } from "@ferret/shared";
import type { Caller } from "../lib/inventory";
import { needsAttention } from "../lib/attention";
import { listDeleted, restoreItem } from "../lib/trash";
import { addAttachment } from "../lib/attachments";
import * as catalog from "../lib/catalog";
import * as templates from "../lib/templates";
import * as collections from "../lib/collections";
import * as claims from "../lib/claims";
import type { FileStore } from "../lib/files";
import * as upkeep from "../lib/maintenance";
import * as products from "../lib/products";
import * as providers from "../lib/providers";
import * as stock from "../lib/stock";
import * as usage from "../lib/usage";
import { itemHistory } from "../lib/history";
import * as loans from "../lib/loans";
import * as roomScans from "../lib/room-scans";
import { coverageChecks } from "../lib/coverage";

/** What the /mcp route hands each request's server (via AuthInfo.extra). */
export interface McpCaller extends Caller {
  readOnly: boolean;
  /** For photo tools: encrypted file storage, and the largest upload allowed. */
  files: FileStore;
  maxUploadBytes: number;
  /** The public demo: no room scans. */
  demo?: boolean;
}

export const mcpHandler = createMcpHandler(({ authInfo }) => buildServer(callerFrom(authInfo)));

/** The verified caller for this request — the route puts it there after checking the API key. */
export function mcpAuthInfo(caller: McpCaller, keyId: string): AuthInfo {
  return { token: "", clientId: keyId, scopes: caller.readOnly ? ["read"] : ["read", "write"], extra: { caller } };
}

function callerFrom(authInfo: AuthInfo | undefined): McpCaller {
  const caller = authInfo?.extra?.caller as McpCaller | undefined;
  if (!caller) throw new Error("MCP request without a verified caller");
  return caller;
}

const INSTRUCTIONS = `Ferret is this household's home inventory: what they own, where it is kept, receipts, manuals and warranties.
- To find things, use search_inventory (words and meaning). For questions answered from receipts/manuals, use ask_inventory.
- Places are properties (a home, a cabin) containing nested locations (rooms, closets, shelves). list_locations shows the tree with ids.
- Boxes, bins and cases are items with isContainer: true; other items go inside them (containerItemId) and are wherever the box is. list_items with containerItemId shows what's in a box. Boxes and shelves can carry QR labels with 6-character codes (e.g. K7QM2X); search_inventory finds a box by its code.
- Money is in integer cents (e.g. 12999 = $129.99). Dates are yyyy-mm-dd.
- Maintenance (filters, servicing, gutters…) is tracked as tasks that repeat; list_maintenance shows what's due. When someone says they did one, use complete_maintenance.
- Before creating an item, search first so you don't add a duplicate. Before deleting, confirm with the person.`;

function buildServer(v: McpCaller) {
  const server = new McpServer({ name: "ferret", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // ── Reading ───────────────────────────────────────────────────────────────
  server.registerTool(
    "search_inventory",
    {
      title: "Search the inventory",
      description:
        "Finds items by words (names, brands, serial numbers, text in documents) and by meaning (\"something to make holes\" finds a drill). Returns the best matches first, each with where it's kept.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: read,
    },
    async ({ query, limit }) =>
      run(async () => {
        const results = await svc.searchItems(v, query, {}, limit);
        const paths = await svc.locationPaths(v);
        return {
          items: results.data.map((it) => ({ ...itemView(it, paths), matched: compact(results.hits[it.id]) })),
        };
      }),
  );

  server.registerTool(
    "ask_inventory",
    {
      title: "Ask Ferret",
      description:
        "Answers a question from the household's own items and documents (receipts, manuals, warranty cards), with the items it used as sources. Good for \"when does the dishwasher warranty end?\" or \"what filter does the furnace take?\".",
      inputSchema: z.object({ question: z.string().trim().min(3).max(500) }),
      annotations: read,
    },
    async ({ question }) => run(() => svc.ask(v, question)),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get an item",
      description: "Everything about one item: its fields, where it's kept, warranties, and what its photos and documents show.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: read,
    },
    async ({ id }) =>
      run(async () => {
        const it = await svc.getItem(v, id);
        const [paths, warranties, files] = await Promise.all([
          svc.locationPaths(v),
          v.db
            .select()
            .from(warranty)
            .where(and(eq(warranty.itemId, id), eq(warranty.householdId, v.householdId), isNull(warranty.deletedAt))),
          v.db
            .select()
            .from(attachment)
            .where(and(eq(attachment.itemId, id), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt))),
        ]);
        const [listed] = await svc.asListing(v, [it]);
        const itemClaims = await claims.listClaims(v, { itemId: id });
        return {
          ...itemView(it, paths),
          box: listed?.container?.name,
          contents: listed?.contents || undefined,
          label: listed?.labelCode ?? undefined,
          warranties: warranties.map((w) =>
            compact({
              ...svc.withStatus({ ...w, householdId: undefined, itemId: undefined, deletedAt: undefined }),
              claims: itemClaims.filter((c) => c.warrantyId === w.id).map((c) => compact({ ...c, itemId: undefined, itemName: undefined, warrantyId: undefined })),
            }),
          ),
          attachments: files.map((f) =>
            compact({
              id: f.id,
              kind: f.kind,
              filename: f.filename,
              analysis: f.analysisStatus ?? undefined,
              // What the model read off it — for the person to confirm, never applied by itself.
              suggestions: f.analysis && !f.suggestionsDismissedAt ? compact(f.analysis.suggestions) : undefined,
              description: f.analysis?.description,
              text: f.analysis?.text ? clip(f.analysis.text, 1500) : undefined,
            }),
          ),
        };
      }),
  );

  server.registerTool(
    "list_items",
    {
      title: "List items",
      description:
        "Lists items, most recently changed first. With locationId, only what's in that location and everything nested inside it (\"what's in the garage?\"); with categoryId, that category and its subcategories; with tag, a tag's items (a tag is also a collection, e.g. \"Christmas decorations\"); with origin, how they were added (\"claude\": what you added, to check your own work); with collectionId (from list_collections), a collection's things — wanted: \"include\" adds its want list (things not owned yet), \"only\" just that.",
      inputSchema: z.object({
        locationId: z.string().min(1).optional(),
        containerItemId: z.string().min(1).optional().describe("Only what's directly inside this box"),
        categoryId: z.string().min(1).optional(),
        tag: z.string().trim().min(1).max(40).optional(),
        origin: z.enum(itemOrigins).optional().describe("Only things added this way: app, photos, walkthrough, roomscan, scan, label, spreadsheet, homeassistant, claude, api"),
        collectionId: z.string().min(1).optional(),
        wanted: z.enum(["include", "only"]).optional().describe("The want list (things not owned yet): left out unless asked for"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: read,
    },
    async ({ locationId, containerItemId, categoryId, tag, origin, collectionId, wanted, limit, offset }) =>
      run(async () => {
        const locationIds = locationId ? await svc.descendants(v, locationId) : undefined;
        const categoryIds = categoryId ? await catalog.categoryDescendants(v, categoryId) : undefined;
        const tagged = tag ? await catalog.findTag(v, tag) : undefined;
        if (tag && !tagged) return { total: 0, offset, items: [] };
        const page = await svc.listItems(v, { locationIds, containerItemId, categoryIds, tagId: tagged?.id, origin, collectionId, wanted }, { limit, offset });
        const paths = await svc.locationPaths(v);
        return { total: page.total, offset, items: page.data.map((it) => itemView(it, paths)) };
      }),
  );

  server.registerTool(
    "list_locations",
    {
      title: "List places",
      description:
        "Every property (home, cabin, storage unit…) with its locations as a tree (rooms › closets › shelves), their ids, and how many items each holds.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(() => svc.locationTree(v)),
  );

  server.registerTool(
    "what_needs_attention",
    {
      title: "What needs attention",
      description:
        "What to act on now: maintenance overdue or due within a week, warranties ending within 30 days, warranty claims with no news for two weeks, and items added from photos that still need a name. Urgent first.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ attention: (await needsAttention(v)).map((a) => compact(a)) })),
  );

  server.registerTool(
    "shopping_list",
    {
      title: "Shopping list",
      description:
        "What to buy: tracked consumables that have run out, or are at or below their minimum (minQuantity, \"keep at least\"), with how many are left and a suggested amount to buy. Run out first.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ toBuy: (await stock.shoppingList(v)).items.map(({ photoId: _photo, ...i }) => compact({ ...i, place: i.place ?? undefined, minQuantity: i.minQuantity ?? undefined, unitCents: i.unitCents ?? undefined })) })),
  );

  server.registerTool(
    "item_history",
    {
      title: "An item's history",
      description:
        "What happened to an item, newest first: when it was added, each edit (what changed — moved from where to where, value, name…), photos and documents added, warranties and claims, maintenance done, stock used or restocked. Good for \"when did we move the ladder?\" or \"when was the furnace last serviced?\". Use search_inventory first to get the item's id.",
      inputSchema: z.object({ itemId: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) }),
      annotations: read,
    },
    async ({ itemId, limit }) =>
      run(async () => {
        const h = await itemHistory(v, itemId, { limit, offset: 0 });
        return { history: h.data.map(({ at, summary, by, via }) => compact({ at, what: summary, by, via: via === "web" ? undefined : via })), more: h.more || undefined };
      }),
  );

  server.registerTool(
    "coverage_check",
    {
      title: "Insurance coverage",
      description:
        "The household's insurance limits (contents cover, and special limits on jewelry, firearms… by category or tag) next to what the inventory says those things are worth, with how much short each is. Money in cents.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () =>
      run(async () => ({
        limits: (await coverageChecks(v)).map((c) =>
          compact({ label: c.label, limitCents: c.limitCents, worthCents: c.valueCents, shortCents: c.shortCents || undefined, items: c.items, withoutValue: c.unvalued || undefined, covers: c.categoryName ?? (c.tag ? `tag ${c.tag}` : "everything"), property: c.propertyName }),
        ),
      })),
  );

  server.registerTool(
    "list_loans",
    {
      title: "Lent and borrowed",
      description:
        "Things lent out (who has them, since when, due back) and things borrowed from others, still out. Overdue ones are marked. Good for \"who has the ladder?\" or \"what have I lent out?\".",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () =>
      run(async () => ({
        loans: (await loans.listLoans(v)).map((l) =>
          compact({ item: l.itemName, itemId: l.itemId, loanId: l.id, direction: l.direction, person: l.person, since: l.since, dueOn: l.dueOn, overdue: l.overdue || undefined, note: l.note }),
        ),
      })),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories and tags",
      description:
        "The household's categories as a tree (ids, paths, any extra fields their items have — e.g. a TV's screen size — and item counts), its tags with how many items carry each, and its item templates (kinds of thing with their own fields: a coin's year, mint mark and grade). Use a category id with create_item/update_item (categoryId), tag names in `tags`, and a template's id as templateId — then put its fields' values in customFields by their keys.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () =>
      run(async () => ({
        categories: withoutPhotos(await catalog.categoryTree(v)),
        tags: await catalog.listTags(v),
        templates: (await templates.listTemplates(v)).map((t) => compact({ id: t.id, name: t.name, fields: t.fields, categoryId: t.categoryId, tags: t.tags.length ? t.tags : undefined })),
      })),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        "The household's collections (coins, dolls, cards…): each with how many things are owned (pieces counts duplicates), how many are on its want list, what the owned ones are worth and cost (cents), and its templateId (its fields: list_categories). Its things: list_items with collectionId.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ collections: (await collections.listCollections(v)).map(({ photoId: _photo, ...c }) => compact(c)) })),
  );

  server.registerTool(
    "list_warranties",
    {
      title: "List warranties",
      description:
        "Warranties on file, soonest to end first. status: active (still covered, including expiring), expiring (ends within 60 days), expired.",
      inputSchema: z.object({ status: z.enum(["active", "expiring", "expired"]).optional() }),
      annotations: read,
    },
    async ({ status }) =>
      run(async () => ({
        warranties: (await svc.listWarranties(v, status)).map((w) =>
          compact({ ...w, householdId: undefined, deletedAt: undefined }),
        ),
      })),
  );

  server.registerTool(
    "inventory_report",
    {
      title: "Inventory value report",
      description:
        "What everything is worth (for insurance): totals by property and by room, the most valuable items, and how many items have no value recorded. An item counts at its value, or else its purchase price, times its quantity. Amounts are in cents.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(() => svc.inventoryReport(v)),
  );

  server.registerTool(
    "list_maintenance",
    {
      title: "List maintenance",
      description:
        "Maintenance tasks (replace filters, service the boiler, clean gutters…), soonest due first, with the item and where it is. status: open (default: everything not finished), overdue, due (within 14 days), upcoming, done (finished one-offs), all. itemId narrows to one item.",
      inputSchema: z.object({
        status: z.enum(["open", "overdue", "due", "upcoming", "done", "all"]).default("open"),
        itemId: z.string().min(1).optional(),
      }),
      annotations: read,
    },
    async ({ status, itemId }) => run(async () => ({ tasks: (await upkeep.listMaintenance(v, { status, itemId })).map(taskView) })),
  );

  server.registerTool(
    "lookup_barcode",
    {
      title: "Look up a barcode",
      description:
        "What a UPC/EAN barcode is: from Ferret's own barcode book (learned from items saved on this server), else the online product database if it's switched on (match is null when nobody knows it). youHave lists the household's things with this barcode already: when adding something, offer to add to one of those (adjust_stock) rather than making a duplicate — unless the person wants it as a separate item.",
      inputSchema: z.object({ barcode: z.string().trim().min(8).max(20) }),
      annotations: { ...read, openWorldHint: true },
    },
    async ({ barcode }) =>
      run(async () => {
        const [match, have] = await Promise.all([products.lookupBarcode(v, barcode), stock.itemsWithCode(v, barcode)]);
        return { match, ...(have.length ? { youHave: have.map(({ id, name, place, quantity }) => ({ id, name, quantity, ...(place ? { place } : {}) })) } : {}) };
      }),
  );

  server.registerTool(
    "list_providers",
    {
      title: "List service providers",
      description:
        "The household's service providers (plumber, HVAC company, electrician…) with contact details, how many maintenance tasks they do, how often they've come, when they last did, and what's been spent with them. Use their id as providerId on maintenance tasks.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ providers: (await providers.listProviders(v)).map((p) => compact(p)) })),
  );

  server.registerTool(
    "recently_deleted",
    {
      title: "Recently deleted items",
      description: `Items deleted in the last ${TRASH_DAYS} days, newest first, with who deleted them and the day each goes for good. restore_item brings one back.`,
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ items: (await listDeleted(v)).map((d) => compact({ ...d, photoId: undefined })) })),
  );

  server.registerTool(
    "room_scan_results",
    {
      title: "What a room scan found",
      description:
        "A room scan from scan_room (or one taken in the app): status pending (still looking — ask again shortly), ready (found: name, category, count; tell the person and ask which to keep), failed, or done (with the items it made). Without scanId: every scan still to finish.",
      inputSchema: z.object({ scanId: z.string().min(1).optional() }),
      annotations: read,
    },
    async ({ scanId }) =>
      run(async () => {
        const view = (s: Awaited<ReturnType<typeof roomScans.getRoomScan>>) =>
          compact({
            scanId: s.id,
            status: s.status,
            place: s.placeName,
            error: s.error,
            found: s.candidates.map((c, i) => compact({ index: i, name: c.name, categoryId: c.categoryId, quantity: c.quantity })),
            added: s.items,
          });
        return scanId ? view(await roomScans.getRoomScan(v, scanId)) : { scans: (await roomScans.openRoomScans(v)).map(view) };
      }),
  );

  if (v.readOnly) return server;

  server.registerTool(
    "lend_item",
    {
      title: "Lend or borrow a thing",
      description:
        "Records that an item was lent to someone (direction \"lent\") or borrowed from them (\"borrowed\"), optionally with a due-back date. Reminder emails to borrowers are set up in the app. Search first to get the item's id.",
      inputSchema: z.object({ itemId: z.string().min(1), ...loanInput.pick({ direction: true, person: true, since: true, dueOn: true, note: true }).shape }),
      annotations: write,
    },
    async ({ itemId, ...input }) => run(async () => compact(await loans.createLoan(v, v.files, itemId, input))),
  );

  server.registerTool(
    "loan_returned",
    {
      title: "It's back",
      description: "Marks a lent thing as back (or a borrowed one as given back). Takes the loanId from list_loans.",
      inputSchema: z.object({ loanId: z.string().min(1), on: z.iso.date().optional() }),
      annotations: write,
    },
    async ({ loanId, on }) => run(async () => compact(await loans.returnLoan(v, loanId, on))),
  );

  const photoData = {
    data: z.string().min(16).describe("The image (or PDF, for a document) as base64; no data: prefix"),
    filename: z.string().trim().min(1).max(200).default("photo.jpg"),
  };

  server.registerTool(
    "add_photo",
    {
      title: "Add a photo or document to an item",
      description:
        "Attaches a photo (or a receipt/manual as kind: document) to an item. The vision model reads it in the background; about 20 seconds later get_item shows what it saw and any suggested fields — confirm them with the person before applying them with update_item.",
      inputSchema: z.object({ itemId: z.string().min(1), kind: z.enum(["photo", "document"]).default("photo"), ...photoData }),
      annotations: write,
    },
    async ({ itemId, kind, data, filename }) =>
      run(async () => {
        const added = await addAttachment(v, v.files, itemId, { bytes: decode(data, v.maxUploadBytes), filename, kind });
        return compact({ attachment: added.id, kind: added.kind, analysis: added.analysisStatus ?? "not analysed (no vision model)" });
      }),
  );

  server.registerTool(
    "scan_room",
    {
      title: "Find the things in a room from photos",
      description:
        "Photos (1–5, base64) of a room or an open box: the vision model lists the things in them worth inventorying — a name, a category, how many. Say where with locationId (a room, from list_locations) or containerItemId (a box). It looks in the background: about 20–60 seconds later room_scan_results gives the list. Nothing is added until add_from_room_scan, after the person has said which to keep. One AI action per photo.",
      inputSchema: z.object({
        photos: z.array(photoData.data).min(1).max(5),
        locationId: z.string().min(1).optional(),
        containerItemId: z.string().min(1).optional(),
      }),
      annotations: write,
    },
    async ({ photos, locationId, containerItemId }) =>
      run(async () => {
        const scan = await roomScans.createRoomScan(v, v.files, { locationId, containerItemId, photos: photos.map((p) => decode(p, v.maxUploadBytes)) }, { demo: Boolean(v.demo) });
        return { scanId: scan.id, status: scan.status, place: scan.placeName };
      }),
  );

  server.registerTool(
    "add_from_room_scan",
    {
      title: "Add what a room scan found",
      description:
        "Adds the things the person chose from a ready room scan, as items in its room or box (names can be corrected; categoryId from room_scan_results or list_categories). Only after the person has confirmed the list.",
      inputSchema: z.object({
        scanId: z.string().min(1),
        items: z
          .array(z.object({ name: z.string().trim().min(1).max(200), quantity: z.number().int().min(1).max(10000).default(1), categoryId: z.string().min(1).nullable().optional() }))
          .min(1)
          .max(200),
      }),
      annotations: write,
    },
    async ({ scanId, items }) => run(async () => await roomScans.commitRoomScan(v, scanId, { items })),
  );

  server.registerTool(
    "add_item_from_photo",
    {
      title: "Add an item from a photo",
      description:
        "Creates an item from a photo: the item is saved (as \"New item\" unless you give a name) with the photo attached, and the vision model reads it in the background. About 20 seconds later get_item shows its suggested name, brand, model and serial — confirm with the person, then apply with update_item. Put it somewhere with locationId or containerItemId.",
      inputSchema: z.object({
        ...photoData,
        name: z.string().trim().min(1).max(200).optional(),
        locationId: z.string().min(1).optional(),
        containerItemId: z.string().min(1).optional(),
      }),
      annotations: write,
    },
    async ({ data, filename, name, locationId, containerItemId }) =>
      run(async () => {
        const bytes = decode(data, v.maxUploadBytes);
        const created = await svc.createItem(v, itemInput.parse({ name: name ?? "New item", locationId, containerItemId }));
        try {
          await addAttachment(v, v.files, created.id, { bytes, filename, kind: "photo" });
        } catch (err) {
          await svc.deleteItem(v, created.id); // no photo, no item
          throw err;
        }
        return { id: created.id, name: created.name, next: "Call get_item in about 20 seconds for what the photo shows." };
      }),
  );

  server.registerTool(
    "file_warranty_claim",
    {
      title: "File a warranty claim",
      description:
        "Records a claim made under one of an item's warranties (warranty ids are in get_item): what went wrong, the provider's claim number (reference), and its status (filed by default). filedOn defaults to today.",
      inputSchema: claimInput.extend({ warrantyId: z.string().min(1) }),
      annotations: write,
    },
    async ({ warrantyId, ...input }) => run(async () => compact(await claims.fileClaim(v, warrantyId, input))),
  );

  server.registerTool(
    "update_warranty_claim",
    {
      title: "Update a warranty claim",
      description:
        "Changes a claim: its status (filed, in_progress, approved, denied, resolved), the resolution, what it cost (cents), the claim number. Closing it (denied/resolved) dates it today unless resolvedOn is given.",
      inputSchema: claimPatch.extend({ id: z.string().min(1) }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ id, ...patch }) => run(async () => compact(await claims.updateClaim(v, id, patch))),
  );

  server.registerTool(
    "add_provider",
    {
      title: "Add a service provider",
      description: "Adds a service provider (a plumber, the HVAC company…) with their trade and contact details. Check list_providers first.",
      inputSchema: providerInput,
      annotations: write,
    },
    async (input) => run(async () => compact(await providers.createProvider(v, input))),
  );

  // ── Changing things ───────────────────────────────────────────────────────
  server.registerTool(
    "create_item",
    {
      title: "Add an item",
      description:
        "Adds an item. Search first to avoid duplicates. Put it somewhere with locationId (from list_locations) and give it a categoryId and tags (from list_categories; new tag names are created). Prices in cents. For a collection, collectionId (from list_collections) — it starts from the collection's template; wanted: true puts it on the want list (looked for, not owned yet), and update_item with wanted: false once it's got.",
      inputSchema: itemInput,
      annotations: write,
    },
    async (input) =>
      run(async () => {
        const it = await svc.createItem(v, input);
        return itemView(it, await svc.locationPaths(v));
      }),
  );

  server.registerTool(
    "update_item",
    {
      title: "Update an item",
      description:
        "Changes some of an item's fields; fields left out stay as they are. Send null to clear a field. `tags` replaces the item's whole tag list (send the old ones you want to keep).",
      inputSchema: itemPatch.extend({ id: z.string().min(1) }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ id, ...patch }) =>
      run(async () => {
        const it = await svc.updateItem(v, id, patch);
        return itemView(it, await svc.locationPaths(v));
      }),
  );

  server.registerTool(
    "adjust_stock",
    {
      title: "Use up or restock",
      description:
        "Changes how many of an item there are — consumables like filters, batteries, bulbs: negative `delta` for used up (\"we used the last AA pack\" → -1), positive for bought more. Never goes below 0. The change is logged in the item's stock history. To set an exact count instead, use update_item's quantity.",
      inputSchema: z.object({
        id: z.string().min(1),
        delta: z.number().int().min(-10000).max(10000),
        note: z.string().max(200).optional(),
      }),
      annotations: write,
    },
    async ({ id, delta, note }) =>
      run(async () => {
        if (delta === 0) throw new HTTPException(400, { message: "delta must not be 0" });
        const r = await stock.adjustStock(v, id, delta, "manual", note);
        return compact({ quantity: r.quantity, changedBy: r.applied, note: r.applied !== delta ? "Can't go below 0" : undefined });
      }),
  );

  server.registerTool(
    "record_reading",
    {
      title: "Log an odometer / hour-meter reading",
      description:
        "Records what an item's counter says now — a car's odometer, a mower's or generator's engine hours, a furnace's run hours — in the item's usageUnit (set it with update_item first: miles, km, hours or cycles). Maintenance by use on that item (\"every 5,000 miles\") is then rescheduled from it.",
      inputSchema: usageReadingInput.extend({ id: z.string().min(1).describe("The item") }),
      annotations: write,
    },
    async ({ id, ...reading }) =>
      run(async () => {
        await usage.addReading(v, id, reading);
        const s = await usage.usageSummary(v, id);
        return compact({ unit: s.unit, now: s.now, perDay: s.perDay ? Math.round(s.perDay * 10) / 10 : undefined });
      }),
  );

  server.registerTool(
    "move_item",
    {
      title: "Move an item",
      description: "Records that an item now lives somewhere else: a location (from list_locations), or null for nowhere in particular.",
      inputSchema: z.object({ id: z.string().min(1), locationId: z.string().min(1).nullable() }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ id, locationId }) =>
      run(async () => {
        const paths = await svc.locationPaths(v);
        const to = locationId ? (paths.get(locationId) ?? "?") : "no particular place";
        const it = await svc.updateItem(v, id, { locationId }, (name) => `Moved ${name} to ${to}`);
        return itemView(it, paths);
      }),
  );

  server.registerTool(
    "delete_item",
    {
      title: "Remove an item",
      description: `Removes an item from the inventory. It stays in "Recently deleted" for ${TRASH_DAYS} days (restore_item brings it back), then goes for good. Confirm with the person first.`,
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { ...write, destructiveHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const removed = await svc.deleteItem(v, id);
        return { removed };
      }),
  );

  server.registerTool(
    "restore_item",
    {
      title: "Restore a deleted item",
      description:
        "Brings back an item from Recently deleted (ids from recently_deleted), with its photos, documents, warranties and maintenance. If its place or box was removed meanwhile, it comes back without one.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: write,
    },
    async ({ id }) => run(async () => ({ restored: await restoreItem(v, id) })),
  );

  server.registerTool(
    "create_property",
    {
      title: "Add a property",
      description: "Adds a property: a home, vacation home, rental, storage unit or vehicle. Locations (rooms…) go inside it.",
      inputSchema: propertyInput,
      annotations: write,
    },
    async (input) => run(async () => compact({ ...(await svc.createProperty(v, input)), householdId: undefined })),
  );

  server.registerTool(
    "create_location",
    {
      title: "Add a location",
      description:
        "Adds a location (a room, closet, shelf…) to a property, optionally inside another location (parentId), and optionally with locations inside it in one go: \"a garage with three shelves\" is name \"Garage\", children [\"Shelf 1\", \"Shelf 2\", \"Shelf 3\"]. propertyId can be left out when there's only one property.",
      inputSchema: locationInput.extend({
        propertyId: z.string().min(1).optional(),
        children: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
      }),
      annotations: write,
    },
    async ({ children = [], propertyId, ...input }) =>
      run(async () => {
        const property = propertyId ?? (await onlyProperty(v));
        const created = await svc.createLocation(v, { ...input, propertyId: property });
        const nested = [];
        for (const name of children) nested.push(await svc.createLocation(v, { propertyId: property, parentId: created.id, name }));
        const paths = await svc.locationPaths(v);
        return {
          id: created.id,
          path: paths.get(created.id),
          children: nested.map((l) => ({ id: l.id, path: paths.get(l.id) })),
        };
      }),
  );

  server.registerTool(
    "add_maintenance",
    {
      title: "Add a maintenance task",
      description:
        "Adds upkeep to track: on an item (itemId), a place (locationId) or the whole household. Give intervalCount + intervalUnit for something that repeats (\"every 3 months\"), or neither for a one-off. dueOn defaults to one interval from today (today for a one-off). By use (\"every 5,000 miles\"): usageEvery, on an item that counts something — set the item's usageUnit (update_item) and log a reading (record_reading) first; it can have a time interval too (whichever comes first). Check list_maintenance first so you don't add it twice.",
      inputSchema: maintenanceInput,
      annotations: write,
    },
    async (input) => run(async () => taskView(await upkeep.createTask(v, input))),
  );

  server.registerTool(
    "complete_maintenance",
    {
      title: "Mark maintenance done",
      description:
        "Records that a task was done (today, or doneOn), with an optional note and cost in cents. Credited to the task's usual provider unless providerId says otherwise (null: the household did it). A repeating task is then due again one interval after that day; a one-off is finished. For maintenance by use, give `reading` (what the odometer / hour meter says now): the next is due usageEvery after it.",
      inputSchema: maintenanceDone.extend({ id: z.string().min(1) }),
      annotations: write,
    },
    async ({ id, ...done }) => run(async () => taskView(await upkeep.markDone(v, id, done))),
  );

  server.registerTool(
    "delete_maintenance",
    {
      title: "Remove a maintenance task",
      description: "Stops tracking a maintenance task. Confirm with the person first.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { ...write, destructiveHint: true },
    },
    async ({ id }) => run(async () => ({ removed: await upkeep.deleteTask(v, id) })),
  );

  return server;
}

/** Base64 from a tool call → bytes, within the upload limit. */
function decode(data: string, maxBytes: number) {
  const clean = data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (clean.length * 0.75 > maxBytes) throw new HTTPException(413, { message: `Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB` });
  try {
    return Uint8Array.from(atob(clean), (ch) => ch.charCodeAt(0));
  } catch {
    throw new HTTPException(422, { message: "data must be base64" });
  }
}

/** A task as Claude sees it: no empty fields, and the interval in words. */
function taskView(t: Awaited<ReturnType<typeof upkeep.getTask>>) {
  const { intervalCount, intervalUnit, usage: byUse, dueEstimated, timeDueOn, ...rest } = t;
  const repeats = describeInterval(intervalCount, intervalUnit);
  return compact({
    ...rest,
    repeats: byUse ? `every ${describeUsage(byUse.every, byUse.unit)}${intervalCount ? ` or ${intervalCount === 1 ? `a ${intervalUnit}` : repeats.replace(/^every /, "")}` : ""}` : repeats,
    // By use: where it's due and where the counter is now; dueOn is then an estimate from how fast it's used.
    dueAt: byUse ? describeUsage(byUse.dueAt, byUse.unit) : undefined,
    reading: byUse?.now != null ? describeUsage(byUse.now, byUse.unit) : undefined,
    dueOnIsEstimate: dueEstimated || undefined,
    timeDueOn: byUse && timeDueOn !== rest.dueOn ? timeDueOn : undefined,
  });
}

async function onlyProperty(v: Caller) {
  const properties = await svc.listProperties(v);
  if (properties.length === 1) return properties[0]!.id;
  throw new HTTPException(422, {
    message: properties.length
      ? "There's more than one property — say which one with propertyId (see list_locations)"
      : "There are no properties yet — add one with create_property first",
  });
}

/** Runs a tool: its result as JSON text, or the error as a tool error Claude can read and act on. */
async function run(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 1) }] };
  } catch (err) {
    if (!(err instanceof HTTPException)) {
      console.error(err);
      return { isError: true, content: [{ type: "text" as const, text: "Something went wrong on the Ferret server" }] };
    }
    const details = err.cause ? ` ${JSON.stringify(err.cause)}` : "";
    return { isError: true, content: [{ type: "text" as const, text: `${err.message}${details}` }] };
  }
}

/** An item as Claude sees it: its own fields (no bookkeeping, no empty ones) and where it's kept. */
function itemView(it: Record<string, unknown> & { locationId: string | null }, paths: Map<string, string>) {
  const { householdId: _h, createdBy: _c, deletedAt: _d, indexedAt: _i, ...fields } = it;
  return compact({ ...fields, location: it.locationId ? paths.get(it.locationId) : undefined });
}

/** Drops null, undefined and empty-string fields, to keep replies short. */
function compact<T extends object>(value: T | undefined) {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v != null && v !== "")) as Partial<T>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The category tree for Claude: photo ids are for the app's tiles, not useful to a model. */
function withoutPhotos(nodes: CategoryNode[]): Omit<CategoryNode, "photoId" | "children">[] {
  return nodes.map(({ photoId: _photo, children, ...n }) => ({ ...n, children: withoutPhotos(children) }));
}
