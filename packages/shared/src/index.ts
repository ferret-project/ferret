/**
 * Shared contracts used by the server (REST + MCP) and the web app.
 * One definition of "what an item is" for every client.
 */
import { z } from "zod";
import {
  type AiFillKind,
  aiFillKinds,
  categoryFieldTypes,
  isAmazonSite,
  isCurrency,
  isTimeZone,
  type ClaimStatus,
  claimStatuses,
  type SightingHow,
  type SightingKind,
  itemConditions,
  propertyTypes,
  intervalUnits,
  type MaintenanceStatus,
  type MissingDetail,
  missingDetails,
  NOTIFICATION_SERVICES,
  type UsageUnit,
  usageUnits,
  type WarrantyStatus,
} from "./utils";

export * from "./utils";


const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
/** Money is stored as integer cents to avoid float rounding. */
const cents = z.number().int().nonnegative().optional().nullable();

// ── Properties (a home, cabin, storage unit…) ───────────────────────────────
const propertyFields = z.object({
  name: z.string().trim().min(1).max(120).describe('What the household calls it: "Home", "Lake cabin", "Storage unit 12"'),
  type: z.enum(propertyTypes).describe("What kind of property it is"),
  street: optionalText(200).describe("Street address (used for its map picture, if maps are on)"),
  city: optionalText(120).describe("Town or city"),
  region: optionalText(120).describe("State, province or region"),
  postalCode: optionalText(20).describe("ZIP or postal code"),
  country: optionalText(80).describe("Country name"),
  yearBuilt: z.number().int().min(1600).max(2200).optional().nullable().describe("The year the building was built"),
  valueCents: cents.describe("What the property itself is worth, in cents (not its contents)"),
  notes: optionalText(5000).describe("Anything else worth keeping about it"),
});
export const propertyInput = propertyFields.extend({ type: propertyFields.shape.type.default("home") });
export type PropertyInput = z.infer<typeof propertyInput>;
/** Only the fields sent change (no defaults, or a rename would reset the type). */
export const propertyPatch = propertyFields.partial();
export type PropertyPatch = z.infer<typeof propertyPatch>;

// ── Locations (rooms, closets, shelves — nested via parentId) ───────────────
export const locationInput = z.object({
  propertyId: z.string().min(1).describe("The property it's in, from list_locations"),
  parentId: z.string().min(1).optional().nullable().describe("The location it's inside (a shelf in a closet), from list_locations; null: directly in the property"),
  name: z.string().trim().min(1).max(120).describe('What the household calls it: "Garage", "Hall closet", "Top shelf"'),
  icon: optionalText(64).describe("An icon name for the app (optional)"),
  notes: optionalText(5000).describe("Anything else worth keeping about it"),
});
export type LocationInput = z.infer<typeof locationInput>;
/** Rename or move a location within its property. */
export const locationPatch = locationInput.omit({ propertyId: true }).partial();
export type LocationPatch = z.infer<typeof locationPatch>;

// ── Categories and tags ─────────────────────────────────────────────────────
/** An extra field a category's items fill in, e.g. a TV's "Screen size" (number, "in"). */
export const categoryField = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(60),
  type: z.enum(categoryFieldTypes),
  /** For "choice": the options. */
  options: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  /** Shown after a number, e.g. "in". */
  unit: z.string().trim().max(12).optional(),
});
export type CategoryField = z.infer<typeof categoryField>;
export type CustomFieldValues = Record<string, string | number>;

// ── Collections: coins, dolls, cards — kept as a set, with a want list ──────────────────────────────────
export const collectionInput = z.object({
  name: z.string().trim().min(1).max(80).describe('The collection\'s name: "US quarters", "Vinyl records"'),
  description: optionalText(2000).describe("What it is, what's being looked for"),
  /** Its kind of thing: the template whose fields are its columns (and new things in it start from). */
  templateId: z.string().min(1).nullable().optional().describe("The kind of thing in it, from list_templates: its fields are the collection's columns"),
});
export type CollectionInput = z.infer<typeof collectionInput>;
export const collectionPatch = collectionInput.partial();
export type CollectionPatch = z.infer<typeof collectionPatch>;

export interface CollectionSummary {
  id: string;
  name: string;
  description: string | null;
  templateId: string | null;
  /** Things owned (and how many pieces, counting quantities: duplicates). */
  owned: number;
  pieces: number;
  /** On the want list. */
  wanted: number;
  /** What the owned ones are worth (value, else price paid, × quantity), and cost. */
  valueCents: number;
  costCents: number;
  /** A photo to show it by (its most valuable thing's). */
  photoId: string | null;
}

// ── Item templates: a kind of thing with its own fields (coins, trading cards, dolls…) ───────────────────────
const templateFields = z.object({
  name: z.string().trim().min(1).max(80),
  icon: optionalText(64),
  fields: z.array(categoryField).max(30),
  /** What things made from it start in, and with. */
  categoryId: z.string().min(1).nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10),
});
export const templateInput = templateFields.partial({ icon: true, categoryId: true, tags: true });
export type TemplateInput = z.infer<typeof templateInput>;
export const templatePatch = templateFields.partial();
export type TemplatePatch = z.infer<typeof templatePatch>;

export interface ItemTemplate {
  id: string;
  name: string;
  icon: string | null;
  fields: CategoryField[];
  categoryId: string | null;
  tags: string[];
  /** How many things are made from it. */
  itemCount: number;
}

const categoryFields = z.object({
  name: z.string().trim().min(1).max(80).describe('The category\'s name: "Power tools", "Kitchen appliances"'),
  parentId: z.string().min(1).nullable().describe("The category it's inside, from list_categories; null or left out: top level"),
  icon: optionalText(64).describe("An icon name for the app (optional)"),
  fields: z.array(categoryField).max(20).describe('Extra fields its items fill in, e.g. a TV\'s screen size: { key: "screen_size", label: "Screen size", type: "number", unit: "in" }'),
  lifespanYears: z.number().int().min(1).max(100).optional().nullable().describe("How many years its things usually last (overrides the typical lifespans Ferret knows), for the replacement forecast"),
});
export const categoryInput = categoryFields.partial({ parentId: true, icon: true, fields: true });
export type CategoryInput = z.infer<typeof categoryInput>;
export const categoryPatch = categoryFields.partial();
export type CategoryPatch = z.infer<typeof categoryPatch>;

export interface CategoryNode {
  id: string;
  name: string;
  icon: string | null;
  /** "Electronics › TV" */
  path: string;
  /** Its own fields; an item also gets its ancestors' (see `inheritedFields`). */
  fields: CategoryField[];
  /** How long its things usually last, if the household set it (else the typical lifespans apply). */
  lifespanYears: number | null;
  /** Items in this category itself (not counting subcategories). */
  itemCount: number;
  /** A photo of something in it (or in a subcategory), for its tile. */
  photoId: string | null;
  children: CategoryNode[];
}

export interface TagSummary {
  id: string;
  name: string;
  items: number;
}

const tagName = z.string().trim().min(1).max(40);

// ── Items ───────────────────────────────────────────────────────────────────
/**
 * A web link on an item — the maker's product page, the manual online, the support site, a printer's admin page.
 * http(s) only (no javascript: or data:); any host, LAN ones included. Ferret never fetches it.
 */
export const itemLink = z.object({
  url: z.url({ protocol: /^https?$/, error: "Use a web address starting with https:// (or http://)" }).max(2000),
  label: optionalText(80),
});
export type ItemLink = z.infer<typeof itemLink>;

/** What happened to something you no longer have. */
export const itemDispositions = ["sold", "given", "donated", "discarded", "lost", "stolen"] as const;
export type ItemDisposition = (typeof itemDispositions)[number];

/** Where a thing came from. The first five are the app's own ways to add one (it says which); the rest are set by the server. */
export const itemOrigins = ["app", "photos", "walkthrough", "roomscan", "scan", "label", "spreadsheet", "homeassistant", "claude", "api"] as const;
export type ItemOrigin = (typeof itemOrigins)[number];
export const appOrigins = ["app", "photos", "walkthrough", "scan", "label"] as const;

const itemFields = z.object({
  name: z.string().trim().min(1).max(200).describe('What it is, the way people would look for it: "Cordless drill"'),
  description: optionalText(5000).describe("A longer description: colour, size, what it's for"),
  brand: optionalText(120).describe("Who made it"),
  model: optionalText(120).describe("Model name or number, as on its label"),
  serialNumber: optionalText(120).describe("Its serial number, for warranty claims and insurance"),
  barcode: optionalText(64).describe("Its UPC/EAN barcode (also learned into the household's barcode book)"),
  quantity: z.number().int().min(0).describe("How many there are; to count stock up or down, adjust_stock logs the change"),
  minQuantity: z.number().int().min(0).max(100000).optional().nullable().describe("Keep at least this many: at or below it, it goes on the shopping list"),
  usageUnit: z.enum(usageUnits).optional().nullable().describe("What its counter measures, for maintenance by use (a car's miles, a mower's hours)"),
  condition: z.enum(itemConditions).optional().nullable().describe("What shape it's in"),
  purchaseDate: z.iso.date().optional().nullable().describe("When it was bought, yyyy-mm-dd"),
  returnBy: z.iso.date().optional().nullable().describe("The last day the store takes it back, yyyy-mm-dd — what_needs_attention says so the week before"),
  purchasePriceCents: cents.describe("What was paid for one, in cents (12999 = $129.99)"),
  valueCents: cents.describe("What one is worth now, in cents — used for the insurance report"),
  notes: optionalText(10000).describe("Anything else worth keeping: where the spare key is, quirks, settings"),
  favorite: z.boolean().describe("Starred, to find quickly in the app"),
  heir: optionalText(120).describe("Who should have it one day"),
  isContainer: z.boolean().describe("A box, bin or case that holds other items (they set containerItemId to it)"),
  locationId: z.string().min(1).optional().nullable().describe("Where it's kept: a location id from list_locations (null: nowhere in particular)"),
  containerItemId: z.string().min(1).optional().nullable().describe("The box it's in: an item id with isContainer; it's then wherever the box is"),
  partOfItemId: z
    .string()
    .min(1)
    .optional()
    .nullable()
    .describe("The thing this is a part or supply for (an item id): bags for a dust collector, filters for a furnace — listed on that thing's page under Parts & supplies. Put the part number in model"),
  categoryId: z.string().min(1).optional().nullable().describe("A category id from list_categories"),
  tags: z.array(tagName).max(30).describe("Tag names; new ones are created. When updating, the full new list"),
  customFields: z
    .record(z.string(), z.union([z.string().max(500), z.number()]))
    .optional()
    .nullable()
    .describe("Values for its category's or template's extra fields, by their keys (list_categories shows them)"),
  templateId: z.string().min(1).optional().nullable().describe("The item template it's made from (list_categories), whose fields it then has"),
  collectionId: z.string().min(1).optional().nullable().describe("The collection it's part of (list_collections)"),
  wanted: z.boolean().describe("On the want list: not owned yet — left out of totals, the report, stock and search unless asked for"),
  links: z.array(itemLink).max(10).optional().nullable().describe("Web links: the maker's page, the manual online… When updating, the full new list"),
  disposition: z
    .enum(itemDispositions)
    .optional()
    .nullable()
    .describe("No longer had: sold, given (away), donated (to a charity), discarded, lost or stolen (null: still have it). Gone items leave lists and totals"),
  disposedOn: z.iso.date().optional().nullable().describe("When it went, yyyy-mm-dd"),
  disposalCents: cents.describe("What it sold for, what insurance paid, or (donated) what it was worth when given, in cents"),
  disposedTo: optionalText(200).describe("Who it went to: the charity or organisation for a donation"),
  disposalNote: optionalText(2000).describe("Who it went to, or what happened (for a lost or stolen claim)"),
  replacementCents: cents.describe("What it would cost to replace today, in cents (for the insurance report)"),
  lifespanYears: z.number().int().min(1).max(100).optional().nullable().describe("How many years this one should last, if not its category's or the typical lifespan — for the replacement forecast"),
  replacedById: z.string().min(1).optional().nullable().describe("What replaced it, once it's gone: the new item's id — both pages link the other"),
});
export const itemInput = itemFields.extend({
  origin: z.enum(appOrigins).optional().describe("Which of the app's ways added it; ignored for Claude and API keys (recorded by the server)"),
  quantity: itemFields.shape.quantity.default(1),
  favorite: itemFields.shape.favorite.default(false),
  isContainer: itemFields.shape.isContainer.default(false),
  tags: itemFields.shape.tags.default([]),
  wanted: itemFields.shape.wanted.default(false),
});
export type ItemInput = z.infer<typeof itemInput>;
/** Only the fields sent change (no defaults here, or a rename would reset the quantity). */
export const itemPatch = itemFields.partial();
export type ItemPatch = z.infer<typeof itemPatch>;

