/**
 * The MCP server: "talk to my house". Claude connects to /mcp with an API key
 * (Settings → Claude & API) and works with that key's household through these
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
  propertyPatch,
  providerInput,
  providerPatch,
  categoryPatch,
  locationPatch,
  maintenancePatch,
  warrantyInput,
  warrantyPatch,
  itemsBulk,
  categoryInput,
  loanPatch,
  coverageInput,
  collectionInput,
  collectionPatch,
  TRASH_DAYS,
  fileOwnerQuery,
} from "@ferret/shared";
import { amazonCartUrl } from "@ferret/shared/utils";
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
import { addAttachment, type FileOwner, listFiles, removeFile, searchFiles } from "../lib/attachments";
import * as catalog from "../lib/catalog";
import * as templates from "../lib/templates";
import * as collections from "../lib/collections";
import * as claims from "../lib/claims";
import { itemParts } from "../lib/parts";
import { markMissing, markSeen } from "../lib/sightings";
import * as reviews from "../lib/room-reviews";
import { itemLifespan, replacementForecast } from "../lib/lifespans";
import * as repairs from "../lib/repairs";
import type { RoomReview } from "@ferret/shared";
import { repairInput, repairPatch, reviewOutcomes } from "@ferret/shared";
import type { FileStore } from "../lib/files";
import * as upkeep from "../lib/maintenance";
import * as products from "../lib/products";
import * as providers from "../lib/providers";
import * as stock from "../lib/stock";
import * as usage from "../lib/usage";
import { itemHistory } from "../lib/history";
import * as loans from "../lib/loans";
import * as roomScans from "../lib/room-scans";
import { addCoverage, coverageChecks, deleteCoverage, updateCoverage } from "../lib/coverage";
import * as recalls from "../lib/recalls";
import * as warranties from "../lib/warranties";
import { attachLabel } from "../lib/own-labels";
import { sniffContentType } from "../lib/sniff";

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
- Money is in integer hundredths of the household's currency (e.g. 12999 = 129.99); inventory_report says which currency (ISO 4217, e.g. USD, EUR). Dates are yyyy-mm-dd.
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
        "Finds items by words (names, brands, serial numbers, text read from receipts and manuals) and by meaning (\"something to make holes\" finds a drill), best matches first, each with where it's kept; a box's 6-character QR label code finds the box. Also files: documents and photos of a property, a place or a maintenance task (the deed, an inspection report) whose name or text matches. Start here whenever the person mentions a thing — to answer \"where is…\", and before create_item so you don't add a duplicate. For questions answered from documents (\"what filter does the furnace take?\") use ask_inventory; to browse a room, category or tag use list_items. Leaves out things that are gone or only wanted. Returns items, each with its id, fields, location path and what matched.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe('What to look for, in the person\'s words: "drill", "something to make holes", a serial number or a box\'s label code'),
        limit: z.number().int().min(1).max(50).default(10).describe("How many matches at most"),
        documents: z
          .boolean()
          .default(true)
          .describe("false: leave out what manuals and receipts say, matching only the things themselves and their photos — when manuals that mention the word crowd out the thing"),
      }),
      annotations: read,
    },
    async ({ query, limit, documents }) =>
      run(async () => {
        const results = await svc.searchItems(v, query, {}, limit, "now", { documents: documents ? "include" : "exclude" });
        const paths = await svc.locationPaths(v);
        const files = await searchFiles(v, query, 5);
        return compact({
          items: results.data.map((it) => ({ ...itemView(it, paths), matched: compact(results.hits[it.id]) })),
          // Properties', places' and tasks' own documents and photos that match (an item's are found with the item).
          files: files.map((f) => compact({ id: f.id, kind: f.kind, filename: f.filename, of: `${f.of.kind} ${f.of.name}`, [`${f.of.kind === "place" ? "location" : f.of.kind}Id`]: f.of.id, snippet: f.snippet })),
        });
      }),
  );

  server.registerTool(
    "ask_inventory",
    {
      title: "Ask Ferret",
      description:
        "Answers a question in words from the household's own items and documents (receipts, manuals, warranty cards) — and its house's, rooms' and maintenance tasks' own documents (an inspection report), found by the question's words — citing the items or documents it used — for \"when does the dishwasher warranty end?\" or \"what filter does the furnace take?\". Use search_inventory instead when the person wants to find a thing rather than learn a fact. Needs the server's AI to be switched on, counts as one AI action, and can take several seconds. With itemId, it answers about that one thing only, from its own manual, receipts, warranties and notes (\"how do I reset it?\").",
      inputSchema: z.object({
        question: z.string().trim().min(3).max(500).describe("The question, as the person asked it"),
        itemId: z.string().min(1).optional().describe("Ask about this one item only: an item id from search_inventory or get_item"),
      }),
      annotations: read,
    },
    async ({ question, itemId }) => run(() => (itemId ? svc.askItem(v, itemId, question) : svc.ask(v, question))),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get an item",
      description:
        "Everything about one item: all its fields, where it's kept (and which box), its parts and supplies (bags, filters — items of their own with partOfItemId set to it; add one with create_item and partOfItemId, the part number in model; its manuals' suggested parts are in attachments' suggestions.parts), warranties and claims, its photos and documents with what the vision model read in them, its repairs, what owning it has cost (cost: paid + maintenance + repairs − what it sold for, per year owned), what replaced it, how long it should last (lifespan), when it was last seen (lastSeen; missingSince if nobody can find it), and any suggested fields waiting for the person to confirm (item fields go through update_item, a warranty through save_warranty, a schedule through save_maintenance). Use it after search_inventory or list_items has found the item, when you need the details; for what happened to it over time use item_history, and for a quick look at many items list_items is enough.",
      inputSchema: z.object({ id: z.string().min(1).describe("The item's id, from search_inventory or list_items") }),
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
        const { parts } = await itemParts(v, id);
        return {
          ...itemView(it, paths),
          // Its parts and supplies (items of their own, partOfItemId = this): stock and where to buy.
          parts: parts.length
            ? parts.map((p) => compact({ id: p.id, name: p.name, partNumber: p.model ?? undefined, quantity: p.quantity, onShoppingList: p.low || undefined, buyAt: p.link?.url, amazonCart: p.amazonCart ?? undefined, amazonSearch: p.amazonSearch ?? undefined, usedBy: p.task ?? undefined }))
            : undefined,
          box: listed?.container?.name,
          contents: listed?.contents || undefined,
          label: listed?.labelCode ?? undefined,
          // When someone last saw it (scanned, "Still here", a room review); missingSince: nobody can find it.
          lastSeen: listed?.lastSeen ? compact({ at: listed.lastSeen.at, by: listed.lastSeen.by, how: listed.lastSeen.kind }) : undefined,
          // Repairs, what owning it has cost, and what replaced it / what it replaced.
          repairs: await repairs.listRepairs(v, id).then((rs) => (rs.length ? rs.map((r) => compact({ id: r.id, repairedOn: r.repairedOn, work: r.work, problem: r.problem, by: r.providerName, parts: r.parts, costCents: r.costCents, warrantyEndsOn: r.warrantyEndsOn })) : undefined)),
          cost: await repairs.ownershipCost(v, id).then((c) => compact({ totalCents: c.totalCents, perYearCents: c.perYearCents, years: c.years, paidCents: c.paidCents, maintenanceCents: c.maintenanceCents || undefined, repairCents: c.repairCents || undefined, backCents: c.backCents })),
          ...(await repairs.replacementsOf(v, it).then(({ replacedBy, replaces }) => compact({ replacedBy: replacedBy ?? undefined, replaces: replaces.length ? replaces : undefined }))),
          // How long it should last and when it's likely due — an estimate (its own, its category's or typical).
          lifespan: await itemLifespan(v, it).then((l) => (l ? compact({ ...l, from: l.from ?? undefined }) : undefined)),
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
        "Lists items, most recently changed first, 50 at a time (offset for more), with where each is kept. Use it to browse rather than search: with locationId, everything in that place and the places inside it (\"what's in the garage?\"); containerItemId, what's directly in a box; categoryId, a category and its subcategories; tag, a tag's items (a tag can be a collection, e.g. \"Christmas decorations\"); origin, how they were added (\"claude\": what you added, to check your own work); collectionId (list_collections), a collection's things — wanted \"include\" adds its want list, \"only\" just that; misplaced, the things nobody can find (marked \"can't find it\"); notSeenSince, what nobody has seen (scanned, confirmed still here, checked in a room review) since a day, longest unseen first. To find a particular thing by name, use search_inventory.",
      inputSchema: z.object({
        locationId: z.string().min(1).optional().describe("Only what's in this place and the places inside it, from list_locations"),
        containerItemId: z.string().min(1).optional().describe("Only what's directly inside this box (an item with isContainer)"),
        categoryId: z.string().min(1).optional().describe("Only this category and its subcategories, from list_categories"),
        tag: z.string().trim().min(1).max(40).optional().describe("Only items with this tag name (list_categories lists tags)"),
        origin: z.enum(itemOrigins).optional().describe("Only things added this way: app, photos, walkthrough, roomscan, scan, label, spreadsheet, homeassistant, claude, api"),
        collectionId: z.string().min(1).optional().describe("Only this collection's things, from list_collections"),
        wanted: z.enum(["include", "only"]).optional().describe("The want list (things not owned yet): left out unless asked for"),
        misplaced: z.boolean().optional().describe("true: only things marked \"can't find it\" (each has missingSince)"),
        notSeenSince: z.iso.date().optional().describe("Only things not seen since this day (yyyy-mm-dd) and added before it — \"what haven't we seen in a year?\""),
        limit: z.number().int().min(1).max(200).default(50).describe("How many items in this page"),
        offset: z.number().int().min(0).default(0).describe("How many to skip, for the next page (total says how many there are)"),
      }),
      annotations: read,
    },
    async ({ locationId, containerItemId, categoryId, tag, origin, collectionId, wanted, misplaced, notSeenSince, limit, offset }) =>
      run(async () => {
        const locationIds = locationId ? await svc.descendants(v, locationId) : undefined;
        const categoryIds = categoryId ? await catalog.categoryDescendants(v, categoryId) : undefined;
        const tagged = tag ? await catalog.findTag(v, tag) : undefined;
        if (tag && !tagged) return { total: 0, offset, items: [] };
        const page = await svc.listItems(
          v,
          { locationIds, containerItemId, categoryIds, tagId: tagged?.id, origin, collectionId, wanted, misplaced: misplaced ? "only" : undefined, notSeenSince },
          notSeenSince ? { limit, offset, sort: "seen", dir: "asc" } : { limit, offset },
        );
        const paths = await svc.locationPaths(v);
        return { total: page.total, offset, items: page.data.map((it) => itemView(it, paths)) };
      }),
  );

  server.registerTool(
    "list_locations",
    {
      title: "List places",
      description:
        "Every property (home, cabin, storage unit…) with its locations as a tree (rooms › closets › shelves), their ids and how many items each holds. Call it to get a locationId or propertyId before create_item, update_item, list_items or save_location, and to check a place exists before adding it again. Read-only; the whole tree in one call.",
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
        "What to act on now, urgent first: maintenance overdue or due within a week, warranties ending within 30 days, return windows closing within a week, warranty claims with no news for two weeks, things running low, borrowed things due back, recalls that may affect something owned, insurance limits that fall short, and items or room scans from photos still to finish. Returns entries with kind, severity (urgent or soon), title, detail, the itemId to open (if any) and a date. Use it for \"anything I should deal with?\" or a daily check-in; for the full maintenance schedule use list_maintenance, for all warranties list_warranties, for what to buy shopping_list. Empty when nothing needs doing.",
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
        "What to buy, run-out first: tracked consumables that have run out or are at or below their minimum (minQuantity, \"keep at least\"), with how many are left and a suggested amount to buy (and, for things bought on Amazon, amazonCart: an address that puts that many in the person's Amazon cart; for the rest, amazonSearch: a search on Amazon for its part/model number). Use it for \"what do we need?\" or before a shop; after buying, adjust_stock with a positive delta takes things off the list. Read-only.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ toBuy: (await stock.shoppingList(v)).items.map(({ photoId: _photo, amazon, amazonSearch, ...i }) =>
          compact({
            ...i,
            place: i.place ?? undefined,
            minQuantity: i.minQuantity ?? undefined,
            unitCents: i.unitCents ?? undefined,
            amazonCart: amazon ? amazonCartUrl(amazon.site, [{ asin: amazon.asin, quantity: i.buy }]) : undefined,
            amazonSearch: amazonSearch ?? undefined,
          }),
        ),
      })),
  );

  server.registerTool(
    "item_history",
    {
      title: "An item's history",
      description:
        "What happened to one item, newest first: when it was added, each edit in words (moved from where to where, value, name…), photos and documents added, warranties and claims, maintenance done, stock used or restocked, loans. Use it for \"when did we move the ladder?\" or \"when was the furnace last serviced?\"; for the item as it is now use get_item. Get the id from search_inventory first. Returns entries with when (at), what happened in words, who, and how (the app, Claude, a script); more is true when there are older ones.",
      inputSchema: z.object({
        itemId: z.string().min(1).describe("The item's id, from search_inventory or list_items"),
        limit: z.number().int().min(1).max(100).default(30).describe("How many entries at most, newest first"),
      }),
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
        "Checks the household's insurance limits against the inventory: each limit (contents cover, or a special limit on one category or tag such as jewelry or firearms) next to what those things are worth, how much short it is, and how many have no value recorded. Use it for \"are we insured enough?\"; for what everything is worth by room or property, use inventory_report. Each limit has its id and fields for save_coverage_limit (to change it) and remove. Amounts are in cents. Empty when no limits are set.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () =>
      run(async () => ({
        limits: (await coverageChecks(v)).map((c) =>
          compact({ id: c.id, label: c.label, limitCents: c.limitCents, worthCents: c.valueCents, shortCents: c.shortCents || undefined, items: c.items, withoutValue: c.unvalued || undefined, covers: c.categoryName ?? (c.tag ? `tag ${c.tag}` : "everything"), scope: c.scope, categoryId: c.categoryId, tag: c.tag, propertyId: c.propertyId, property: c.propertyName, note: c.note }),
        ),
      })),
  );

  server.registerTool(
    "list_loans",
    {
      title: "Lent and borrowed",
      description:
        "Things lent out (who has them, since when, when they're due back) and things borrowed from others, still out, overdue ones marked, each with its loanId. Use it for \"who has the ladder?\" or \"what have I lent out?\", and to get the loanId (pass it as id) for return_loan or save_loan. Only open loans; returned ones are in each item's item_history.",
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
        "The household's categories as a tree (ids, paths, item counts and any extra fields their items have — e.g. a TV's screen size), its tags with how many items carry each, and its item templates (kinds of thing with their own fields: a coin's year, mint mark and grade). Call it before create_item or update_item to pick a categoryId, existing tag names (to avoid near-duplicates) or a templateId — then put the template's or category's field values in customFields by their keys.",
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
        "The household's collections (coins, dolls, cards…): for each, how many things are owned (pieces counts duplicates), how many are on its want list, what the owned ones are worth and cost (cents), and its templateId (the fields its things have: list_categories). Use it for \"how's the coin collection?\" and to get a collectionId; the things themselves are list_items with collectionId.",
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
        "Warranties on file across all items, soonest to end first. Returns each with its id, item, provider, start and end dates and status. Use it for \"what's still under warranty?\" or \"what's about to run out?\" (status expiring); for one item's warranties and claims use get_item, and for the urgent ones alongside everything else what_needs_attention.",
      inputSchema: z.object({
        status: z
          .enum(["active", "expiring", "expired"])
          .optional()
          .describe("active: still covered (including expiring); expiring: ends within 60 days; expired. Left out: all"),
      }),
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
        "What everything is worth, for insurance: totals by property and by room, the most valuable items, and how many have no value recorded. An item counts at its value, else its purchase price, times its quantity; amounts in cents (hundredths) of its currency, which it names; gone and wanted things are left out. Use it for \"what's all our stuff worth?\"; to compare against insurance limits use coverage_check.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ currency: v.currency, ...(await svc.inventoryReport(v)) })),
  );

  server.registerTool(
    "list_maintenance",
    {
      title: "List maintenance",
      description:
        "Maintenance tasks (replace filters, service the boiler, clean gutters…), soonest due first, each with its id, the item or place and who usually does it; a task that uses a part says how many are left and, as part.shortOn, the first time it's due without enough (counting its repeats and other tasks that use the part) — buy more before then. Use it to see the schedule, to get a task's id for complete_maintenance, and before save_maintenance so you don't add one twice; for just what's urgent across everything, what_needs_attention.",
      inputSchema: z.object({
        status: z
          .enum(["open", "overdue", "due", "upcoming", "done", "all"])
          .default("open")
          .describe("open: everything not finished; overdue; due: within 14 days; upcoming: later; done: finished one-offs; all"),
        itemId: z.string().min(1).optional().describe("Only this item's tasks, from search_inventory"),
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
        "Says what product a UPC/EAN barcode is, and whether the household already has it. Use it when the person reads out or scans a barcode, before create_item; to find a thing by name use search_inventory. Looks in Ferret's own barcode book (learned from items saved on this server) first, then the online product database if it's switched on. Returns match (name, brand, model, source, photos — null when nobody knows the code) and youHave (the household's items with this code: id, name, quantity, place). When youHave isn't empty, offer adjust_stock on one of those rather than a duplicate, unless the person wants a separate item.",
      inputSchema: z.object({ barcode: z.string().trim().min(8).max(20).describe("The digits under the barcode (UPC-A, EAN-13 or EAN-8)") }),
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
        "The household's service providers (plumber, HVAC company, electrician…) with contact details, how many maintenance tasks they do, how often they've come, when they last did and what's been spent with them. Use it for \"who did we use for the furnace?\", to get a providerId for save_maintenance or complete_maintenance, and before save_provider so you don't add one twice.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => run(async () => ({ providers: (await providers.listProviders(v)).map((p) => compact(p)) })),
  );

  server.registerTool(
    "recently_deleted",
    {
      title: "Recently deleted items",
      description:
        "Items deleted in the last 30 days, newest first, with who deleted them and the day each goes for good. Use it when the person wants something back or asks what was removed; restore_item brings one back by its id. Only items — deleted maintenance tasks, places and the rest aren't listed.",
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
        "Checks on a room scan from scan_room (or one taken in the app): status pending (still looking — ask again in a little while), ready (what it found: name, category, how many — tell the person and ask which to keep), failed, or done (with the items it made). Without scanId, every scan still waiting to be finished. Once the person has chosen, add_from_room_scan adds them.",
      inputSchema: z.object({ scanId: z.string().min(1).optional().describe("The scan's id, from scan_room; left out: every unfinished scan") }),
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

  server.registerTool(
    "get_photo",
    {
      title: "Look at a photo",
      description:
        "Shows you one of an item's photos as an image, so you can see the thing itself — its condition, a label or serial plate, which one it is — rather than only what the vision model wrote about it in get_item. The attachment's id comes from get_item's attachments; for a document (a PDF) you get a picture of its first page. size small (the default) is a 600-pixel copy, enough to recognise things; large is up to 1568 pixels, for reading small print. Changes nothing.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The photo's or document's id, from get_item's attachments"),
        size: z.enum(["small", "large"]).default("small").describe("small: a 600-pixel copy; large: up to 1568 pixels, for small print"),
      }),
      annotations: read,
    },
    async ({ id, size }) => {
      try {
        const [row] = await v.db
          .select()
          .from(attachment)
          .where(and(eq(attachment.id, id), eq(attachment.householdId, v.householdId), isNull(attachment.deletedAt)));
        if (!row) throw svc.notFound("Photo");
        const image = await photoBytes(v, row, size);
        if (!image) throw new HTTPException(409, { message: "There's no picture of this one (a document Ferret couldn't draw)" });
        return {
          content: [
            { type: "image" as const, data: toBase64(image.bytes), mimeType: image.type },
            { type: "text" as const, text: JSON.stringify(compact({ id: row.id, kind: row.kind, filename: row.filename, item: row.itemId })) },
          ],
        };
      } catch (err) {
        return run(() => Promise.reject(err));
      }
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List a property's, place's or task's files",
      description:
        "The documents and photos kept with a property (the deed, the insurance policy), a place (a room's inspection report), a maintenance task (a quote, and the invoices of the times it was done) or one time it was done — each with what was read in it. Give exactly one id. An item's files are in get_item; to find files by words use search_inventory; to see one use get_photo. Changes nothing.",
      inputSchema: z.object({
        propertyId: z.string().min(1).optional().describe("A property's id, from list_locations"),
        locationId: z.string().min(1).optional().describe("Or a place's id, from list_locations"),
        taskId: z.string().min(1).optional().describe("Or a maintenance task's id, from list_maintenance"),
        doneId: z.string().min(1).optional().describe("Or one time a task was done (doneId from complete_maintenance)"),
      }),
      annotations: read,
    },
    async (of) =>
      run(async () => {
        const parsed = fileOwnerQuery.safeParse(of);
        if (!parsed.success) throw new HTTPException(422, { message: "Give exactly one of propertyId, locationId, taskId or doneId" });
        const files = await listFiles(v, parsed.data);
        return {
          files: files.map((f) =>
            compact({ id: f.id, kind: f.kind, filename: f.filename, addedAt: f.createdAt, doneId: f.doneId, description: f.analysis?.description || undefined, text: f.analysis?.text?.slice(0, 2000) || undefined }),
          ),
        };
      }),
  );

  server.registerTool(
    "list_recalls",
    {
      title: "Product recalls",
      description:
        "U.S. product recalls (from the CPSC) that match things the household owns, each with its id, the item, how sure the match is (barcode or model: almost certainly theirs; possible: same brand and kind of thing — check the model), the hazard, the remedy and who to contact. Without itemId: open recalls only; with itemId: that item's recalls, dealt with ones too. Use it for \"is anything we own recalled?\" or to explain a recall what_needs_attention mentioned; mark one with set_recall_status once the person says. Empty when there are none or the server's admin hasn't switched recall checks on.",
      inputSchema: z.object({ itemId: z.string().min(1).optional().describe("One item's recalls (from search_inventory), including closed ones; left out: every open one") }),
      annotations: read,
    },
    async ({ itemId }) =>
      run(async () => ({
        recalls: (await recalls.listRecalls(v, { itemId })).map((r) =>
          compact({ id: r.id, item: r.itemName, itemId: r.itemId, match: r.match, status: r.status, ...compact({ ...r.recall, id: undefined, imageUrl: undefined }) }),
        ),
      })),
  );

  server.registerTool(
    "list_templates",
    {
      title: "List item templates",
      description:
        "The household's item templates — kinds of things with their own fields (a coin's year and mint mark, a record's label and pressing) — each with its id, fields and how many things use it. Use it to pick a templateId for save_collection, or to see which fields to fill in (customFields on create_item) for that kind of thing. Changes nothing.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () =>
      run(async () => ({ templates: (await templates.listTemplates(v)).map((tpl) => compact({ ...tpl, icon: undefined, tags: tpl.tags.length ? tpl.tags : undefined })) })),
  );

  server.registerTool(
    "rooms_to_review",
    {
      title: "Places to review",
      description:
        "The household's places with things in them, the next to check first: room reviews under way (with how many things they've checked), then places never reviewed (fullest first), then the longest since their last review — plus how many things nobody can find and how many haven't been seen in a year. Use it when the person wants to check their inventory is still right, or asks which room to go through next; then room_review walks one place.",
      inputSchema: z.object({}),
      annotations: read,
    },
    async () =>
      run(async () => {
        const [rooms, tracking] = await Promise.all([reviews.roomsToReview(v), reviews.trackingSummary(v)]);
        return {
          cantFind: tracking.misplaced,
          notSeenInAYear: tracking.notSeenYear,
          places: rooms.map((r) => compact({ locationId: r.locationId, place: r.path, things: r.items, lastReviewed: r.reviewedAt ?? "never", underWay: r.open ? { checked: r.open.done, since: r.open.startedAt } : undefined })),
        };
      }),
  );

  server.registerTool(
    "replacement_forecast",
    {
      title: "Replacement forecast",
      description:
        "What's likely to wear out and need replacing, by year — from each thing's lifespan (its own, its category's, or the typical life for its kind: a water heater ~10 years, a fridge ~13) counted from when it was bought (or added), with what replacing it might cost (replacement cost if set, else price paid, else value). Use it for \"what big expenses are coming up?\" or \"what's past its typical life?\". These are estimates — say so, and never tell the person to replace something just because it's old. A thing's or category's lifespan can be set with update_item / save_category lifespanYears.",
      inputSchema: z.object({ years: z.number().int().min(1).max(30).default(10).describe("How many years ahead, from this one") }),
      annotations: read,
    },
    async ({ years }) =>
      run(async () => {
        const f = await replacementForecast(v, { years });
        const year = (y: { year: number; items: number; cents: number; unpriced: number }) => compact({ year: y.year, things: y.items, costCents: y.cents || undefined, unpriced: y.unpriced || undefined });
        return compact({
          pastTypicalLife: f.past.items ? compact({ things: f.past.items, costCents: f.past.cents || undefined, unpriced: f.past.unpriced || undefined }) : undefined,
          byYear: f.years.filter((y) => y.items).map(year),
          things: f.items.map((i) => compact({ id: i.id, name: i.name, place: i.place ?? undefined, lifespanYears: i.lifespan.years, from: i.lifespan.from ?? (i.lifespan.source === "item" ? "set on it" : undefined), since: i.lifespan.since, dueYear: i.lifespan.dueYear, past: i.lifespan.past || undefined, costCents: i.lifespan.costCents ?? undefined })),
          noLifespanKnown: f.unknown || undefined,
        });
      }),
  );

  if (v.readOnly) return server;

  server.registerTool(
    "mark_seen",
    {
      title: "Still here / can't find it",
      description:
        "Records what the person says about where a thing is. status \"here\": they've just seen it (\"the drill's in the garage\", \"found the passport!\") — it's marked as seen now, a box with everything in it, and if it was missing it's found again. status \"missing\": they can't find it — it goes on the can't-find list (list_items misplaced) but still counts as owned; for something lost for good, use update_item with disposition \"lost\" instead. If it's been moved, change its locationId with update_item too. Returns the thing's name and what changed.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The item's id, from search_inventory or list_items"),
        status: z.enum(["here", "missing"]).describe("\"here\": seen just now (or found); \"missing\": nobody can find it"),
      }),
      annotations: write,
    },
    async ({ id, status }) =>
      run(async () => {
        const before = await svc.getItem(v, id);
        if (status === "missing") {
          await markMissing(v, id);
          return { name: before.name, missing: true };
        }
        const confirmed = await markSeen(v, id);
        return compact({ name: before.name, seen: true, found: before.missingSince ? true : undefined, alsoSeenInside: confirmed > 1 ? confirmed - 1 : undefined });
      }),
  );

  const reviewView = (r: RoomReview) =>
    compact({
      place: r.path,
      underWay: r.review ? true : undefined,
      lastReviewed: r.reviewedAt ?? (r.review ? undefined : "never"),
      toCheck: r.toCheck.map((it) => compact({ id: it.id, name: it.name, box: it.isContainer ? { contents: it.contents } : undefined, lastSeen: it.lastSeen?.at })),
      checked: r.checked.length ? r.checked.map((it) => ({ id: it.id, name: it.name, found: it.outcome })) : undefined,
      placesInside: r.inside.length ? r.inside.map((p) => ({ locationId: p.locationId, name: p.name, things: p.items })) : undefined,
    });

  server.registerTool(
    "room_review",
    {
      title: "Review a room",
      description:
        "Walks one place with the person, checking each thing kept there is still right — the same room review as the app's, so they can carry it on there. Call it with just locationId to start (or carry on) the review and get what's to check (a box counts for everything in it; places inside are reviewed on their own). Then, as the person tells you, pass checks: found \"here\" (still there), \"moved\" (with locationId: where it is now), \"missing\" (can't find it), or \"gone\" (only after update_item has set its disposition — sold, given away, thrown out). A check can be changed by checking it again. finish: true when they're done (it's then the place's last review, even with things left unchecked). Returns what's still to check and what's been checked.",
      inputSchema: z.object({
        locationId: z.string().min(1).describe("The place, from rooms_to_review or list_locations"),
        checks: z
          .array(
            z.object({
              id: z.string().min(1).describe("A thing's id, from toCheck"),
              found: z.enum(reviewOutcomes).describe("here, moved, missing or gone"),
              locationId: z.string().min(1).optional().describe("For moved: where it is now"),
            }),
          )
          .max(100)
          .optional()
          .describe("What the person found, one entry per thing"),
        finish: z.boolean().optional().describe("true: the review is done"),
      }),
      annotations: write,
    },
    async ({ locationId, checks, finish }) =>
      run(async () => {
        let r = await reviews.startRoomReview(v, locationId);
        const problems: string[] = [];
        for (const c of checks ?? []) {
          try {
            r = await reviews.checkInReview(v, locationId, c.id, c.found, c.locationId);
          } catch (err) {
            problems.push(`${c.id}: ${err instanceof HTTPException ? err.message : "failed"}`);
          }
        }
        if (finish) {
          // What it found, before finishing clears the review under way.
          const done = await reviews.finishRoomReview(v, locationId);
          return compact({
            place: done.path,
            finished: true,
            checked: r.checked.map((it) => ({ id: it.id, name: it.name, found: it.outcome })),
            leftUnchecked: r.toCheck.length || undefined,
            problems: problems.length ? problems : undefined,
          });
        }
        return compact({ ...reviewView(r), problems: problems.length ? problems : undefined });
      }),
  );

  const photoData = {
    data: z.string().min(16).describe("The image (or PDF, for a document) as base64; no data: prefix"),
    filename: z.string().trim().min(1).max(200).default("photo.jpg").describe('The file\'s name, with its extension ("receipt.pdf")'),
  };

  server.registerTool(
    "add_photo",
    {
      title: "Add a photo or document",
      description:
        "Attaches a photo — or a receipt, manual or warranty card as kind \"document\" — to an item that already exists (itemId), or to what isn't one thing: a property (the deed, the insurance policy), a place (a room's inspection report), a house-wide maintenance task (a quote), or one time a task was done (doneId, from complete_maintenance: the invoice). Give exactly one of them. An item's is read by the vision model in the background; about 20 seconds later get_item shows what it saw and any suggested fields: confirm them with the person before applying them with update_item. The others are read for their words only (to find them by: search_inventory's files). To add a new thing from its photo use add_item_from_photo instead. Counts as AI actions when the AI is on.",
      inputSchema: z.object({
        itemId: z.string().min(1).optional().describe("The item's id, from search_inventory"),
        propertyId: z.string().min(1).optional().describe("Or a property's id, from list_locations"),
        locationId: z.string().min(1).optional().describe("Or a place's id, from list_locations"),
        taskId: z.string().min(1).optional().describe("Or a maintenance task's id, from list_maintenance (an item's task keeps it on the item)"),
        doneId: z.string().min(1).optional().describe("Or the time a task was done: doneId from complete_maintenance"),
        kind: z.enum(["photo", "document"]).default("photo").describe("photo: a picture of the thing; document: a receipt, manual, report or warranty card (photo or PDF)"),
        ...photoData,
      }),
      annotations: write,
    },
    async ({ itemId, propertyId, locationId, taskId, doneId, kind, data, filename }) =>
      run(async () => {
        const owners = [itemId && { itemId }, propertyId && { propertyId }, locationId && { locationId }, taskId && { taskId }, doneId && { doneId }].filter(Boolean);
        if (owners.length !== 1) throw new HTTPException(422, { message: "Give exactly one of itemId, propertyId, locationId, taskId or doneId" });
        const added = await addAttachment(v, v.files, owners[0] as FileOwner, { bytes: decode(data, v.maxUploadBytes), filename, kind });
        return compact({ attachment: added.id, kind: added.kind, item: added.itemId, analysis: added.analysisStatus ?? "not read (the AI isn't on)" });
      }),
  );

  server.registerTool(
    "scan_room",
    {
      title: "Find the things in a room from photos",
      description:
        "Finds the things worth inventorying in 1–5 photos of a room or an open box: the vision model lists each with a name, a category and how many. Use it when the person wants to add a lot at once; for one thing use add_item_from_photo. Say where with locationId (a room) or containerItemId (a box). It looks in the background: about 20–60 seconds later room_scan_results has the list. Nothing is added until add_from_room_scan, after the person has said which to keep. One AI action per photo.",
      inputSchema: z.object({
        photos: z.array(photoData.data).min(1).max(5).describe("1–5 photos of the room or open box, each base64"),
        locationId: z.string().min(1).optional().describe("The room they show, from list_locations"),
        containerItemId: z.string().min(1).optional().describe("Or the box they show (an item with isContainer)"),
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
        "Adds the things the person chose from a ready room scan (room_scan_results), as items in the scan's room or box — names can be corrected and a categoryId given. Only after the person has confirmed the list; the scan is then done, and each new item records that it came from a room scan. Returns the items made.",
      inputSchema: z.object({
        scanId: z.string().min(1).describe("The scan's id, from scan_room or room_scan_results"),
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200).describe("The name to save (the scan's, or the person's correction)"),
              quantity: z.number().int().min(1).max(10000).default(1).describe("How many"),
              categoryId: z.string().min(1).nullable().optional().describe("A category id, from room_scan_results or list_categories"),
            }),
          )
          .min(1)
          .max(200)
          .describe("Only the things the person chose to keep"),
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
        "Creates a new item from a photo: it's saved straight away (as \"New item\" unless you give a name) with the photo attached, and the vision model reads it in the background. About 20 seconds later get_item shows its suggested name, brand, model and serial — confirm with the person, then apply with update_item. Use it when the person sends a picture of something to add; for a photo of something already in the inventory use add_photo. Put it somewhere with locationId or containerItemId.",
      inputSchema: z.object({
        ...photoData,
        name: z.string().trim().min(1).max(200).optional().describe('Its name, if the person said it; otherwise it\'s "New item" until confirmed'),
        locationId: z.string().min(1).optional().describe("Where it's kept, from list_locations"),
        containerItemId: z.string().min(1).optional().describe("Or the box it's in (an item with isContainer)"),
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

  // ── Changing things ───────────────────────────────────────────────────────
  server.registerTool(
    "create_item",
    {
      title: "Add an item",
      description:
        "Adds a new item. Search first (search_inventory) so you don't add a duplicate; if it's already there, update_item or adjust_stock instead. Put it somewhere with locationId (list_locations) or in a box with containerItemId, and give it a categoryId and tags (list_categories; new tag names are created). Prices in cents. For a collection, collectionId (list_collections) starts it from the collection's template; wanted: true puts it on the want list (looked for, not owned yet), and update_item with wanted: false once it's got. From a photo, use add_item_from_photo. Returns the new item with its id.",
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
        "Changes some of an item's fields — name, brand, value, category, notes, the box it's in… — after the person has said what to change (or confirmed suggestions from get_item). Fields left out stay as they are; send null to clear one. `tags` and `links` replace the whole list (send the old ones you want to keep). To move it, set locationId (from list_locations; null: nowhere in particular) — moving a box takes what's inside along, and moving something that was in a box takes it out of the box; to put it into a box, containerItemId. For using some up or restocking use adjust_stock, which logs the change; for a counter reading use record_reading. Returns the updated item.",
      inputSchema: itemPatch.extend({ id: z.string().min(1).describe("The item's id, from search_inventory or list_items") }),
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
        "Counts consumables up or down — filters, batteries, bulbs: negative delta for used up (\"we used the last AA pack\" → -1), positive for bought more. Use it whenever the person uses up or buys something tracked; it never goes below 0, logs the change in the item's stock history, and moves the item on or off the shopping list. To set an exact count (after a recount), use update_item's quantity. Returns the new count.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The item's id, from search_inventory"),
        delta: z.number().int().min(-10000).max(10000).describe("How many used (negative) or bought (positive); not 0"),
        note: z.string().max(200).optional().describe('Why, for its stock history ("used for the guest room")'),
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
        "Records what an item's counter says now — a car's odometer, a mower's or generator's engine hours, a furnace's run hours — in the item's usageUnit (set it with update_item first: miles, km, hours or cycles). Maintenance by use on that item (\"every 5,000 miles\") is rescheduled from it. Use it when the person mentions a reading; when they've just done the maintenance, give the reading to complete_maintenance instead.",
      inputSchema: usageReadingInput.extend({ id: z.string().min(1).describe("The item's id (one with a usageUnit), from search_inventory") }),
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
    "restore_item",
    {
      title: "Restore a deleted item",
      description:
        "Brings back an item from Recently deleted (ids from recently_deleted), with its photos, documents, warranties and maintenance. Use it when the person wants a deleted thing back within 30 days. If its place or box was removed meanwhile, it comes back without one — update_item can put it somewhere. Returns the restored item's id and name.",
      inputSchema: z.object({ id: z.string().min(1).describe("The deleted item's id, from recently_deleted") }),
      annotations: write,
    },
    async ({ id }) => run(async () => ({ restored: await restoreItem(v, id) })),
  );

  server.registerTool(
    "complete_maintenance",
    {
      title: "Mark maintenance done",
      description:
        "Records that a task was done (today, or doneOn), with an optional note and cost in cents — use it whenever the person says they did one (\"changed the furnace filter\"); the id comes from list_maintenance Returns doneId, the record just made: its invoice or photos go to add_photo with doneId. Credited to the task's usual provider unless providerId says otherwise (null: the household did it), and its part, if it has one, comes out of stock. A repeating task is then due again one interval after that day; a one-off is finished. For maintenance by use, give reading (what the odometer or hour meter says now): the next is due usageEvery after it. Returns the task with its new due date.",
      inputSchema: maintenanceDone.extend({ id: z.string().min(1).describe("The task's id, from list_maintenance") }),
      annotations: write,
    },
    async ({ id, ...done }) => run(async () => taskView(await upkeep.markDone(v, id, done))),
  );

  // ── Many things at once ───────────────────────────────────────────────────
  server.registerTool(
    "bulk_update_items",
    {
      title: "Change many things at once",
      description:
        "Makes one change to up to 200 items in one go: move them to a location (action move, locationId; null: no location), give them a category (category, categoryId; null: none), add or remove a tag (tag / untag, tag), or have the AI read their photos and documents that haven't been read yet (analyze: never read, or it failed; each counts as an AI action; their suggestions then show on each item). Use it for \"move everything on the garage shelf to the basement\" — get the ids from list_items or search_inventory first, and say what you're about to change before doing it. Things inside a box move with the box; move the box itself. Returns how many were changed (for analyze, how many files were queued) and which failed, and why. To delete items use remove, one at a time.",
      inputSchema: z.object({
        action: z.enum(["move", "category", "tag", "untag", "analyze"]).describe("What to do to every one of them"),
        ids: z.array(z.string().min(1)).min(1).max(200).describe("The items' ids, from list_items or search_inventory"),
        locationId: z.string().min(1).nullable().optional().describe("For move: where to, from list_locations; null: no location"),
        categoryId: z.string().min(1).nullable().optional().describe("For category: the category, from list_categories; null: none"),
        tag: z.string().trim().min(1).max(40).optional().describe("For tag and untag: the tag's name (a new name makes the tag)"),
      }),
      annotations: write,
    },
    async (input) =>
      run(async () => {
        const parsed = itemsBulk.safeParse(input);
        if (!parsed.success) {
          const need = { move: "locationId", category: "categoryId", tag: "tag", untag: "tag", analyze: "ids" }[input.action];
          throw new HTTPException(422, { message: `${input.action} needs ${need}` });
        }
        return svc.bulkItems(v, parsed.data);
      }),
  );

  server.registerTool(
    "set_recall_status",
    {
      title: "Mark a recall",
      description:
        "Marks a recall on one of the household's things, once the person says: dismissed (not theirs — a different model), done (dealt with: repaired, refunded, replaced) or open (again). The id comes from list_recalls. Dismissed and done ones leave what_needs_attention.",
      inputSchema: z.object({
        id: z.string().min(1).describe("The recall match's id, from list_recalls"),
        status: z.enum(["dismissed", "done", "open"]).describe("dismissed: not affected; done: dealt with; open: needs dealing with again"),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    async ({ id, status }) =>
      run(async () => {
        await recalls.resolveRecall(v, id, status);
        return { id, status };
      }),
  );

  server.registerTool(
    "attach_label",
    {
      title: "Put a label on something",
      description:
        "Puts a label the household already has on an item, a box or a place, so scanning it opens that: one of their blank Ferret QR labels (its 6-character code, e.g. K7QM2X) or — on items and boxes — any other code, like an asset tag or a sticker from elsewhere. Use it when the person says \"I stuck label K7QM2X on the camping bin\". Give itemId or locationId, not both. Refused if the label is already on something, or the thing already has a Ferret label.",
      inputSchema: z.object({
        code: z.string().trim().min(1).max(500).describe("The label's code as printed or scanned"),
        itemId: z.string().min(1).optional().describe("The item or box, from search_inventory"),
        locationId: z.string().min(1).optional().describe("The place, from list_locations"),
      }),
      annotations: write,
    },
    async ({ code, ...target }) =>
      run(async () => {
        if (Boolean(target.itemId) === Boolean(target.locationId)) throw new HTTPException(422, { message: "Give an itemId or a locationId" });
        const done = await attachLabel(v, code, target);
        return "label" in done ? { label: done.label.code, on: done.label.item?.name ?? done.label.location?.path } : { ownLabel: done.ownLabel.code };
      }),
  );

  // ── Adding and changing by kind: save_* (no id: add one; with id: change it) ──────────────────────────────────
  // One tool per kind of thing keeps the list short; removing is the one `remove` tool, so only it is destructive.
  const idOf = (what: string, from: string) => z.string().min(1).optional().describe(`The ${what} to change, from ${from}; leave out to add a new one`);

  server.registerTool(
    "save_property",
    {
      title: "Add or change a property",
      description:
        "Adds a property — a home, vacation home, rental, storage unit or vehicle, the top level of where things are kept — or, with id, changes one (rename, kind, address, year built, value, notes). To add: only name is needed (type defaults to home); check list_locations first so you don't add one twice. To change: fields left out stay as they are; null clears one. Rooms, closets and shelves inside it are save_location. Returns the property with its id.",
      inputSchema: propertyPatch.extend({ id: idOf("property", "list_locations") }),
      annotations: write,
    },
    async ({ id, ...fields }) =>
      run(async () => {
        const saved = id ? await svc.updateProperty(v, id, parseAs(propertyPatch, fields, "change a property")) : await svc.createProperty(v, parseAs(propertyInput, fields, "add a property"));
        return compact({ ...saved, householdId: undefined });
      }),
  );

  server.registerTool(
    "save_location",
    {
      title: "Add or change a location",
      description:
        "Adds a location — a room, closet or shelf — to a property, or, with id, renames one or moves it inside another location of the same property (everything kept there moves with it). To add: name, optionally parentId (inside another location) and children to make inside it in one go — \"a garage with three shelves\" is name \"Garage\", children [\"Shelf 1\", \"Shelf 2\", \"Shelf 3\"]; propertyId can be left out when there's only one property. Check list_locations first so you don't add one twice. A new property is save_property. Returns the location (and any children) with ids and paths.",
      inputSchema: locationPatch.extend({
        id: idOf("location", "list_locations"),
        propertyId: z.string().min(1).optional().describe("To add: the property, from list_locations; can be left out when there's only one"),
        children: z.array(z.string().trim().min(1).max(120)).max(50).optional().describe('To add: names of locations to make inside it in one go, ["Shelf 1", "Shelf 2"]'),
      }),
      annotations: write,
    },
    async ({ id, propertyId, children = [], ...fields }) =>
      run(async () => {
        if (id) {
          const updated = await svc.updateLocation(v, id, parseAs(locationPatch, fields, "change a location"));
          return compact({ id: updated.id, name: updated.name, path: (await svc.locationPaths(v)).get(updated.id), notes: updated.notes });
        }
        const property = propertyId ?? (await onlyProperty(v));
        const created = await svc.createLocation(v, parseAs(locationInput, { ...fields, propertyId: property }, "add a location"));
        const nested = [];
        for (const name of children) nested.push(await svc.createLocation(v, { propertyId: property, parentId: created.id, name }));
        const paths = await svc.locationPaths(v);
        return compact({ id: created.id, path: paths.get(created.id), children: nested.length ? nested.map((l) => ({ id: l.id, path: paths.get(l.id) })) : undefined });
      }),
  );

  server.registerTool(
    "save_maintenance",
    {
      title: "Add or change a maintenance task",
      description:
        "Adds upkeep to track — on an item (itemId), a place (locationId) or the whole household — or, with id, changes a task (title, notes, how often, what it's on, who does it, its part, or dueOn to reschedule; that also re-opens a finished one-off). To add: title, plus intervalCount + intervalUnit for something that repeats (\"every 3 months\") or neither for a one-off; dueOn defaults to one interval from today. By use (\"every 5,000 miles\"): usageEvery, on an item with a usageUnit and a reading (record_reading) — it can have a time interval too, whichever comes first. Check list_maintenance first so you don't add it twice. Not for recording that it was done: that's complete_maintenance. Returns the task with its due date.",
      inputSchema: maintenancePatch.safeExtend({
        id: idOf("task", "list_maintenance"),
        attachmentId: maintenanceInput.shape.attachmentId,
      }),
      annotations: write,
    },
    async ({ id, ...fields }) =>
      run(async () =>
        taskView(id ? await upkeep.updateTask(v, id, parseAs(maintenancePatch, fields, "change a task")) : await upkeep.createTask(v, parseAs(maintenanceInput, fields, "add a task"))),
      ),
  );

  server.registerTool(
    "save_warranty",
    {
      title: "Add or change a warranty",
      description:
        "Records a warranty on an item — who stands behind it, when cover starts and ends, what it covers — or, with id, changes one (it was extended, a date was wrong). To add: itemId and endsOn; use it when the person tells you about one, or to accept a warranty the vision model read off a receipt or warranty card (get_item's suggestions) once the person has confirmed it — pass that document's id as attachmentId. Check get_item first so you don't add one twice. To change: fields left out stay as they are; null clears one. A warranty can't end before it starts. Warranties ending within 30 days show in what_needs_attention. Returns the warranty with its id and status.",
      inputSchema: warrantyPatch.extend({
        id: idOf("warranty", "get_item or list_warranties"),
        itemId: z.string().min(1).optional().describe("To add: the item's id, from search_inventory"),
      }),
      annotations: write,
    },
    async ({ id, itemId, ...fields }) =>
      run(async () => {
        if (id) return warrantyView(await warranties.updateWarranty(v, id, parseAs(warrantyPatch, fields, "change a warranty")));
        if (!itemId) throw new HTTPException(422, { message: "To add a warranty, give the item's itemId" });
        return warrantyView(await warranties.createWarranty(v, itemId, parseAs(warrantyInput, fields, "add a warranty")));
      }),
  );

  server.registerTool(
    "save_repair",
    {
      title: "Log or change a repair",
      description:
        "Records a repair of an item — a one-off fix, not scheduled maintenance: when (repairedOn), what was done (work), what went wrong (problem), who did it (providerId, from list_providers), parts, what it cost (cents) — or, with id, changes one. warrantyEndsOn adds a warranty on the repair to the item's warranties; taskId links it to a maintenance task of that item. Repairs count in the item's cost of ownership (get_item's cost). Use it when the person says something was fixed (\"the plumber replaced the water heater's thermostat, $180\"). Returns the repair with its id.",
      inputSchema: repairPatch.extend({
        id: idOf("repair", "get_item"),
        itemId: z.string().min(1).optional().describe("To log one: the item's id, from search_inventory"),
        warrantyEndsOn: repairInput.shape.warrantyEndsOn,
      }),
      annotations: write,
    },
    async ({ id, itemId, ...fields }) =>
      run(async () => {
        const view = (r: Awaited<ReturnType<typeof repairs.getRepair>>) => compact({ ...r, itemId: undefined, attachmentIds: r.attachmentIds.length ? r.attachmentIds : undefined });
        if (id) {
          const { warrantyEndsOn: _w, ...patch } = fields;
          return view(await repairs.updateRepair(v, id, parseAs(repairPatch, patch, "change a repair")));
        }
        if (!itemId) throw new HTTPException(422, { message: "To log a repair, give the item's itemId" });
        return view(await repairs.createRepair(v, itemId, parseAs(repairInput, fields, "log a repair")));
      }),
  );

  server.registerTool(
    "save_warranty_claim",
    {
      title: "File or update a warranty claim",
      description:
        "Records a claim under one of an item's warranties — what went wrong, the provider's claim number (reference), its status (filed by default, today by default) — or, with id, updates one when the person hears back: status (filed, in_progress, approved, denied, resolved), the resolution, what it cost (cents). To file: warrantyId (from get_item) and the problem. Closing it (denied or resolved) dates it today unless resolvedOn is given. Claims with no news for two weeks show in what_needs_attention. Returns the claim with its id.",
      inputSchema: claimPatch.extend({
        id: idOf("claim", "get_item"),
        warrantyId: z.string().min(1).optional().describe("To file: the warranty's id, from get_item"),
      }),
      annotations: write,
    },
    async ({ id, warrantyId, ...fields }) =>
      run(async () => {
        if (id) return compact(await claims.updateClaim(v, id, parseAs(claimPatch, fields, "update a claim")));
        if (!warrantyId) throw new HTTPException(422, { message: "To file a claim, give the warranty's warrantyId" });
        return compact(await claims.fileClaim(v, warrantyId, parseAs(claimInput, fields, "file a claim")));
      }),
  );

  server.registerTool(
    "save_loan",
    {
      title: "Lend, borrow, or change a loan",
      description:
        "Records that one of the household's items was lent to someone (direction \"lent\") or that something was borrowed from them (\"borrowed\"), optionally with a due-back date — or, with id, changes an open loan (who has it, when it's due back, the note, the borrower's email and how often they're reminded). To add: itemId (from search_inventory), direction and person; an item has one open loan at a time. For it coming back use return_loan. Returns the loan with its id and due date.",
      inputSchema: loanPatch.extend({
        id: idOf("loan", "list_loans"),
        itemId: z.string().min(1).optional().describe("To add: the item's id, from search_inventory"),
        direction: loanInput.shape.direction.optional().describe('To add: "lent" (the household\'s thing is with someone) or "borrowed" (someone else\'s thing is here)'),
      }),
      annotations: write,
    },
    async ({ id, itemId, direction, ...fields }) =>
      run(async () => {
        if (id) return compact(await loans.updateLoan(v, v.files, id, parseAs(loanPatch, fields, "change a loan")));
        if (!itemId) throw new HTTPException(422, { message: "To record a loan, give the item's itemId" });
        return compact(await loans.createLoan(v, v.files, itemId, parseAs(loanInput, { ...fields, direction }, "record a loan")));
      }),
  );

  server.registerTool(
    "return_loan",
    {
      title: "It's back",
      description:
        "Closes a loan: a lent thing is back, or a borrowed one was given back. Use it when the person says so (\"Sam returned the ladder\"); the id comes from list_loans. The loan stays in the item's history and the borrower's reminder emails stop; nothing else about the item changes. Calling it again for the same loan is refused (it's already back).",
      inputSchema: z.object({
        id: z.string().min(1).describe("The loan's id, from list_loans"),
        on: z.iso.date().optional().describe("The day it came back, yyyy-mm-dd; today if left out"),
      }),
      annotations: write,
    },
    async ({ id, on }) => run(async () => compact(await loans.returnLoan(v, id, on))),
  );

  server.registerTool(
    "save_provider",
    {
      title: "Add or change a service provider",
      description:
        "Adds a service provider — a plumber, the HVAC company, an electrician — with their trade and contact details, or, with id, changes one (a new phone number, a different contact). To add: name; check list_providers first so you don't add one twice, then use its id as providerId on save_maintenance or complete_maintenance. To change: fields left out stay as they are; null clears one. Returns the provider with its id.",
      inputSchema: providerPatch.extend({ id: idOf("provider", "list_providers") }),
      annotations: write,
    },
    async ({ id, ...fields }) =>
      run(async () => compact(id ? await providers.updateProvider(v, id, parseAs(providerPatch, fields, "change a provider")) : await providers.createProvider(v, parseAs(providerInput, fields, "add a provider")))),
  );

  server.registerTool(
    "save_category",
    {
      title: "Add or change a category",
      description:
        "Adds a category, optionally inside another one (parentId) — \"Power tools\" under \"Tools\" — or, with id, renames one or moves it under another parent (null: top level). To add: name; check list_categories first so you don't add one twice, then use its id as categoryId on create_item, update_item or bulk_update_items. Returns the category with its id.",
      inputSchema: z.object({
        id: idOf("category", "list_categories"),
        name: categoryInput.shape.name.optional(),
        parentId: categoryInput.shape.parentId,
        lifespanYears: categoryInput.shape.lifespanYears,
      }),
      annotations: write,
    },
    async ({ id, ...fields }) =>
      run(async () => {
        const saved = id ? await catalog.updateCategory(v, id, parseAs(categoryPatch, fields, "change a category")) : await catalog.createCategory(v, parseAs(categoryInput, fields, "add a category"));
        return compact({ ...saved, householdId: undefined, photoId: undefined });
      }),
  );

  server.registerTool(
    "save_collection",
    {
      title: "Start or change a collection",
      description:
        "Starts a collection — coins, records, trading cards, LEGO sets — optionally of one kind of thing (templateId, from list_templates) whose fields become its columns, or, with id, renames one or changes its description or kind. To add: name; check list_collections first so you don't start one twice. Then add things to it with create_item (collectionId; wanted: true for its want list) or update_item. Returns the collection with its id.",
      inputSchema: collectionPatch.extend({ id: idOf("collection", "list_collections") }),
      annotations: write,
    },
    async ({ id, ...fields }) =>
      run(async () => {
        const saved = id ? await collections.updateCollection(v, id, parseAs(collectionPatch, fields, "change a collection")) : await collections.createCollection(v, parseAs(collectionInput, fields, "start a collection"));
        return compact({ ...saved, householdId: undefined });
      }),
  );

  server.registerTool(
    "save_coverage_limit",
    {
      title: "Set an insurance limit",
      description:
        "Records what an insurance policy pays at most — for everything (scope all), one category (jewelry, electronics…) or one tag — optionally for one property, so coverage_check can say when the things it covers are worth more. Without id it adds a limit; with id it replaces that limit (send every field). Amounts in cents. Check coverage_check first so you don't add one twice. Returns the limit with its id.",
      inputSchema: coverageInput.safeExtend({ id: z.string().min(1).optional().describe("A limit to replace, from coverage_check; leave out to add a new one") }),
      annotations: write,
    },
    async ({ id, ...input }) => run(async () => compact(id ? await updateCoverage(v, id, input) : await addCoverage(v, input))),
  );

  // ── Removing ──────────────────────────────────────────────────────────────
  server.registerTool(
    "remove",
    {
      title: "Remove something",
      description: `Removes one thing from the household's records, by kind and id. Confirm with the person first. What each kind does:
- item: only when it was added by mistake or should be gone from the records — for something sold, given away, donated, thrown out, lost or stolen use update_item with disposition, which keeps it for insurance. It stays in Recently deleted for ${TRASH_DAYS} days (restore_item brings it back), then goes for good with its photos and documents.
- warranty: one added by mistake or twice (an ended warranty stays on record as expired); its claims go with it. claim: a warranty claim filed by mistake.
- maintenance: a task no longer needed — not one just done (that's complete_maintenance); its past times done stay in the item's history. repair: one logged by mistake (its photos and warranty stay the item's).
- property / location: only when empty (no things anywhere in it, empty rooms inside go with it); otherwise refused — move the things first with bulk_update_items.
- file: a photo or document (an item's from get_item, a property's, place's or task's from list_files).
- category: its things and subcategories move up to its parent. provider: their past visits stay, without the name. collection: its owned things stay (out of the collection); its want-list entries go. coverage_limit: a limit that no longer applies.
Only remove (item) can be undone. Returns what was removed.`,
      inputSchema: z.object({
        kind: z
          .enum(["item", "file", "warranty", "claim", "maintenance", "repair", "property", "location", "category", "provider", "collection", "coverage_limit"])
          .describe("What it is"),
        id: z.string().min(1).describe("Its id, from the tool that lists that kind (search_inventory, get_item, list_maintenance, list_locations…)"),
      }),
      annotations: { ...write, destructiveHint: true },
    },
    async ({ kind, id }) =>
      run(async () => {
        const remove: Record<typeof kind, () => Promise<unknown>> = {
          item: () => svc.deleteItem(v, id),
          file: () => removeFile(v, id),
          warranty: () => warranties.deleteWarranty(v, id),
          claim: () => claims.deleteClaim(v, id),
          maintenance: () => upkeep.deleteTask(v, id),
          repair: () => repairs.deleteRepair(v, id),
          property: () => svc.deleteProperty(v, id),
          location: () => svc.deleteLocation(v, id),
          category: () => catalog.deleteCategory(v, id),
          provider: () => providers.deleteProvider(v, id),
          collection: () => collections.deleteCollection(v, id),
          coverage_limit: () => deleteCoverage(v, id),
        };
        const done = (await remove[kind]()) as { name?: string } | undefined;
        return compact({ removed: kind, id, name: done?.name, restore: kind === "item" ? `restore_item within ${TRASH_DAYS} days` : undefined });
      }),
  );

  return server;
}

/** A save_* tool's fields checked against the schema the REST route uses — the full one to add, the patch to change. */
function parseAs<T>(schema: z.ZodType<T>, data: unknown, doing: string): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new HTTPException(422, { message: `To ${doing}: ${issue?.path.length ? `${issue.path.join(".")} — ` : ""}${issue?.message ?? "invalid input"}` });
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