/** The orders a list can come in: last changed (the default), name, value, when bought, when added. */
export const itemSorts = ["updated", "name", "value", "bought", "added", "scanned", "seen"] as const;
export type ItemSort = (typeof itemSorts)[number];

export const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  /** Exact barcode lookup (what a scanner returns, e.g. an EAN-13). */
  barcode: z.string().trim().min(1).max(64).optional(),
  locationId: z.string().optional(),
  missing: z.enum(missingDetails).optional(),
  /** This category and its subcategories. */
  categoryId: z.string().optional(),
  /** Items with this tag (by name, any case). */
  tag: z.string().trim().max(40).optional(),
  /** What's directly inside this box. */
  containerItemId: z.string().optional(),
  /** "true": leave out things inside boxes (a room shows its boxes, not every box's contents). */
  topLevel: z.enum(["true", "false"]).optional(),
  /** "true": only boxes (for "put it in a box"). */
  boxes: z.enum(["true", "false"]).optional(),
  /** "only": things you no longer have (sold, given away, lost…) — otherwise they're left out. */
  gone: z.enum(["only"]).optional(),
  /** What's in this collection. */
  collectionId: z.string().optional(),
  /** The want list: "include" it with what's owned, or "only" it — otherwise wanted things are left out. */
  wanted: z.enum(["include", "only"]).optional(),
  /** Things added this way (app, photos, walkthrough, scan, label, spreadsheet, homeassistant, claude, api). */
  origin: z.enum(itemOrigins).optional(),
  /** Not scanned since this day (yyyy-mm-dd) — never scanned counts: "what hasn't been seen in a year?" */
  notScannedSince: z.iso.date().optional(),
  /** Not seen since this day (yyyy-mm-dd): no scan, "Still here" or room review since, and added before it. */
  notSeenSince: z.iso.date().optional(),
  /** "only": things nobody can find (marked "Can't find it", not yet found or given up as lost). */
  misplaced: z.enum(["only"]).optional(),
  /** Worth (value, else price paid) at least / at most this many cents. */
  minWorth: z.coerce.number().int().min(0).optional(),
  maxWorth: z.coerce.number().int().min(0).optional(),
  /** Bought on or after / on or before this day (yyyy-mm-dd). */
  boughtFrom: z.iso.date().optional(),
  boughtTo: z.iso.date().optional(),
  /**
   * Lists (not searches): "category" folds every category with at least `FOLD_AT` matching things into one row
   * (`folded`, listed before the things on the first pages) — never the category being filtered by.
   */
  fold: z.enum(["category"]).optional(),
  /** Lists (not searches): the order — last changed (default), name, value, when bought, when added, last scanned, last seen. */
  sort: z.enum(itemSorts).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  /** Searches: "later" answers at once with the sure matches (and `checking`); "now" (default) checks the maybe-matches first. */
  judge: z.enum(["now", "later"]).optional(),
  /** Searches: "exclude" leaves out what documents say (manuals, receipts) — only the things themselves and their photos. */
  documents: z.enum(["include", "exclude"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuery>;

// ── Warranties ──────────────────────────────────────────────────────────────
const warrantyFields = {
  provider: optionalText(120).describe('Who stands behind it: "Bosch", "Best Buy Geek Squad"'),
  startsOn: z.iso.date().optional().nullable().describe("When cover began, yyyy-mm-dd (usually the purchase date)"),
  endsOn: z.iso.date().describe("When cover ends, yyyy-mm-dd"),
  coverage: optionalText(2000).describe('What it covers: "parts and labour", "accidental damage"'),
  /** The document it came from (receipt, warranty card), if any. */
  attachmentId: z.string().min(1).optional().nullable().describe("The receipt or warranty card it came from: a document's id from get_item"),
  notes: optionalText(5000).describe("Anything else: how to claim, the registration number"),
};
export const warrantyInput = z
  .object(warrantyFields)
  .refine((w) => !w.startsOn || w.startsOn <= w.endsOn, { message: "A warranty can't end before it starts", path: ["endsOn"] });
export type WarrantyInput = z.infer<typeof warrantyInput>;
export const warrantyPatch = z.object({ ...warrantyFields, endsOn: warrantyFields.endsOn.optional() });
export type WarrantyPatch = z.infer<typeof warrantyPatch>;

export interface Warranty extends WarrantyInput {
  id: string;
  householdId: string;
  itemId: string;
  status: WarrantyStatus;
  createdAt: string;
}

// ── Repairs ─────────────────────────────────────────────────────────────────
const repairFields = {
  repairedOn: z.iso.date().describe("When it was repaired, yyyy-mm-dd"),
  work: z.string().trim().min(1).max(300).describe('What was done: "Replaced the drain pump"'),
  problem: optionalText(2000).describe('What went wrong: "Wouldn\'t drain, error E21"'),
  providerId: z.string().min(1).optional().nullable().describe("Who did it, if not you: a service provider's id (list_providers)"),
  parts: optionalText(1000).describe('Parts used: "Drain pump 00436440"'),
  costCents: z.number().int().min(0).max(1_000_000_000).optional().nullable().describe("What it cost, in cents (parts and labour)"),
  taskId: z.string().min(1).optional().nullable().describe("The maintenance task it was part of, if any (its id from list_maintenance)"),
};
export const repairInput = z.object({
  ...repairFields,
  /** A warranty on the repair itself: added as a warranty of the item (from the repair day to `endsOn`). */
  warrantyEndsOn: z.iso.date().optional().nullable().describe("If the repair has its own warranty: when it ends, yyyy-mm-dd — added to the item's warranties"),
});
export type RepairInput = z.infer<typeof repairInput>;
export const repairPatch = z.object(repairFields).partial();
export type RepairPatch = z.infer<typeof repairPatch>;

export interface Repair {
  id: string;
  itemId: string;
  repairedOn: string;
  work: string;
  problem: string | null;
  providerId: string | null;
  /** The provider's name, for showing. */
  providerName: string | null;
  parts: string | null;
  costCents: number | null;
  warrantyId: string | null;
  /** The repair warranty's end, while it exists. */
  warrantyEndsOn: string | null;
  taskId: string | null;
  taskTitle: string | null;
  /** Who logged it. */
  by: string | null;
  /** Photos and documents of it (attachments of the item with this repairId). */
  attachmentIds: string[];
  createdAt: string;
}

/** What owning a thing has cost (GET /items/:id/cost): paid, maintenance, repairs, less what it sold for. */
export interface OwnershipCost {
  /** What was paid (× quantity), if known. */
  paidCents: number | null;
  maintenanceCents: number;
  /** Done maintenance with a cost. */
  maintenanceTimes: number;
  repairCents: number;
  repairs: number;
  /** What it sold for (or insurance paid), once gone. */
  backCents: number | null;
  totalCents: number;
  /** Years owned so far (or until it went), at least one. */
  years: number;
  perYearCents: number;
  /** When owning it began: bought, or added. */
  since: string;
}

// ── Service providers ───────────────────────────────────────────────────────
const providerFields = z.object({
  name: z.string().trim().min(1).max(120).describe('The business or person: "Acme Heating & Air"'),
  trade: optionalText(60).describe('What they do: "Plumber", "HVAC", "Appliance repair"'),
  contactName: optionalText(120).describe("Who to ask for"),
  phone: optionalText(40).describe("Phone number, as they give it"),
  email: z.email().max(200).optional().nullable().or(z.literal("").transform(() => null)).describe("Email address"),
  website: optionalText(300).describe("Their website"),
  address: optionalText(300).describe("Their business address"),
  notes: optionalText(5000).describe("Anything worth remembering: rates, who to ask for, what they did well"),
});
export const providerInput = providerFields;
export type ProviderInput = z.infer<typeof providerInput>;
export const providerPatch = providerFields.partial();
export type ProviderPatch = z.infer<typeof providerPatch>;

export interface Provider extends ProviderInput {
  id: string;
  /** Maintenance tasks they usually do. */
  tasks: number;
  /** Times they did a job, the last one, and what was spent with them. */
  visits: number;
  lastVisit: string | null;
  spentCents: number;
}

/** A job a provider did: a maintenance log entry. */
export interface ProviderVisit {
  id: string;
  doneOn: string;
  taskId: string;
  taskTitle: string;
  itemId: string | null;
  itemName: string | null;
  note: string | null;
  costCents: number | null;
}

// ── Maintenance ─────────────────────────────────────────────────────────────
const interval = {
  intervalCount: z.number().int().min(1).max(1000).optional().nullable().describe('Repeats every this many intervalUnits ("every 3 months": 3); leave both out for a one-off'),
  intervalUnit: z.enum(intervalUnits).optional().nullable().describe("The unit of intervalCount"),
};
const bothOrNeither = (t: { intervalCount?: number | null; intervalUnit?: string | null }) =>
  t.intervalCount == null || t.intervalUnit != null;

export const maintenanceInput = z
  .object({
    title: z.string().trim().min(1).max(200).describe('What to do: "Replace furnace filter", "Clean gutters"'),
    notes: optionalText(5000).describe("How to do it: the part number, steps, what to watch for"),
    itemId: z.string().min(1).optional().nullable().describe("The item it's for (search_inventory); leave out for a place or the whole household"),
    locationId: z.string().min(1).optional().nullable().describe('The place it\'s for, e.g. "Clean gutters" on the roof (list_locations)'),
    ...interval,
    dueOn: z.iso.date().optional().describe("When it's next due, yyyy-mm-dd; defaults to one interval from today (today for a one-off)"),
    attachmentId: z.string().min(1).optional().nullable().describe("The manual it came from: a document's id from get_item"),
    providerId: z.string().min(1).optional().nullable().describe("Who usually does it, from list_providers"),
    partItemId: z.string().min(1).optional().nullable().describe("The consumable it uses (a filter item): marking it done takes partQuantity out of stock"),
    partQuantity: z.number().int().min(1).max(1000).optional().describe("How many of the part each time (default 1)"),
    usageEvery: z.number().int().min(1).max(10_000_000).optional().nullable().describe('Also (or only) due every this much use, in the item\'s usageUnit ("every 5,000 miles": 5000). Needs itemId'),
    suggestionId: z.string().min(1).optional().describe("The suggested maintenance it was added from (list_maintenance's suggestions), so it leaves that list"),
  })
  .refine(bothOrNeither, { message: "Say how often: a number and a unit", path: ["intervalUnit"] })
  .refine((t) => !t.usageEvery || t.itemId, { message: "Maintenance by use needs the thing it's on", path: ["usageEvery"] });
export type MaintenanceInput = z.infer<typeof maintenanceInput>;

export const maintenancePatch = z
  .object({
    title: z.string().trim().min(1).max(200).describe("What to do"),
    notes: optionalText(5000).describe("How to do it: the part number, steps, what to watch for"),
    itemId: z.string().min(1).nullable().describe("The item it's for (search_inventory); null: not on an item"),
    locationId: z.string().min(1).nullable().describe("The place it's for (list_locations); null: not on a place"),
    providerId: z.string().min(1).nullable().describe("Who usually does it, from list_providers; null: the household"),
    partItemId: z.string().min(1).nullable().describe("The consumable it uses (a filter item); null: none"),
    partQuantity: z.number().int().min(1).max(1000).describe("How many of the part each time"),
    ...interval,
    usageEvery: z.number().int().min(1).max(10_000_000).nullable().describe("Due every this much use, in the item's usageUnit; null: not by use"),
    /** Reschedule: when it's next due (also re-opens a finished one-off). */
    dueOn: z.iso.date().describe("Reschedule: when it's next due, yyyy-mm-dd (also re-opens a finished one-off)"),
  })
  .partial()
  .refine(bothOrNeither, { message: "Say how often: a number and a unit", path: ["intervalUnit"] });
export type MaintenancePatch = z.infer<typeof maintenancePatch>;

export const maintenanceDone = z.object({
  doneOn: z.iso.date().optional().describe("When it was done, yyyy-mm-dd; today if left out. The next due date counts from this day"),
  note: optionalText(2000).describe("Anything worth remembering about this time"),
  costCents: cents.describe("What it cost this time, in cents"),
  providerId: z.string().min(1).optional().nullable().describe("Who did it this time (list_providers); left out: the task's usual provider; null: the household"),
  usePart: z.boolean().optional().describe("Take the task's part out of stock (default true; false when an old one was cleaned instead)"),
  reading: z.number().min(0).max(1_000_000_000).optional().describe("Maintenance by use: what the item's counter says now; the next one is due usageEvery after it"),
});
export type MaintenanceDone = z.infer<typeof maintenanceDone>;

export interface MaintenanceTask {
  id: string;
  title: string;
  notes: string | null;
  itemId: string | null;
  itemName: string | null;
  locationId: string | null;
  /** Where: the item's place, or the task's own location. */
  place: string | null;
  intervalCount: number | null;
  intervalUnit: (typeof intervalUnits)[number] | null;
  dueOn: string | null;
  lastDoneOn: string | null;
  attachmentId: string | null;
  providerId: string | null;
  providerName: string | null;
  /**
   * The consumable it uses: how many each time (`uses`), how many are in stock (`left`), and `shortOn` — the first
   * time it's due (or expected to be) without enough left, counting the other tasks that use it, within a year.
   */
  part: { itemId: string; name: string; uses: number; left: number; shortOn: string | null } | null;
  status: MaintenanceStatus;
  /** Due by time alone (`dueOn` may be sooner: by use). */
  timeDueOn: string | null;
  /** Maintenance by use: every `usageEvery` of the item's `unit`, next at `dueAt`; `now` is its latest reading. */
  usage: { every: number; dueAt: number; unit: UsageUnit; now: number | null; perDay: number | null } | null;
  /** `dueOn` is an estimate from how fast the item's used (not a calendar date). */
  dueEstimated: boolean;
}

// ── Readings (maintenance by use) ───────────────────────────────────────────
export const usageReadingInput = z.object({
  value: z.number().min(0).max(1_000_000_000).describe("What the counter says now, in the item's usageUnit"),
  readOn: z.iso.date().optional().describe("When it was read, yyyy-mm-dd; today if left out"),
  note: optionalText(200).describe("Anything worth noting with the reading"),
});
export type UsageReadingInput = z.infer<typeof usageReadingInput>;

export interface UsageReading {
  id: string;
  value: number;
  readOn: string;
  note: string | null;
  by: string | null;
}

export interface UsageSummary {
  unit: UsageUnit | null;
  /** Newest first. */
  readings: UsageReading[];
  now: number | null;
  /** How fast it goes up, per day (from the last year's readings); null until there are two a week apart. */
  perDay: number | null;
}

export interface MaintenanceLogEntry {
  id: string;
  doneOn: string;
  doneByName: string | null;
  providerName: string | null;
  note: string | null;
  costCents: number | null;
}

// ── Warranty claims ─────────────────────────────────────────────────────────
/** Still waiting on the provider. */
export const openClaimStatuses: readonly ClaimStatus[] = ["filed", "in_progress", "approved"];

const claimFields = z.object({
  filedOn: z.iso.date().describe("When the claim was made, yyyy-mm-dd; today if left out"),
  problem: z.string().trim().min(1).max(2000).describe("What went wrong, in the person's words"),
  reference: optionalText(120).describe("The provider's claim or case number"),
  status: z.enum(claimStatuses).describe("Where it stands: filed, in_progress, approved, denied or resolved"),
  resolution: optionalText(2000).describe("How it ended: repaired, replaced, refunded…"),
  resolvedOn: z.iso.date().optional().nullable().describe("When it was closed, yyyy-mm-dd"),
  costCents: cents.describe("What the household paid out of pocket, in cents"),
  notes: optionalText(5000).describe("Anything else: calls made, who said what"),
});
export const claimInput = claimFields.partial({ filedOn: true, status: true });
export type ClaimInput = z.infer<typeof claimInput>;
export const claimPatch = claimFields.partial();
export type ClaimPatch = z.infer<typeof claimPatch>;

export interface WarrantyClaim {
  id: string;
  warrantyId: string;
  itemId: string;
  itemName: string;
  warrantyProvider: string | null;
  filedOn: string;
  problem: string;
  reference: string | null;
  status: ClaimStatus;
  resolution: string | null;
  resolvedOn: string | null;
  costCents: number | null;
  notes: string | null;
}

// ── Attachments (photos and documents on an item) ───────────────────────────
export const attachmentKinds = ["photo", "document"] as const;
export type AttachmentKind = (typeof attachmentKinds)[number];

/** Upload types we accept, by kind. Also usable as an <input accept> list. */
export const uploadTypes: Record<AttachmentKind, readonly string[]> = {
  photo: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif", "image/gif"],
  document: ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"],
};

/** What the vision model saw in a photo or scanned document. Suggestions are only ever applied by a person. */
export interface AttachmentAnalysis {
  /** One sentence, e.g. "Yellow DeWalt cordless drill with a battery pack." */
  description: string;
  /** All legible text, verbatim ("" if none) — for search. */
  text: string;
  suggestions: AttachmentSuggestions;
}

/** Item fields the model could fill in. Only fields it was confident about are present. */
export type AttachmentSuggestions = Partial<
  Pick<ItemInput, "name" | "brand" | "model" | "serialNumber" | "barcode" | "purchaseDate" | "purchasePriceCents" | "returnBy">
> & {
  /** From receipts: how many days the store takes it back (the return-by date is then the purchase date + this). */
  returnDays?: number;
  /** From warranty cards and manuals: how long it lasts, and who provides it. */
  warrantyMonths?: number;
  warrantyProvider?: string;
  /** From manuals: upkeep to repeat, e.g. "Clean the filter" every 3 months. */
  maintenance?: { title: string; intervalCount: number; intervalUnit: (typeof intervalUnits)[number] }[];
  /** From manuals: replacement parts and supplies with their part numbers — suggested under the item's Parts & supplies. */
  parts?: SuggestedPartReading[];
  /** The fields the model said it read plainly off the file (not inferred) — the only ones the AI may fill in by itself. */
  sure?: string[];
};

/** One of a thing's parts or supplies (Parts & supplies on its page): an item of the household's. */
export interface ItemPart {
  id: string;
  name: string;
  brand: string | null;
  /** Its part number. */
  model: string | null;
  quantity: number;
  minQuantity: number | null;
  /** At or below what's kept: it's on the shopping list. */
  low: boolean;
  photoId: string | null;
  place: string | null;
  /** Where to buy it: its first link that isn't an Amazon product. */
  link: { url: string; label?: string | null } | null;
  /** Its Amazon product: one in the cart. */
  amazonCart: string | null;
  /** Without one: a search on the household's Amazon for its part number. */
  amazonSearch: string | null;
  /** The maintenance task on this thing that uses it, if that's how it's linked. */
  task: string | null;
}

/** A part one of the thing's manuals lists that it doesn't have yet — tap to add it. */
export interface SuggestedPart extends SuggestedPartReading {
  attachmentId: string;
  filename: string;
}

export interface ItemParts {
  parts: ItemPart[];
  suggested: SuggestedPart[];
}

export const dismissPartInput = z.object({
  attachmentId: z.string().min(1).describe("The document that suggested it"),
  partNumber: z.string().trim().min(1).max(60).describe("Its part number, as suggested"),
});

/** A part a manual lists: "Drum collection bag", 717531, 5 to a package. */
export interface SuggestedPartReading {
  name: string;
  partNumber: string;
  packSize?: number;
}

/** null = not analysed (not configured, or not an image). */
export type AnalysisStatus = "pending" | "done" | "failed" | null;

export interface Attachment {
  id: string;
  householdId: string;
  itemId: string;
  kind: AttachmentKind;
  filename: string;
  contentType: string;
  size: number;
  analysisStatus: AnalysisStatus;
  analysis: AttachmentAnalysis | null;
  suggestionsDismissedAt: string | null;
  createdAt: string;
  /** A small picture exists (`/attachments/:id/thumbnail`): a photo's, or a PDF's first page. */
  hasThumbnail: boolean;
  /** Only the small picture is kept: the original was removed to free space (`/content` then serves the small one). */
  originalRemoved: boolean;
  /** When it was made the item's main photo (its picture in lists); photos come newest choice first. */
  mainAt: string | null;
  /** A repair's photo or invoice (lib/repairs.ts). */
  repairId?: string | null;
}

// ── API response shapes ─────────────────────────────────────────────────────
export interface Item extends Omit<ItemInput, "origin"> {
  id: string;
  householdId: string;
  createdAt: string;
  updatedAt: string;
  /** Where it came from (null: from before Ferret kept track, and the history didn't say). */
  origin: ItemOrigin | null;
  /** The spreadsheet's file name, the API key's name… */
  originDetail: string | null;
  /** One item's page (GET /items/:id): who added it. */
  addedBy?: string | null;
  /** Found in a room scan: its photos are at /room-scans/:id. */
  roomScanId?: string | null;
  /** Fields the AI filled in by itself, until a person confirms or edits them (by field: "brand", "warranty"…). */
  aiFilled?: Record<string, AiFill> | null;
  /** The AI's latest replacement-cost estimate — a suggestion; `replacementCents` is what a person set. */
  replacementEstimate?: { cents: number; reasoning: string; at: string } | null;
  /** Since when nobody can find it ("Can't find it"): cleared when it's found, or given up as lost. */
  missingSince?: string | null;
}

export interface Paged<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Why an item matched a search: its words, or (semantic search) its meaning — maybe inside a document. */
export interface SearchHit {
  via: "words" | "meaning";
  /** Embedding similarity (0–1). */
  score?: number;
  /** Reranker relevance (0–1), when a reranker is configured. */
  relevance?: number;
  /** For matches inside a document: which one, and the passage that matched. */
  attachmentId?: string;
  filename?: string;
  snippet?: string;
}

// ── Ask Ferret: answers from your own inventory, with sources ───────────────
export const askInput = z.object({ question: z.string().trim().min(3).max(500) });
export type AskInput = z.infer<typeof askInput>;

export interface AskCitation {
  itemId: string;
  itemName: string;
  /** Set when the answer came from inside a document. */
  attachmentId?: string;
  filename?: string;
}

export interface AskAnswer {
  answer: string;
  /** False when the inventory doesn't say — the answer then explains that rather than guessing. */
  found: boolean;
  citations: AskCitation[];
}

// ── Searching inside one item ───────────────────────────────────────────────
/** Words to find in one item's own text: its documents, what its photos say, its warranties and notes. */
export const itemFindQuery = z.object({ q: z.string().trim().min(1).max(200) });

/** A passage of one item's text that has the words searched for. */
export interface ItemPassage {
  /** Where it's from: a document, a photo's text, a warranty, or the item's own description and notes. */
  source: "document" | "photo" | "warranty" | "item";
  /** The file's name, the warranty's provider, or "Description" / "Notes". */
  label: string;
  /** The document's section it's in ("8.2 Cleaning and bag inspection"), when it has headings. */
  heading?: string;
  attachmentId?: string;
  warrantyId?: string;
  /** A short window around the first match ("…" where it's cut). */
  snippet: string;
  /** Where the matched words are in the snippet: [start, end) character offsets. */
  marks: [number, number][];
  /** The whole passage, to show when it's opened. */
  text: string;
}

export interface ItemFindResult {
  passages: ItemPassage[];
  /** How many passages matched (more than listed when there are many). */
  total: number;
}

/** An item as lists show it: plus a photo to recognise it by and where it's kept. */
export interface ItemListing extends Item {
  /** The box it's in, if any. */
  container: { id: string; name: string } | null;
  /** For boxes: how many things are directly inside. */
  contents: number;
  /** Its QR label's code, if it has one. */
  labelCode: string | null;
  /** On an item's own page (GET /items/:id): labels people brought — asset tags, stickers from elsewhere. */
  ownLabels?: OwnLabel[];
  /** "Electronics › TV" */
  category: string | null;
  /** The first photo, for a thumbnail (`/attachments/:id/thumbnail`). */
  photoId: string | null;
  /** "Highland House › Garage › Shelf 2" */
  place: string | null;
  /** Lent out (or borrowed) right now. */
  loan: { direction: LoanDirection; person: string; since: string; dueOn: string | null } | null;
  /** When its QR label or barcode was last scanned to it, by whom (their name), and how. */
  lastScanned: { at: string; by: string | null; how: SightingHow } | null;
  /** One item's page (GET /items/:id): what replaced it, and what it replaced. */
  replacedBy?: { id: string; name: string } | null;
  replaces?: { id: string; name: string }[];
  /** One item's page (GET /items/:id): how long it should last and when it's likely due (null: no lifespan known). */
  lifespan?: ItemLifespan | null;
  /** When it was last seen at all (scanned, "Still here", a room review), by whom, which way — null if never. */
  lastSeen: { at: string; by: string | null; kind: SightingKind; how: SightingHow } | null;
}

/** Every property with its locations as a tree (`GET /locations/tree`). */
export interface LocationNode {
  id: string;
  name: string;
  path: string;
  /** Items kept right here (not counting nested locations). */
  itemCount: number;
  /** What those items are worth (value, else price paid, × quantity), in cents. */
  valueCents: number;
  /** Items here and in every place nested inside it. */
  totalCount: number;
  /** What all of those are worth, in cents. */
  totalValueCents: number;
  children: LocationNode[];
}
export interface PlacesTree {
  properties: {
    id: string;
    name: string;
    type: (typeof propertyTypes)[number];
    /** Address, year built, value, notes. */
    details: Pick<PropertyInput, "street" | "city" | "region" | "postalCode" | "country" | "yearBuilt" | "valueCents" | "notes">;
    locations: LocationNode[];
  }[];
  unplacedItems: number;
  /** Map pictures of addresses are switched on (GET /properties/:id/map). */
  maps: boolean;
}

export interface ItemSearch extends Paged<ItemListing> {
  /** For lists (not searches): what every matching item is worth, in cents. */
  valueCents?: number;
  /** Present for searches (`q`): why each item matched. */
  hits?: Record<string, SearchHit>;
  /**
   * Searches asked with `judge=later`: how many maybe-matches are left out for now — ask again with `judge=now` for the
   * checked answer (the chat model decides which of them are what was meant).
   */
  checking?: number;
  /** Lists asked with `fold=category`: this page's folded categories (before its things). */
  folded?: FoldedCategory[];
  /** Lists asked with `fold=category`: rows to page through — folded categories + the things not in them. */
  rows?: number;
}

/** How many matching things a category needs before a folded list shows it as one row. */
export const FOLD_AT = 10;

/** A category shown as one row in a folded list. */
export interface FoldedCategory {
  categoryId: string;
  name: string;
  /** "3D printing › Filament". */
  path: string;
  /** Matching things in it (not its subcategories). */
  count: number;
  valueCents: number;
  /** A few of its things' first photos. */
  photoIds: string[];
}

// ── Households: roles and invitations ───────────────────────────────────────
/** viewer = can look and ask, but not change anything. Owners and admins manage members. */
export const householdRoles = ["owner", "admin", "member", "viewer"] as const;
export type HouseholdRole = (typeof householdRoles)[number];

/** What an invitation link shows before (and after) signing in. */
export interface InvitationPreview {
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  householdName: string;
  inviterName: string;
}

// ── Overview (the dashboard) ────────────────────────────────────────────────
export interface ValueGroup {
  name: string;
  valueCents: number;
  items: number;
  itemsWithoutValue: number;
}

export interface Overview {
  /** Value = current value, or else purchase price, times quantity. */
  total: Omit<ValueGroup, "name">;
  properties: number;
  locations: number;
  byProperty: ValueGroup[];
  /** `locationId`: the room (absent for "Not placed"). */
  byRoom: (ValueGroup & { locationId?: string })[];
  /** By top-level category — what an insurer asks for. */
  byCategory: ValueGroup[];
  mostValuable: { id: string; name: string; valueCents: number }[];
  /** The value of what's here now, by the month it came in (bought, else added) — oldest first; a running total is "worth over time". */
  byMonth: { month: string; valueCents: number }[];
  /** Ending within 60 days, or ended in the last 30. */
  warranties: (Pick<Warranty, "id" | "itemId" | "provider" | "endsOn" | "status"> & { itemName: string })[];
  missing: Record<MissingDetail, number>;
  /** Warranty claims still waiting on the provider. */
  openClaims: WarrantyClaim[];
  /** Open tasks: how many are overdue or due within 14 days, and the next few. */
  maintenance: { overdue: number; due: number; next: MaintenanceTask[] };
  activity: { id: string; action: string; summary: string | null; via: string; actorName: string | null; entityType: string; entityId: string; /** The item it's about, if it still exists. */ itemId: string | null; createdAt: string }[];
  /** Running low: how many things to buy, how many have run out, and the first few. */
  shopping: { count: number; out: number; next: ShoppingItem[] };
  /** Keeping track (lib/room-reviews.ts): things not seen in a year, things nobody can find, and the room checked longest ago. */
  tracking: TrackingSummary;
  /** Replacement forecast (lib/lifespans.ts): past their typical life, and the next five years. */
  replacements: { past: ForecastYear; years: ForecastYear[] };
}

// ── Lifespans and the replacement forecast ──────────────────────────────────
/**
 * How long a thing should last and when it's likely due for replacement — an estimate, never advice to replace it.
 * `source`: this thing's own lifespan, its category's (`from`: the category), or the typical one for its kind (`from`:
 * "refrigerator").
 */
export interface ItemLifespan {
  years: number;
  source: "item" | "category" | "typical";
  from: string | null;
  /** For a typical lifespan: its key in TYPICAL_LIFESPANS ("refrigerator"). */
  kind?: string;
  /** When its life started: bought (purchaseDate) or, not knowing that, added to Ferret. */
  since: string;
  sinceFrom: "bought" | "added";
  /** The year it's likely due: since + years. */
  dueYear: number;
  /** Already past its typical life. */
  past: boolean;
  /** What replacing it might cost (× quantity): today's replacement cost if set, else what was paid, else its value. */
  costCents: number | null;
  costFrom: "replacement" | "price" | "value" | null;
}

export interface ForecastYear {
  year: number;
  /** Things due (that year, or for `past`: already past their typical life). */
  items: number;
  /** What replacing them might cost, of those with a price. */
  cents: number;
  /** Of those, how many have no price to go by. */
  unpriced: number;
}

/** GET /replacements: things with a lifespan, by the year they're likely due. */
export interface ReplacementForecast {
  past: ForecastYear;
  years: ForecastYear[];
  items: (Pick<ItemListing, "id" | "name" | "place" | "photoId" | "quantity"> & { lifespan: ItemLifespan })[];
  /** Things Ferret has no lifespan for (no override, category or typical match), not counting boxes. */
  unknown: number;
}

// ── Last seen, room reviews, can't find ─────────────────────────────────────
export interface TrackingSummary {
  /** Things added more than a year ago and not seen (scanned, "Still here", a room review) since. */
  notSeenYear: number;
  /** Things marked "Can't find it". */
  misplaced: number;
  /** The place with things in it that was reviewed longest ago (never reviewed first, the fullest of those first). */
  nextRoom: RoomToReview | null;
}

export interface RoomToReview {
  locationId: string;
  /** "Highland House › Garage" */
  path: string;
  /** Things kept right there (in boxes there too). */
  items: number;
  /** When its last room review was finished — null if it never was. */
  reviewedAt: string | null;
  /** A review started and not finished: how far it got. */
  open: { done: number; startedAt: string } | null;
}

export const reviewOutcomes = ["here", "moved", "gone", "missing"] as const;
export type ReviewOutcome = (typeof reviewOutcomes)[number];

export const reviewItemBody = z.object({
  outcome: z.enum(reviewOutcomes),
  /** "moved": where to. */
  locationId: z.string().optional(),
});

/** A room review (GET /room-reviews/:locationId): what's there, and what's been checked. */
export interface RoomReview {
  locationId: string;
  path: string;
  /** The review under way (null: none started — POST starts one). */
  review: { id: string; startedAt: string; startedBy: string | null } | null;
  /** When the last one was finished. */
  reviewedAt: string | null;
  /** Not yet checked in this review: what's in the room, boxes with how many things in them, loose things. */
  toCheck: ItemListing[];
  /** Checked in this review, newest first. */
  checked: (ItemListing & { outcome: ReviewOutcome; checkedAt: string })[];
  /** Places inside this one that have things in them (each reviewed on its own). */
  inside: { locationId: string; name: string; items: number }[];
}

// ── Insurance export ────────────────────────────────────────────────────────
/** One item as the insurance export lists it (CSV columns and the printable report). */
export interface ExportRow {
  id: string;
  /** Only in a lost-or-stolen export: what happened, and when. */
  disposition?: ItemDisposition | null;
  disposedOn?: string | null;
  name: string;
  /** "Highland House › Garage › Shelf 2" */
  place: string | null;
  box: string | null;
  category: string | null;
  tags: string[];
  brand: string | null | undefined;
  model: string | null | undefined;
  serialNumber: string | null | undefined;
  quantity: number;
  condition: string | null | undefined;
  purchaseDate: string | null | undefined;
  purchasePriceCents: number | null | undefined;
  valueCents: number | null | undefined;
  /** Value (or price paid) × quantity. */
  totalValueCents: number | null;
  /** What replacing one new would cost (set by a person — maybe from the AI's estimate). */
  replacementCents?: number | null;
  photos: number;
  documents: number;
  /** For the report's thumbnail. */
  photoId: string | null;
  /** Latest warranty end date. */
  warrantyEnds: string | null;
  description: string | null | undefined;
  notes: string | null | undefined;
}

// ── Barcode → product (a product database such as UPCitemdb) ───────────────
/** What a product database knows about a barcode. */
export interface ProductInfo {
  barcode: string;
  title: string;
  brand?: string;
  model?: string;
  description?: string;
  /** The database's own category path, e.g. "Electronics > Audio > Headphones". */
  category?: string;
  images: string[];
  /** Median of current store prices (outliers happen), and the range ever recorded, in cents. */
  typicalPriceCents?: number;
  lowestPriceCents?: number;
  highestPriceCents?: number;
  source: string;
}

/** What Ferret knows about a scanned barcode: from its own barcode book, or the online database. */
export interface BarcodeMatch {
  barcode: string;
  name: string;
  brand?: string | null;
  model?: string | null;
  /** "ferret": someone saved an item with it; "upcitemdb": from the online database. */
  source: "ferret" | "upcitemdb";
  /** From the online database, when it was asked. */
  images: string[];
  typicalPriceCents?: number;
  category?: string;
}

/** An item's product suggestions from its barcode. */
export interface ItemProduct {
  /** off: no product database configured; none: nothing known about this barcode (or no barcode). */
  status: "off" | "none" | "pending" | "found" | "dismissed";
  product?: ProductInfo;
}

// ── QR labels (boxes, shelves) ─────────────────────────────────────────────
/** Exactly one of itemId / locationId. */
export const labelTarget = z
  .object({ itemId: z.string().min(1).optional(), locationId: z.string().min(1).optional() })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.locationId), { message: "Give an itemId or a locationId" });
export type LabelTarget = z.infer<typeof labelTarget>;

/** A label someone brought (an asset tag, a sticker from elsewhere) on an item: scanning it opens the item. */
export interface OwnLabel {
  id: string;
  /** As scanned (product codes as 13-digit EAN). */
  code: string;
}

export const attachLabelInput = z
  .object({ code: z.string().trim().min(1).max(500), itemId: z.string().min(1).optional(), locationId: z.string().min(1).optional() })
  .refine((t) => Boolean(t.itemId) !== Boolean(t.locationId), { message: "Give an itemId or a locationId" });
export type AttachLabelInput = z.infer<typeof attachLabelInput>;

export interface Label {
  code: string;
  householdId: string;
  /** What it opens; neither = a blank label waiting to be stuck on something. */
  item: { id: string; name: string; isContainer: boolean } | null;
  location: { id: string; path: string } | null;
}

// ── Needs attention (the bell) ──────────────────────────────────────────────
/** Something to act on now; it disappears once it's dealt with (no read/unread state). */
export interface AttentionItem {
  kind: "maintenance" | "warranty" | "return" | "claim" | "review" | "roomscan" | "backup" | "shopping" | "loan" | "recall" | "coverage" | "service" | "ai" | "seen";
  /** urgent: overdue / today; soon: coming up or waiting. */
  severity: "urgent" | "soon";
  /** The thing it's about (task, warranty, claim or item id; a backup's run id). */
  id: string;
  title: string;
  detail: string;
  /** The item to open, if there is one (maintenance on a place has none). */
  itemId: string | null;
  /** When it's due / ends / was filed (yyyy-mm-dd), for sorting. */
  date: string | null;
  /** Where in the app it's dealt with, when that isn't the item or its kind's screen (`#/…`). */
  href?: string;
}