/** A warranty as Claude sees it: no bookkeeping. */
function warrantyView<T extends object>(w: T) {
  return compact({ ...w, householdId: undefined, deletedAt: undefined });
}

/** Up to this many pixels on the long side for a "large" photo: what Claude reads best. */
const LARGE_PX = 1568;
/** Above this, an original isn't sent as it is (Claude takes images up to 5 MB, and base64 adds a third). */
const MAX_IMAGE_BYTES = 3_500_000;
const SENDABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** The bytes to show for an attachment: its thumbnail, or a large copy of a photo made from the original. */
async function photoBytes(v: McpCaller, row: typeof attachment.$inferSelect, size: "small" | "large") {
  const thumbnail = async () => {
    if (!row.thumbnailKey) return null;
    const bytes = await v.files.get(row.householdId, row.thumbnailKey);
    return bytes && { bytes, type: sniffContentType(bytes) ?? "image/webp" };
  };
  if (size === "small" || row.kind !== "photo" || row.originalRemovedAt) return thumbnail();
  const original = await v.files.get(row.householdId, row.blobKey);
  if (!original) return thumbnail();
  const resized = await v.deps.images?.resize(original, LARGE_PX, "webp");
  if (resized) return { bytes: resized, type: "image/webp" };
  if (original.length <= MAX_IMAGE_BYTES && SENDABLE.has(row.contentType)) return { bytes: original, type: row.contentType };
  return thumbnail();
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
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
      : "There are no properties yet — add one with save_property first",
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