// ── Room scans: photograph a room, the vision model lists what's in it ──────
export const roomScanStatuses = ["pending", "ready", "failed", "done"] as const;
export type RoomScanStatus = (typeof roomScanStatuses)[number];

/** Something found in a room photo (or added by hand in the review). */
export interface RoomScanCandidate {
  name: string;
  /** The household's category the model chose, if any. */
  categoryId: string | null;
  quantity: number;
  /** Which photo (0-based). */
  photo: number;
  /** Where in the photo, as fractions of its width and height — [left, top, width, height]; null when the model gave none. */
  box: [number, number, number, number] | null;
}

export interface RoomScan {
  id: string;
  status: RoomScanStatus;
  /** Where what's found goes: a room, or a box. */
  locationId: string | null;
  containerItemId: string | null;
  /** "Highland House › Garage", or the box's name. */
  placeName: string | null;
  photos: number;
  candidates: RoomScanCandidate[];
  error: string | null;
  by: string | null;
  createdAt: string;
  /** Once done: the items made from it. */
  items: { id: string; name: string }[];
}

export const roomScanCommit = z.object({
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        categoryId: z.string().min(1).nullable().optional(),
        quantity: z.number().int().min(1).max(10000).default(1),
      }),
    )
    .min(1)
    .max(200),
});
export type RoomScanCommit = z.input<typeof roomScanCommit>;

// ── Stock: scan to count ────────────────────────────────────────────────────
/** What scanning a code does to its item: open it, take some out, put some in, or ask. */
export const stockBehaviours = ["lookup", "use", "restock", "ask"] as const;
export type StockBehaviour = (typeof stockBehaviours)[number];
/**
 * The scanner's switch: each code as it's set up (auto), or the same for every scan this session. "add" is scanning
 * from + Add: a code something already has asks "you have this — add 1?" (`have`) rather than making a duplicate.
 */
export const scanModes = ["auto", "lookup", "use", "restock", "add"] as const;
export type ScanMode = (typeof scanModes)[number];

export const stockAdjust = z.object({
  delta: z
    .number()
    .int()
    .min(-10000)
    .max(10000)
    .refine((d) => d !== 0, "Must change the count"),
  note: z.string().trim().max(200).optional().nullable(),
});
export type StockAdjust = z.infer<typeof stockAdjust>;

export const stockRuleInput = z.object({
  /** A barcode as scanned, or a Ferret QR label (its code or its /l/ address). */
  code: z.string().trim().min(1).max(500),
  behaviour: z.enum(stockBehaviours),
  /** How many one scan takes out or puts in. */
  step: z.number().int().min(1).max(1000).default(1),
});
export type StockRuleInput = z.input<typeof stockRuleInput>;

export const scanInput = z.object({
  code: z.string().trim().min(1).max(500),
  mode: z.enum(scanModes).default("auto"),
  /** Which item, when the code is on several (from a "choose" answer). */
  itemId: z.string().min(1).optional(),
  /** A scan made offline (the phone's own id for it): sent again, it changes the count only once. */
  clientId: z.uuid().optional(),
});
export type ScanInput = z.input<typeof scanInput>;

export interface StockRule {
  id: string;
  /** As stored: 13-digit EAN, label:<CODE>, or as scanned. */
  code: string;
  /** For people: "Barcode 0012345678905", "QR label K7QM2X". */
  label: string;
  behaviour: StockBehaviour;
  step: number;
}

export interface StockMovement {
  id: string;
  delta: number;
  quantityAfter: number;
  reason: "scan" | "manual" | "edit" | "undo" | "maintenance";
  note: string | null;
  by: string | null;
  via: string;
  undone: boolean;
  at: string;
}

export interface StockSummary {
  quantity: number;
  rules: StockRule[];
  movements: StockMovement[];
}

/** An item a scan could mean. */
export interface ScanCandidate {
  id: string;
  name: string;
  place: string | null;
  quantity: number;
  /** Marked "Can't find it": scanning it is a good moment to say it's found. */
  missing?: true;
}

/** Something to buy: a tracked item that's run out, or is at or below what's kept. */
export interface ShoppingItem {
  id: string;
  name: string;
  place: string | null;
  quantity: number;
  /** "Keep at least", if set. */
  minQuantity: number | null;
  /** A suggestion: a restock barcode's pack size, else enough to be above the minimum (at least 1). */
  buy: number;
  /** Needed for maintenance coming up: "Replace furnace filter, due Nov 3". */
  forTask: string | null;
  /** Its first photo, for a thumbnail. */
  photoId: string | null;
  /** What one cost (the price paid, else its value) — the list's rough total. */
  unitCents: number | null;
  /** Its Amazon product, from its links (an imported order's "On Amazon") — to put it in the cart again. */
  amazon: { site: string; asin: string } | null;
  /** Without an Amazon product: a search on Amazon for its part/model number (else barcode, else name) — amazonSearchUrl. */
  amazonSearch: string | null;
}

export interface ShoppingList {
  items: ShoppingItem[];
  /** The list as plain text, to copy or share. */
  text: string;
}

/** What a scan did, or needs to know first. */
export type ScanResult =
  /** Open it (a look-up, or the code's set to). A QR label that isn't on an item opens its label page (#/l/CODE). */
  | { action: "open"; item?: ScanCandidate; label?: string }
  /** Its count changed: `applied` can be less than asked when there weren't enough left. */
  | { action: "adjusted"; item: ScanCandidate; delta: number; applied: number; movementId: string | null; repeat?: boolean }
  /** The code is on several items: which one? (the last chosen first) */
  | { action: "choose"; behaviour: StockBehaviour; step: number; items: ScanCandidate[] }
  /** Set to "ask": take some out, put some in, or open it. */
  | { action: "ask"; item: ScanCandidate; step: number }
  /**
   * Scanning to add (mode "add") a code you already have: add `step` to one of these (scan again with its `itemId` and
   * mode "restock"), or add it as a separate item. The last scanned first.
   */
  | { action: "have"; code: string; step: number; items: ScanCandidate[] }
  /** A HomeKit or Matter pairing code nobody's saved yet: which item is it for? */
  | { action: "pairing"; kind: "homekit" | "matter"; category: string | null }
  /** Nothing here has this code. */
  | { action: "unknown"; code: string };

// ── Smart-home pairing codes (HomeKit, Matter) ──────────────────────────────
export const pairingInput = z.object({
  /** X-HM://…, MT:…, or the code as printed (123-45-678 / 3497-011-2332). */
  code: z.string().trim().min(1).max(500),
  label: z.string().trim().max(80).optional().nullable(),
});
export type PairingInput = z.input<typeof pairingInput>;

/** A pairing code as listed: everything but the code itself (that's shown on request). */
export interface PairingCodeSummary {
  id: string;
  kind: "homekit" | "matter";
  label: string | null;
  category: string | null;
  /** The QR's text is kept: it can be shown as a QR again. */
  hasQr: boolean;
  addedAt: string;
}

/** A pairing code, shown. */
export interface PairingCodeRevealed {
  code: string;
  payload: string | null;
  details: Record<string, string | number>;
}

// ── Backups (the whole server's: the server admin — its first account — looks after them) ──
export interface BackupRun {
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  /** Encrypted database copy, bytes. */
  dbBytes: number | null;
  /** Files the backup holds, and how many were new this time. */
  files: number | null;
  filesCopied: number | null;
  filesBytes: number | null;
  /** What the restore check found. */
  checked: string | null;
  error: string | null;
}

/** Hands the server admin (who looks after backups) to another account. */
export const serverAdminInput = z.object({ email: z.email().max(200) });

/** One nightly copy kept in the backup folder. */
export interface BackupSnapshot {
  name: string;
  createdAt: string;
  items: number;
  files: number;
  filesBytes: number;
}

/** Settings → Server: PUBLIC_URL, and whether it was set (unset: sign-ins work from any address Ferret is opened at, but links use this). */
export interface ServerAddress {
  set: boolean;
  publicUrl: string;
}

/** Settings → Server's keys: where each secret Ferret needs came from — never a secret itself (bar the push public key). */
export interface ServerSecrets {
  /** The data folder's secrets.json, where the ones Ferret made are kept. */
  file: string | null;
  secrets: { name: "FILES_KEY" | "AUTH_SECRET" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY"; source: "settings" | "ferret" | "none" }[];
  /** The push public key browsers subscribe with (public by design), or null without push. */
  pushPublicKey: string | null;
}

export interface BackupStatus {
  /** False until BACKUP_DIR is set. */
  enabled: boolean;
  /** The backup folder, as the server sees it. */
  where: string | null;
  /** Hour of the day backups start (server time), and how many nightly copies are kept. */
  hour: number;
  keep: number;
  /** The newest run, and the newest that worked (often the same). */
  last: BackupRun | null;
  lastOk: BackupRun | null;
  /** Backups made outside this server instead (Deps.backupElsewhere): where, and its newest run. */
  elsewhere: { where: string; at: string | null; ok: boolean | null; detail: string | null } | null;
  /** FILES_KEY's fingerprint (household_key.kek_id; `cli.js key fingerprint`) — never the key itself. */
  keyId: string;
  /** The newest key file made with `cli.js key export`, and whether it holds the key in use now. */
  keyFile: { at: string; keyId: string; where: string; current: boolean } | null;
}

// ── API keys (for Claude via MCP, and scripts) ─────────────────────────────
export const apiKeyInput = z.object({
  name: z.string().trim().min(1).max(60),
  /** Can look things up and ask questions, but not change anything. */
  readOnly: z.boolean().default(false),
  /** Omit (or null) for a key that never expires. */
  expiresInDays: z.number().int().min(1).max(365).optional().nullable(),
});
export type ApiKeyInput = z.infer<typeof apiKeyInput>;

/** A key as listed in Settings — never the key itself, only its first characters. */
export interface ApiKeySummary {
  id: string;
  name: string | null;
  /** e.g. "ferret_AbC" — enough to tell keys apart. */
  start: string | null;
  readOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Returned once, when a key is made. */
export interface NewApiKey extends ApiKeySummary {
  key: string;
}

// ── Notifications to other apps (ntfy, Pushover, Telegram… through Apprise) ──
/** An Apprise URL: `scheme://…`, e.g. ntfys://ntfy.sh/my-topic or pover://user@token. */
export const notificationChannelInput = z.object({
  name: z.string().trim().min(1).max(60),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, "Use an Apprise URL like ntfys://ntfy.sh/your-topic")
    .refine((url) => url.slice(0, url.indexOf("://")).toLowerCase() in NOTIFICATION_SERVICES, {
      message: "Ferret can send to ntfy, Pushover, Telegram, email, Discord, Slack, Home Assistant and a few more — not that kind of URL",
    }),
});
export type NotificationChannelInput = z.infer<typeof notificationChannelInput>;

/** A channel as listed in Settings — never its URL (it holds tokens), only the service it goes to. */
export interface NotificationChannel {
  id: string;
  name: string;
  /** The URL's scheme, e.g. "ntfys", "pover", "tgram". */
  service: string;
  createdAt: string;
  /** The last day a reminder went out. */
  lastNotifiedOn: string | null;
  /** Why the last send failed (cleared when one works). */
  lastError: string | null;
}

// ── Add from a web address ──────────────────────────────────────────────────
/** A photo or document for the server to download (public internet only). No kind: it goes by what arrives. */
export const downloadInput = z.object({
  url: z.url({ protocol: /^https?$/, error: "Use a web address starting with https:// (or http://)" }).max(2000),
  kind: z.enum(["photo", "document"]).optional(),
});
export type DownloadInput = z.infer<typeof downloadInput>;

/** A download that's waiting, or failed (a finished one is just an attachment). */
export interface PendingDownload {
  id: string;
  url: string;
  status: "pending" | "failed";
  error: string | null;
  createdAt: string;
}

// ── Recently deleted ────────────────────────────────────────────────────────
/** An item in "Recently deleted". */
export interface DeletedItem {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  deletedAt: string;
  /** The day it goes for good (yyyy-mm-dd). */
  purgesOn: string;
  /** Who deleted it, when the activity log knows. */
  deletedBy: string | null;
  /** The first photo, for a thumbnail. */
  photoId: string | null;
}

// ── Security (Settings → Security) ─────────────────────────────────────────
/** A signed-in browser or device. */
export interface SessionSummary {
  id: string;
  /** The session making this request. */
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  signedInAt: string;
  lastActiveAt: string;
  expiresAt: string;
}

/** A finished sign-in, or a wrong password ("failed"). */
export interface SignInEntry {
  at: string;
  ipAddress: string | null;
  userAgent: string | null;
  method: "password" | "password+code" | "password+backup-code" | "sign-up" | "email-link" | "passkey" | "sso" | "trusted-header" | "failed";
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ── Importing (a spreadsheet, Home Assistant) ───────────────────────────────
export const importSources = ["csv", "homeassistant"] as const;
export type ImportSource = (typeof importSources)[number];

/** One thing to import. Places and categories are by name or path ("Main › Kitchen"); missing ones are made. */
export const importRow = z.object({
  name: z.string().trim().min(1).max(200),
  description: optionalText(5000),
  brand: optionalText(120),
  model: optionalText(120),
  serialNumber: optionalText(120),
  barcode: optionalText(64),
  quantity: z.number().int().min(0).max(100000).optional().nullable(),
  condition: z.enum(itemConditions).optional().nullable(),
  purchaseDate: z.iso.date().optional().nullable(),
  returnBy: z.iso.date().optional().nullable(),
  purchasePriceCents: cents,
  valueCents: cents,
  notes: optionalText(10000),
  /** A path in the chosen property: "Main › Kitchen", "Garage / Shelf 2", or just "Kitchen". */
  place: optionalText(400),
  /** Or a place that's already in Ferret. */
  locationId: z.string().min(1).max(64).optional().nullable(),
  category: optionalText(200),
  tags: z.array(tagName).max(30).optional(),
  links: z.array(itemLink).max(10).optional(),
  warrantyEnds: z.iso.date().optional().nullable(),
  soldOn: z.iso.date().optional().nullable(),
  soldCents: cents,
  /** Home Assistant's device id — so the same device isn't imported twice. */
  haDeviceId: z.string().min(1).max(64).optional().nullable(),
  /** What the file says this line is (draftRows: "amazon:<order>:<ASIN>:<n>") — a newer copy of the file skips it. */
  importKey: z.string().min(1).max(200).optional().nullable(),
  /** Home Assistant's area: the place made (or chosen) for it. Takes the place of `place`. */
  haAreaId: z.string().min(1).max(64).optional().nullable(),
});
export type ImportRow = z.infer<typeof importRow>;

/**
 * A place an import wants (Home Assistant's area): a new one by path in the request's property ("Main › Kitchen"), or
 * one that's already there (`locationId`). Either way it remembers the HA area (and the floor, on a path's first step).
 */
export const importPlace = z
  .object({
    path: optionalText(400),
    locationId: z.string().min(1).max(64).optional().nullable(),
    haAreaId: z.string().min(1).max(64).optional().nullable(),
    haFloorId: z.string().min(1).max(64).optional().nullable(),
  })
  .refine((p) => p.path || p.locationId, { message: "A place needs a path or a locationId" });
export type ImportPlace = z.infer<typeof importPlace>;

/** A file's lines (importKey) to check before importing: which are already in Ferret. */
export const importKnownInput = z.object({ keys: z.array(z.string().min(1).max(200)).max(5000) });
export type ImportKnownInput = z.infer<typeof importKnownInput>;

export const importInput = z.object({
  source: z.enum(importSources),
  /** The file's name, or "Home Assistant". */
  name: z.string().trim().min(1).max(200),
  /** Where new places go. */
  propertyId: z.string().min(1).optional().nullable(),
  /** Adding to an import already started (big files go in several requests). */
  batchId: z.string().min(1).optional().nullable(),
  /** Places to have, things or not (Home Assistant's rooms), before the rows. */
  places: z.array(importPlace).max(300).optional(),
  rows: z.array(importRow).max(100),
}).refine((i) => i.rows.length > 0 || (i.places?.length ?? 0) > 0, { message: "Nothing to import", path: ["rows"] });
export type ImportInput = z.infer<typeof importInput>;

export interface ImportResult {
  /** Empty when only places were made (no things, no import to undo). */
  batchId: string;
  created: number;
  /** Rows not imported: their index in `rows`, and why. */
  skipped: { index: number; reason: string }[];
  placesCreated: number;
  categoriesCreated: number;
}

/** An import, for "Recent imports" (and undoing one). */
export interface ImportBatchSummary {
  id: string;
  source: ImportSource;
  name: string;
  /** Things it added that are still here. */
  items: number;
  importedAt: string;
  by: string | null;
  undoneAt: string | null;
}

export const homeAssistantConnect = z.object({
  /** Where Home Assistant is: http://homeassistant.local:8123 */
  url: z.url({ protocol: /^https?$/, error: "Use Home Assistant's address, like http://homeassistant.local:8123" }).max(500),
  /** A long-lived access token (your HA profile → Security). Used for this one request, never stored. */
  token: z.string().trim().min(20).max(1000),
});
export type HomeAssistantConnect = z.infer<typeof homeAssistantConnect>;

/** A device in Home Assistant, tidied: duplicates (the same thing through two integrations) folded together. */
export interface HaDevice {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  areaId: string | null;
  /** Its integration ("Sonos", "UniFi Network"). */
  integration: string | null;
  /** Its own settings page, if HA knows one. */
  configurationUrl: string | null;
  /** Probably not a thing you own (a service, an app, a weather forecast, a bridge's copy of another device) — unticked. */
  virtual: boolean;
  /** Already in Ferret (imported before). */
  itemId: string | null;
  /** Other HA devices folded into this one. */
  alsoIds: string[];
  /** Imported before, and Home Assistant has changed it since: what Ferret has, and what HA says now. */
  changes: HaChange[];
}

/** What Home Assistant said about a device when it was last imported (`item.ha_snapshot`). */
export interface HaSnapshot {
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  areaId: string | null;
}

export interface HaChange {
  field: "name" | "brand" | "model" | "serialNumber" | "area";
  /** In Ferret now (for the area: the place's path). */
  ferret: string | null;
  /** In Home Assistant now (for the area: its name). */
  ha: string | null;
}

export interface HaRegistryView {
  /** `propertyId`: where the floor's places are in Ferret (from an earlier import), if anywhere. */
  floors: { id: string; name: string; level: number | null; propertyId: string | null }[];
  /** `locationId`: the place made for it (or chosen) before. */
  areas: { id: string; name: string; floorId: string | null; locationId: string | null }[];
  devices: HaDevice[];
  /** Devices left out before showing them (disabled, services). */
  hidden: number;
  /** Things imported from Home Assistant whose device isn't there any more. */
  removed: { itemId: string; name: string }[];
}

/**
 * A re-import's changes: for each device, the fields to take from Home Assistant (an area → its place) and what HA
 * says now, remembered so the same change isn't offered again — sent for the ones left unticked too.
 */
export const homeAssistantApply = z.object({
  updates: z
    .array(
      z.object({
        itemId: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(200).optional(),
        brand: optionalText(120),
        model: optionalText(120),
        serialNumber: optionalText(120),
        /** Move it to this area's place (it must have one). */
        haAreaId: z.string().min(1).max(64).optional(),
        snapshot: z.object({
          name: z.string().max(200),
          manufacturer: z.string().max(200).nullable(),
          model: z.string().max(200).nullable(),
          serialNumber: z.string().max(200).nullable(),
          areaId: z.string().max(64).nullable(),
        }),
      }),
    )
    .min(1)
    .max(300),
});
export type HomeAssistantApply = z.infer<typeof homeAssistantApply>;

// ── Item history ────────────────────────────────────────────────────────────
/** One thing that happened to an item: added, edited (what changed), moved, a photo, a warranty, maintenance, stock… */
export interface ItemHistoryEntry {
  id: string;
  at: string;
  /** item.create, item.update, item.stock, attachment.create, warranty.create, claim.update, maintenance.done… */
  action: string;
  summary: string;
  by: string | null;
  /** "ferret": Ferret itself, in a background job (a recall check, AI fill-in) — nobody's hand. */
  via: "web" | "api" | "mcp" | "ferret";
}

// ── Share links (read-only, no account) ─────────────────────────────────────
export const shareKinds = ["report", "tag", "category"] as const;
export const shareInput = z
  .object({
    kind: z.enum(shareKinds),
    /** report: one property (else the whole household). */
    propertyId: z.string().min(1).max(64).optional().nullable(),
    tag: z.string().trim().min(1).max(40).optional().nullable(),
    categoryId: z.string().min(1).max(64).optional().nullable(),
    /** Who it's for ("State Farm claim"). */
    label: optionalText(80),
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    /** Photos, receipts and manuals open from the link too. */
    includeFiles: z.boolean().default(true),
  })
  .refine((s) => s.kind !== "tag" || s.tag, { message: "Which tag?", path: ["tag"] })
  .refine((s) => s.kind !== "category" || s.categoryId, { message: "Which category?", path: ["categoryId"] });
export type ShareInput = z.input<typeof shareInput>;

export interface ShareLinkSummary {
  id: string;
  kind: (typeof shareKinds)[number];
  /** What it shows: "Insurance report — Highland House", "Tag: Jewelry". */
  title: string;
  label: string | null;
  includeFiles: boolean;
  /** The link itself (it can be copied again). */
  url: string;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string;
  revokedAt: string | null;
  /** Still opens: not expired, not turned off. */
  active: boolean;
  views: number;
  lastViewedAt: string | null;
}

export interface ShareViewEntry {
  at: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** What a share link shows (no account): the report's rows, and each item's files if they're shared. */
export interface SharedView {
  household: string;
  /** The household's currency (ISO 4217): what the amounts are in. */
  currency: string;
  title: string;
  label: string | null;
  sharedBy: string | null;
  expiresAt: string;
  generatedAt: string;
  includeFiles: boolean;
  properties: Pick<PlacesTree["properties"][number], "name" | "type" | "details">[];
  rows: ExportRow[];
  /** Item id → its photos and documents (only with includeFiles). */
  files: Record<string, { id: string; kind: "photo" | "document"; filename: string; contentType: string }[]>;
}

// ── Lending ─────────────────────────────────────────────────────────────────
export const loanDirections = ["lent", "borrowed"] as const;
export type LoanDirection = (typeof loanDirections)[number];
export const remindEvery = ["week", "2weeks", "month"] as const;
export const loanInput = z.object({
  direction: z.enum(loanDirections).describe("lent: the household's thing is with someone else; borrowed: someone else's thing is here"),
  person: z.string().trim().min(1).max(80).describe("Who has it (lent) or whose it is (borrowed)"),
  email: z.email().max(320).optional().nullable().describe("Lent: the borrower's email, for reminders"),
  since: z.iso.date().optional().nullable().describe("When it went (or came), yyyy-mm-dd; today if left out"),
  dueOn: z.iso.date().optional().nullable().describe("When it's due back, yyyy-mm-dd"),
  note: optionalText(1000).describe("Anything worth remembering about the loan"),
  remindEvery: z.enum(remindEvery).optional().nullable().describe("Lent, with an email: remind the borrower this often"),
});
export type LoanInput = z.infer<typeof loanInput>;
export const loanPatch = loanInput.omit({ direction: true }).partial();
export type LoanPatch = z.infer<typeof loanPatch>;

export interface LoanSummary {
  id: string;
  itemId: string;
  itemName: string;
  direction: LoanDirection;
  person: string;
  email: string | null;
  since: string;
  dueOn: string | null;
  note: string | null;
  remindEvery: (typeof remindEvery)[number] | null;
  lastRemindedOn: string | null;
  /** The borrower said (from the email's link) it's back. */
  borrowerReturnedAt: string | null;
  /** The borrower asked for no more reminders. */
  remindersStoppedAt: string | null;
  returnedOn: string | null;
  overdue: boolean;
}

/** The borrower's page (from a reminder email): no account, only what the email said. */
export interface BorrowerView {
  person: string;
  owner: string;
  itemName: string;
  since: string;
  dueOn: string | null;
  returned: boolean;
  reportedBack: boolean;
  stopped: boolean;
}

// ── Recalls ─────────────────────────────────────────────────────────────────
/** A recall that matches one of your things. */
export interface ItemRecall {
  id: string;
  itemId: string;
  itemName: string;
  /** barcode / model: the same product; possible: the same maker and kind of thing — check the model. */
  match: "barcode" | "model" | "possible";
  status: "open" | "dismissed" | "done";
  foundAt: string;
  recall: {
    id: string;
    title: string;
    recalledOn: string;
    url: string | null;
    description: string | null;
    hazard: string | null;
    remedy: string | null;
    contact: string | null;
    imageUrl: string | null;
  };
}

// ── Insurance coverage ──────────────────────────────────────────────────────
export const coverageScopes = ["all", "category", "tag"] as const;
export const coverageInput = z
  .object({
    /** "Personal property (Coverage C)", "Jewelry & watches"… */
    label: z.string().trim().min(1).max(80).describe('The policy line: "Personal property (Coverage C)", "Jewelry & watches"'),
    limitCents: z.number().int().min(0).max(1_000_000_000_00).describe("What the policy pays at most, in cents"),
    scope: z.enum(coverageScopes).describe("What it covers: all (everything), category (categoryId) or tag (tag)"),
    /** Only this property's things (else everywhere). */
    propertyId: z.string().min(1).max(64).optional().nullable().describe("Only this property's things, from list_locations; left out: every property"),
    categoryId: z.string().min(1).max(64).optional().nullable().describe("With scope category: the category, from list_categories (its subcategories count too)"),
    tag: z.string().trim().min(1).max(40).optional().nullable().describe("With scope tag: the tag's name"),
    note: optionalText(500).describe("Anything worth keeping: the policy number, a rider"),
  })
  .refine((c) => c.scope !== "category" || c.categoryId, { message: "Which category?", path: ["categoryId"] })
  .refine((c) => c.scope !== "tag" || c.tag, { message: "Which tag?", path: ["tag"] });
export type CoverageInput = z.infer<typeof coverageInput>;

/** A limit, and what the inventory says the things it covers are worth. */
export interface CoverageCheck {
  id: string;
  label: string;
  limitCents: number;
  scope: (typeof coverageScopes)[number];
  propertyId: string | null;
  propertyName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  tag: string | null;
  note: string | null;
  /** Value (else price paid) × quantity of the things it covers. */
  valueCents: number;
  items: number;
  /** Things it covers with no value or price: the total may be low. */
  unvalued: number;
  /** How much more they're worth than the limit (0 when covered). */
  shortCents: number;
}

// ── Weekly summary ──────────────────────────────────────────────────────────
export const weeklyDigestInput = z.object({
  /** 0 = Sunday … 6 = Saturday; null = no weekly summary. */
  day: z.number().int().min(0).max(6).nullable(),
  /** Also to the account's email (when the server can send email). */
  email: z.boolean().default(false),
});
export type WeeklyDigestInput = z.input<typeof weeklyDigestInput>;
export interface WeeklyDigestSetting {
  day: number | null;
  email: boolean;
  /** The server can send email (MAIL_URL). */
  canEmail: boolean;
  lastSentOn: string | null;
}

/** Recall checks, for the server admin (Settings → Server). */
export interface RecallStatus {
  /** This server can reach a recall list at all. */
  available: boolean;
  enabled: boolean;
  /** Brands asked about, and recalls kept. */
  brands: number;
  recalls: number;
  lastCheckedAt: string | null;
}

/** A failed call to a service Ferret depends on (Settings → Server, the server admin only). */
export interface ServiceErrorEntry {
  id: string;
  /** The port: ai, chat, documents, vectors, reranker, notifier, push, products, maps, recalls. */
  service: string;
  serviceName: string;
  operation: string;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** The latest one's details (lib/service-errors.ts FailureRecord), if it was recorded with them. */
  detail: Record<string, unknown> | null;
  /** All of it as plain text, to paste into a bug report or a chat with Claude. */
  triage: string;
}

// ── Bulk changes (the table view) ───────────────────────────────────────────
export const itemsBulk = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), ids: z.array(z.string().min(1)).min(1).max(200), locationId: z.string().min(1).nullable() }),
  z.object({ action: z.literal("category"), ids: z.array(z.string().min(1)).min(1).max(200), categoryId: z.string().min(1).nullable() }),
  z.object({ action: z.literal("tag"), ids: z.array(z.string().min(1)).min(1).max(200), tag: tagName }),
  z.object({ action: z.literal("untag"), ids: z.array(z.string().min(1)).min(1).max(200), tag: tagName }),
  z.object({ action: z.literal("delete"), ids: z.array(z.string().min(1)).min(1).max(200) }),
]);
export type ItemsBulk = z.infer<typeof itemsBulk>;
export interface ItemsBulkResult {
  done: number;
  failed: { id: string; reason: string }[];
}

// ── Household settings ──────────────────────────────────────────────────────
/** A household's settings (Settings → Household). */
export interface HouseholdSettings {
  /** Where the household is (IANA, e.g. America/Denver): what "today" is, and when reminders go out. Null: not chosen. */
  timeZone: string | null;
  /** What "today" follows while it isn't chosen: the server's own zone. */
  serverTimeZone: string;
  /** Its money (ISO 4217, e.g. EUR) — how amounts are written everywhere. USD until chosen. */
  currency: string;
  /** The Amazon it buys from (Search Amazon): its choice, else worked out from its zone and currency. */
  amazonSite: string;
  /** Its own choice of Amazon, or null (worked out). */
  amazonSiteChosen: string | null;
  /** Which kinds of AI results fill in by themselves here (each: the household's choice, else the server's default). */
  aiFill: Record<AiFillKind, boolean>;
  /** The server's defaults, for kinds the household hasn't chosen (Settings → Server). */
  aiFillDefaults: Record<AiFillKind, boolean>;
  /** Kinds the household chose itself (the rest follow the server). */
  aiFillChosen: AiFillKind[];
}

/** Settings → Household's invitations: whether this server emails them, and when each pending one went out. */
export interface InvitationEmails {
  /** False: Ferret can't send email here — the link has to be sent by hand. */
  email: boolean;
  data: { id: string; queuedAt: string; sentAt: string | null; error: string | null }[];
}

// ── Plan & usage ────────────────────────────────────────────────────────────
/** What a household's plan allows; null = no limit (the server's lib/plan.ts). */
export interface PlanLimits {
  items: number | null;
  fileBytes: number | null;
  members: number | null;
  ai: boolean;
  aiActions: number | null;
  barcodeLookups: number | null;
  /** API keys — scripts and Claude (MCP). Off: no new keys, and existing ones pause until it's on again. */
  apiKeys: boolean;
  /** Share links (no account needed). Off: no new links, and existing ones pause. */
  shareLinks: boolean;
  /** Calendar feeds of due maintenance. Off: no new feeds, and existing ones pause. */
  calendarFeeds: boolean;
}

/** Used, and the limit (null: none). */
export interface PlanMeter {
  used: number;
  limit: number | null;
}

/**
 * Settings → Household → Delete household: its name, typed, to confirm — and the password when, being the person's
 * only household, their account goes with it.
 */
export const householdDeleteInput = z.object({ confirm: z.string().min(1).max(200), password: z.string().max(1024).optional() });

/** What deleting the active household would do (GET /api/v1/household/deletion). */
export interface HouseholdDeletionInfo {
  /** It's the only household they're in: their account is deleted with it, in the same step. */
  alsoAccount: boolean;
  /** Confirm with the password (else a sign-in in the last 15 minutes) — when the account goes too. */
  needsPassword: boolean;
}

/** Settings → Security → Delete account: the account's email, typed; and its password, if it has one. */
export const accountDeleteInput = z.object({ confirm: z.string().min(1).max(320), password: z.string().max(1024).optional() });

/** What deleting an account would do (GET /api/v1/security/account). */
export interface AccountDeletionInfo {
  /** Households it owns with others in them: hand over or delete them first. */
  blockers: { id: string; name: string }[];
  /** Households only it is in: deleted with it. */
  households: { id: string; name: string }[];
  /** Confirm with the password (else a sign-in in the last 15 minutes). */
  needsPassword: boolean;
  /** It's the server admin while others have accounts: hand that over first. */
  serverAdmin: boolean;
}

/** Settings → Server (GET /api/v1/server/barcode-lookups): the online barcode database, and its allowance left. */
export interface BarcodeLookupStatus {
  /** Online lookups are switched on (BARCODE_LOOKUP). */
  on: boolean;
  /** As the database said at the last lookup (full again once `resetsAt` has passed); null until one. */
  quota: { limit: number; remaining: number; resetsAt: string; checkedAt: string } | null;
}

/** Settings → Plan & usage (GET /api/v1/plan): the plan, if any, and this period's usage. */
export interface PlanReport {
  /** Null: no plan — a home Ferret, nothing limited. */
  plan: {
    name: string;
    limits: PlanLimits;
    upgradeUrl: string | null;
    manageUrl: string | null;
    /** More of the service's pages for the owner. */
    links: { label: string; url: string }[];
    status: string | null;
  } | null;
  /** The period counted: the plan's (yyyy-mm-dd to yyyy-mm-dd), or the calendar month (yyyy-mm, end null). */
  period: { start: string; end: string | null };
  /** AI actions (a photo 2, a question or a document 1); limit 0 when the plan has no AI. */
  aiActions: PlanMeter;
  /** Null when this server has no online barcode database (only the barcode books). */
  barcodeLookups: PlanMeter | null;
  items: PlanMeter;
  fileBytes: PlanMeter;
  members: PlanMeter;
  /** This period, by person (userId null: Ferret's own background work), most first. */
  people: { userId: string | null; name: string; aiActions: number; asks: number; photos: number; documents: number; barcodeLookups: number }[];
}

/** Settings → Household: only what's sent changes. */
export const householdSettingsInput = z.object({
  timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, "That isn't a time zone").nullable().optional(),
  currency: z.string().trim().toUpperCase().length(3).refine(isCurrency, "That isn't a currency").optional(),
  /** The Amazon it buys from (www.amazon.co.uk…), or null to work it out from the zone and currency. */
  amazonSite: z.string().trim().toLowerCase().refine((site): boolean => isAmazonSite(site), "That isn't an Amazon store").nullable().optional(),
  /** Per kind: on, off, or null to follow the server's default. */
  aiFill: z.partialRecord(z.enum(aiFillKinds), z.boolean().nullable()).optional(),
});
export type HouseholdSettingsInput = z.infer<typeof householdSettingsInput>;

/** A certificate Ferret's server trusts, or presents to some hosts (Settings → Server → Certificates). */
export interface ServerCertificate {
  id: string;
  name: string;
  subject: string;
  issuer: string;
  /** ISO time it stops being valid. */
  notAfter: string;
  fingerprint: string;
  addedAt: string;
  /** A client certificate's hosts: names, `*.example.lan` for everything under one, or addresses. */
  hosts?: string[];
}

export interface ServerCertificates {
  /** False where the server can't use its own (e.g. a hosted Ferret). */
  available: boolean;
  trusted: ServerCertificate[];
  clients: ServerCertificate[];
}

/** A household at a glance, for home dashboards (GET /api/v1/summary). Counts only. */
export interface HouseholdSummary {
  household: string;
  /** Things kept (not gone). */
  things: number;
  /** What they're worth: current value, else what was paid, times quantity — like the insurance report. */
  valueCents: number;
  /** The household's currency (ISO 4217) that `valueCents` is in (hundredths of it). */
  currency: string;
  /** Everything in the bell, and how many of those are urgent. */
  needsAttention: number;
  urgent: number;
  /** On the shopping list. */
  toBuy: number;
}

// ── AI: filling in by itself, suggested maintenance, sorting, estimates, duplicates ──
/**
 * What the AI may fill in by itself, when a household lets it (lib/ai-fill.ts): only empty fields, only what the model
 * read plainly. "details": brand, model, serial, barcode, purchase date, price paid (and the name of an unnamed
 * "New item"); "returnBy": the return-by date from a receipt; "warranty": a warranty from a receipt or card, when the
 * purchase date is known. Never: merging, values, renaming what a person named, gone/sold, maintenance schedules.
 */
/** One field the AI filled in by itself. */
export interface AiFill {
  /** What it wrote (a warranty: its end date). */
  value: string | number;
  /** The file it read it from. */
  from: string | null;
  attachmentId: string | null;
  at: string;
  /** For "warranty": the warranty it added (Undo removes it). */
  warrantyId?: string;
}

/** The "Filled in by AI" list: one row per field still waiting to be confirmed. */
export interface AiFillEntry {
  itemId: string;
  itemName: string;
  field: string;
  label: string;
  value: string | number;
  from: string | null;
  at: string;
}

/** Suggested maintenance (household-wide): schedules found in manuals, or typical upkeep for an item's kind. */
export interface SuggestedTask {
  id: string;
  itemId: string;
  itemName: string;
  title: string;
  intervalCount: number;
  intervalUnit: (typeof intervalUnits)[number];
  source: "manual" | "typical";
  attachmentId: string | null;
  /** The manual's file name. */
  filename: string | null;
  createdAt: string;
}

/** Sorting an import's lines (AI-1): which to keep, and a category from the household's own. */
export const importTriageInput = z.object({
  rows: z
    .array(z.object({ name: z.string().trim().min(1).max(300), category: z.string().trim().max(200).optional() }))
    .min(1)
    .max(3000),
});
export type ImportTriageInput = z.infer<typeof importTriageInput>;
export interface ImportTriageRow {
  /** False: looks like a consumable or something not worth keeping a record of. */
  keep: boolean;
  /** A category path from the household's own ("Tools › Power tools"), or null. */
  category: string | null;
}

/** Background AI work the browser is waiting for (GET /ai-runs/:id). */
export interface AiRunStatus<T = unknown> {
  id: string;
  status: "pending" | "done" | "failed";
  /** For a run done in parts: how many are done. */
  done?: number;
  total?: number;
  result: T | null;
  error: string | null;
}

/** Plain words → Everything's filters (AI-2). */
export const filtersFromTextInput = z.object({ text: z.string().trim().min(3).max(300) });
export interface FiltersFromText {
  /** Everything's filter values, as its link would carry them (e.g. { category: "…id", missing: "receipt" }). */
  filters: Record<string, string>;
  /** Words for each, to show as chips. */
  chips: { key: string; label: string }[];
  /** What it couldn't turn into a filter (shown as the search words). */
  query: string | null;
}

/** Two items that may be the same thing (AI-4). */
export interface DuplicatePair {
  a: DuplicateSide;
  b: DuplicateSide;
  /** Why they look alike, in words. */
  reasons: string[];
}
export interface DuplicateSide {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  place: string | null;
  photoId: string | null;
  createdAt: string;
}

/** Merging two items: which one's value to keep where they differ (default: the survivor's, else the other's). */
export const mergeInput = z.object({
  from: z.string().min(1).describe("The item merged away (it goes to Recently deleted)"),
  take: z.array(z.string().max(40)).max(40).default([]).describe("Fields to take from the merged-away item where both have a value"),
});
export type MergeInput = z.infer<typeof mergeInput>;
