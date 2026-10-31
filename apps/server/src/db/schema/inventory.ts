/**
 * Inventory tables. Every row belongs to a household (a Better Auth
 * "organization") and every query is scoped by householdId.
 * SQLite dialect.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AnalysisStatus, AttachmentAnalysis, CategoryField, CustomFieldValues, HaSnapshot, ItemLink, ItemOrigin, ProductInfo, RoomScanCandidate, RoomScanStatus } from "@ferret/shared";
import { invitation, organization, user } from "./auth";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const householdId = () =>
  text("household_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
  /** Soft delete — rows stay for undo/history, queries filter them out. */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
};

export const property = sqliteTable(
  "property",
  {
    id: id(),
    householdId: householdId(),
    name: text("name").notNull(),
    type: text("type").notNull().default("home"),
    street: text("street"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: text("country"),
    yearBuilt: integer("year_built"),
    /** What the property itself is worth (for insurance), in cents. */
    valueCents: integer("value_cents"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("property_household_idx").on(t.householdId)],
);

export const location = sqliteTable(
  "location",
  {
    id: id(),
    householdId: householdId(),
    propertyId: text("property_id")
      .notNull()
      .references(() => property.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => location.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    notes: text("notes"),
    /** The Home Assistant area it came from (or `floor:<id>` for a floor), so a re-import finds it again. */
    haAreaId: text("ha_area_id"),
    ...timestamps,
  },
  (t) => [index("location_household_idx").on(t.householdId), index("location_parent_idx").on(t.parentId)],
);

/**
 * What a thing is — Electronics › TV — nested via parentId. One per item; the
 * insurance report groups by the top level. A category can define extra fields
 * its items fill in (a TV's screen size); subcategories inherit their parents'.
 */
export const category = sqliteTable(
  "category",
  {
    id: id(),
    householdId: householdId(),
    parentId: text("parent_id").references((): AnySQLiteColumn => category.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    fields: text("fields", { mode: "json" }).$type<CategoryField[]>(),
    ...timestamps,
  },
  (t) => [index("category_household_idx").on(t.householdId), index("category_parent_idx").on(t.parentId)],
);

/**
 * An item template (lib/templates.ts): a kind of thing someone keeps several of — a coin, a trading card, a doll — with
 * its own fields (year, mint mark, grade…) and, optionally, the category and tags things made from it start with.
 * The values live in the item's customFields, like a category's fields.
 */
export const itemTemplate = sqliteTable(
  "item_template",
  {
    id: id(),
    householdId: householdId(),
    name: text("name").notNull(),
    icon: text("icon"),
    fields: text("fields", { mode: "json" }).$type<CategoryField[]>().notNull(),
    categoryId: text("category_id").references(() => category.id, { onDelete: "set null" }),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    ...timestamps,
  },
  (t) => [index("item_template_household_idx").on(t.householdId)],
);

/**
 * A collection (lib/collections.ts): coins, Barbies, baseball cards — things kept as a set, usually of one template
 * (whose fields are its columns). Its items have `collectionId`; ones still being looked for are `wanted` (the want
 * list), which keeps them out of everything that counts what you own.
 */
export const collection = sqliteTable(
  "collection",
  {
    id: id(),
    householdId: householdId(),
    name: text("name").notNull(),
    description: text("description"),
    templateId: text("template_id").references(() => itemTemplate.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("collection_household_idx").on(t.householdId)],
);

export const item = sqliteTable(
  "item",
  {
    id: id(),
    householdId: householdId(),
    name: text("name").notNull(),
    description: text("description"),
    brand: text("brand"),
    model: text("model"),
    serialNumber: text("serial_number"),
    barcode: text("barcode"),
    quantity: integer("quantity").notNull().default(1),
    /** Keep at least this many (consumables): at or below it, it's on the shopping list (lib/stock.ts). */
    minQuantity: integer("min_quantity"),
    /** What it counts, for maintenance by use (lib/usage.ts): miles, km, hours (engine, furnace), cycles. */
    usageUnit: text("usage_unit").$type<"miles" | "km" | "hours" | "cycles">(),
    /**
     * What happened to it, once it's gone: sold, given (away), discarded, lost, stolen — null while you still have it.
     * Gone things leave lists, totals, search and reminders (itemScope), but keep their page and history.
     */
    disposition: text("disposition").$type<"sold" | "given" | "discarded" | "lost" | "stolen">(),
    disposedOn: text("disposed_on"), // ISO yyyy-mm-dd
    /** What it sold for, or what insurance paid out, in cents. */
    disposalCents: integer("disposal_cents"),
    disposalNote: text("disposal_note"),
    condition: text("condition"),
    purchaseDate: text("purchase_date"), // ISO yyyy-mm-dd
    purchasePriceCents: integer("purchase_price_cents"),
    valueCents: integer("value_cents"),
    notes: text("notes"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    heir: text("heir"),
    categoryId: text("category_id").references(() => category.id, { onDelete: "set null" }),
    /** The barcode whose product suggestions someone dismissed (they come back if the barcode changes). */
    productDismissedFor: text("product_dismissed_for"),
    /** Values for the category's extra fields, by field key. */
    customFields: text("custom_fields", { mode: "json" }).$type<CustomFieldValues>(),
    /** The template it was made from (its fields show on it, besides its category's). */
    templateId: text("template_id").references((): AnySQLiteColumn => itemTemplate.id, { onDelete: "set null" }),
    /** The collection it's part of (lib/collections.ts). */
    collectionId: text("collection_id").references((): AnySQLiteColumn => collection.id, { onDelete: "set null" }),
    /**
     * On the want list: not owned yet (a collection's missing pieces). Left out by itemScope like gone things, so it's
     * in no totals, report, stock or search — unless asked for.
     */
    wanted: integer("wanted", { mode: "boolean" }).notNull().default(false),
    /** Web links (the maker's product page, the manual online…). */
    links: text("links", { mode: "json" }).$type<ItemLink[]>(),
    locationId: text("location_id").references(() => location.id, { onDelete: "set null" }),
    /** A box, bin or case: other items can go inside it (and it gets a QR label). */
    isContainer: integer("is_container", { mode: "boolean" }).notNull().default(false),
    /**
     * The box it's in. Its locationId then mirrors the box's (kept in step when
     * the box moves), so every "what's in the garage" query still works.
     */
    containerItemId: text("container_item_id").references((): AnySQLiteColumn => item.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /**
     * Where it came from: typed into the app, "Add from photos", a walkthrough, a barcode scan, a QR label, a
     * spreadsheet or Home Assistant import, Claude (MCP) or a script (an API key) — and `originDetail`: the file's name,
     * the key's name. Set once, when it's added (lib/inventory.ts createItem, lib/imports.ts).
     */
    origin: text("origin").$type<ItemOrigin>(),
    originDetail: text("origin_detail"),
    /** The room scan it was found in (lib/room-scans.ts): its page links to the room photo. */
    roomScanId: text("room_scan_id").references((): AnySQLiteColumn => roomScan.id, { onDelete: "set null" }),
    /** The import it came in with (a spreadsheet, Home Assistant) — so an import can be undone. */
    importBatchId: text("import_batch_id").references((): AnySQLiteColumn => importBatch.id, { onDelete: "set null" }),
    /** Home Assistant's device id, for things imported from it: the same device isn't imported twice. */
    haDeviceId: text("ha_device_id"),
    /** What Home Assistant said about it when last imported — a re-import offers only what HA changed since. */
    haSnapshot: text("ha_snapshot", { mode: "json" }).$type<HaSnapshot>(),
    /** Last time the item was embedded for semantic search (null = never; stale if older than updatedAt). */
    indexedAt: integer("indexed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    index("item_household_idx").on(t.householdId),
    index("item_location_idx").on(t.locationId),
    index("item_barcode_idx").on(t.householdId, t.barcode),
    index("item_category_idx").on(t.householdId, t.categoryId),
    index("item_ha_device_idx").on(t.householdId, t.haDeviceId),
  ],
);

/** One import (lib/imports.ts): a spreadsheet or Home Assistant. Its items point back here, so it can be undone. */
export const importBatch = sqliteTable(
  "import_batch",
  {
    id: id(),
    householdId: householdId(),
    source: text("source").$type<"csv" | "homeassistant">().notNull(),
    /** The file's name, or "Home Assistant". */
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
    /** Undone: its items went to Recently deleted. */
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("import_batch_household_idx").on(t.householdId, t.createdAt)],
);

/**
 * Free labels on items — "camping", "Christmas", "Grandma's china". A tag is
 * also a collection: it has its own page. `key` is the lowercased name, so
 * "Camping" and "camping" are one tag.
 */
export const tag = sqliteTable(
  "tag",
  {
    id: id(),
    householdId: householdId(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("tag_household_key_idx").on(t.householdId, t.key)],
);

export const itemTag = sqliteTable(
  "item_tag",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
    householdId: householdId(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] }), index("item_tag_tag_idx").on(t.householdId, t.tagId)],
);

/**
 * One data key per household, used to encrypt its files at rest. Stored
 * wrapped (encrypted) by the server master key FILES_KEY; `kekId` names
 * which master key wrapped it, so the master key can be rotated later.
 */
/** A household's own settings (Settings → Household). One row, made when one is first set. */
export const householdSetting = sqliteTable("household_setting", {
  householdId: text("household_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /**
   * Where the household is (IANA, e.g. America/Denver): what "today" is — due, overdue, ending — and the hour reminders
   * go out. The server's clock is UTC; null = the server's own zone (lib/household-time.ts).
   */
  timeZone: text("time_zone"),
  /** The last day (UTC, yyyy-mm-dd) anyone in it used Ferret — written at most once a day (lib/plan.ts markActive). */
  lastActiveOn: text("last_active_on"),
  updatedAt: timestamps.updatedAt,
});

export const householdKey = sqliteTable("household_key", {
  householdId: text("household_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  kekId: text("kek_id").notNull(),
  wrappedKey: text("wrapped_key").notNull(), // base64: iv ‖ ciphertext
  createdAt: timestamps.createdAt,
});

/** Photos and documents attached to an item. The bytes live encrypted in Blobs under `blobKey`. */
export const attachment = sqliteTable(
  "attachment",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "photo" | "document"
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(), // plaintext bytes
    blobKey: text("blob_key").notNull(),
    /** Encrypted WebP thumbnail, when one could be made. */
    thumbnailKey: text("thumbnail_key"),
    /** Vision-model analysis: null (not analysed) | "pending" | "done" | "failed". */
    analysisStatus: text("analysis_status").$type<AnalysisStatus>(),
    analysis: text("analysis", { mode: "json" }).$type<AttachmentAnalysis>(),
    analyzedAt: integer("analyzed_at", { mode: "timestamp_ms" }),
    /** Set when someone dismisses this attachment's suggestions. */
    suggestionsDismissedAt: integer("suggestions_dismissed_at", { mode: "timestamp_ms" }),
    /**
     * Set when the original was removed to free space and only the thumbnail kept (lib/attachments.ts `removeOriginals`). The blob at `blobKey` is gone; `size` is
     * still the original's, but it no longer counts towards the household's files.
     */
    originalRemovedAt: integer("original_removed_at", { mode: "timestamp_ms" }),
    /**
     * When it was chosen as the item's main photo (its picture in lists): photos are shown newest choice first, then in
     * the order they were added (lib/attachments.ts PHOTO_ORDER). Null: never chosen.
     */
    mainAt: integer("main_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("attachment_item_idx").on(t.householdId, t.itemId)],
);

/** A warranty on an item: when it ends, who provides it, and the document it came from. */
export const warranty = sqliteTable(
  "warranty",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    provider: text("provider"),
    startsOn: text("starts_on"), // ISO yyyy-mm-dd
    endsOn: text("ends_on").notNull(), // ISO yyyy-mm-dd
    coverage: text("coverage"),
    attachmentId: text("attachment_id").references(() => attachment.id, { onDelete: "set null" }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("warranty_item_idx").on(t.householdId, t.itemId), index("warranty_ends_idx").on(t.householdId, t.endsOn)],
);

/** A claim made under a warranty: what went wrong, the claim number, and how it ended. */
export const warrantyClaim = sqliteTable(
  "warranty_claim",
  {
    id: id(),
    householdId: householdId(),
    warrantyId: text("warranty_id")
      .notNull()
      .references(() => warranty.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    filedOn: text("filed_on").notNull(), // ISO yyyy-mm-dd
    problem: text("problem").notNull(),
    /** The provider's claim or case number. */
    reference: text("reference"),
    status: text("status").notNull().default("filed"), // filed | in_progress | approved | denied | resolved
    resolution: text("resolution"),
    resolvedOn: text("resolved_on"),
    /** What it cost us (a deductible, shipping…), in cents. */
    costCents: integer("cost_cents"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("warranty_claim_item_idx").on(t.householdId, t.itemId), index("warranty_claim_warranty_idx").on(t.warrantyId)],
);

/**
 * Background jobs for the local runner (adapters/local/jobs.ts) — the stand-in
 * for another runtime's queue. Successful jobs are deleted; failed ones stay for inspection.
 */
export const job = sqliteTable(
  "job",
  {
    id: id(),
    type: text("type").notNull(), // e.g. attachment.analyze
    payload: text("payload").notNull(), // JSON
    status: text("status").notNull().default("pending"), // pending | running | failed
    attempts: integer("attempts").notNull().default(0),
    runAt: integer("run_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastError: text("last_error"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("job_due_idx").on(t.status, t.runAt)],
);

/** Who changed what — shown in the app and useful when Claude edits via MCP. */
export const activity = sqliteTable(
  "activity",
  {
    id: id(),
    householdId: householdId(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    /** "web" | "api" | "mcp" */
    via: text("via").notNull().default("web"),
    action: text("action").notNull(), // e.g. item.create
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    summary: text("summary"),
    /** The item it's about (its photos, warranties, maintenance…): an item's history. No FK — history outlives a purge. */
    itemId: text("item_id"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("activity_household_idx").on(t.householdId, t.createdAt), index("activity_item_idx").on(t.householdId, t.itemId, t.createdAt)],
);

/** Someone who works on the house or its things: a plumber, the HVAC company, an appliance repair shop. */
export const provider = sqliteTable(
  "provider",
  {
    id: id(),
    householdId: householdId(),
    name: text("name").notNull(),
    /** What they do: "Plumber", "HVAC"… */
    trade: text("trade"),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    address: text("address"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("provider_household_idx").on(t.householdId)],
);

/**
 * Maintenance: a recurring (or one-off) job on an item, a place or the whole
 * household — "Replace furnace filter every 3 months". `dueOn` is the next due
 * date; marking it done logs it and moves `dueOn` on by the interval from the
 * day it was done. A one-off task is finished when `dueOn` is null.
 */
export const maintenanceTask = sqliteTable(
  "maintenance_task",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id").references(() => item.id, { onDelete: "cascade" }),
    locationId: text("location_id").references(() => location.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    notes: text("notes"),
    /** Repeats every `intervalCount` `intervalUnit`s; both null = one-off. */
    intervalCount: integer("interval_count"),
    intervalUnit: text("interval_unit").$type<"day" | "week" | "month" | "year">(),
    /**
     * When it's next due, as everything reads it (lists, the bell, reminders, calendars): the earlier of `timeDueOn` and
     * the date its usage is expected to get there (lib/usage.ts). Null = done (a one-off).
     */
    dueOn: text("due_on"),
    /** When it's due by time alone: one interval after it was last done, or the date it was set for. */
    timeDueOn: text("time_due_on"),
    /** Also (or only) every this much use of its item ("every 5,000 miles"), in the item's `usageUnit`. */
    usageEvery: integer("usage_every"),
    /** The item's reading it's next due at (the reading when last done + `usageEvery`). */
    usageDueAt: real("usage_due_at"),
    lastDoneOn: text("last_done_on"),
    /** The manual it came from, when suggested from a document. */
    attachmentId: text("attachment_id").references(() => attachment.id, { onDelete: "set null" }),
    /** Who usually does it (blank: we do it ourselves). */
    providerId: text("provider_id").references(() => provider.id, { onDelete: "set null" }),
    /** The consumable it uses (a furnace filter): Done takes `partQuantity` of it out of stock. */
    partItemId: text("part_item_id").references((): AnySQLiteColumn => item.id, { onDelete: "set null" }),
    partQuantity: integer("part_quantity").notNull().default(1),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("maintenance_task_due_idx").on(t.householdId, t.dueOn),
    index("maintenance_task_item_idx").on(t.householdId, t.itemId),
  ],
);

/** A reading of what an item counts (its `usageUnit`): the odometer, the hour meter — for maintenance by use. */
export const usageReading = sqliteTable(
  "usage_reading",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    value: real("value").notNull(),
    readOn: text("read_on").notNull(), // ISO yyyy-mm-dd
    note: text("note"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("usage_reading_item_idx").on(t.householdId, t.itemId, t.readOn)],
);

/** Each time a task was done: when, by whom, and what it cost. */
export const maintenanceLog = sqliteTable(
  "maintenance_log",
  {
    id: id(),
    householdId: householdId(),
    taskId: text("task_id")
      .notNull()
      .references(() => maintenanceTask.id, { onDelete: "cascade" }),
    doneOn: text("done_on").notNull(), // ISO yyyy-mm-dd
    doneBy: text("done_by").references(() => user.id, { onDelete: "set null" }),
    /** Who did the work this time, if it wasn't us. */
    providerId: text("provider_id").references(() => provider.id, { onDelete: "set null" }),
    note: text("note"),
    costCents: integer("cost_cents"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("maintenance_log_task_idx").on(t.householdId, t.taskId)],
);

/**
 * A private calendar feed (webcal) of due maintenance, for one person in one
 * household. The feed is found by the token's hash; the token itself is kept
 * sealed with the household's key so its owner can see the link again.
 */
export const calendarFeed = sqliteTable(
  "calendar_feed",
  {
    id: id(),
    householdId: householdId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** The token, encrypted with the household key (FileStore.seal); null for feeds made before it was kept. */
    tokenSealed: text("token_sealed"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("calendar_feed_user_idx").on(t.userId, t.householdId)],
);

/** A browser's Web Push subscription (the installed PWA), for maintenance reminders. */
export const pushSubscription = sqliteTable(
  "push_subscription",
  {
    id: id(),
    householdId: householdId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** Last day a reminder went out, so the daily job sends at most one a day. */
    lastNotifiedOn: text("last_notified_on"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("push_subscription_user_idx").on(t.userId)],
);

/**
 * A finished sign-in (password, then the authenticator code if two-step is
 * on): where from and on what, for Settings → Security. A sign-in still
 * waiting for its code isn't one. The newest 50 per person are kept.
 */
export const signIn = sqliteTable(
  "sign_in",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** How they proved it was them: "password", "password+code", "password+backup-code", or "sign-up". */
    method: text("method").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("sign_in_user_idx").on(t.userId, t.createdAt)],
);

/**
 * A wrong password (for any email typed, account or not): what the sign-in
 * guard counts for backoff and the proof-of-work check, and what Settings →
 * Security shows the account's owner. Kept 30 days.
 */
export const signInFailure = sqliteTable(
  "sign_in_failure",
  {
    id: id(),
    /** As typed, lowercased. */
    email: text("email").notNull(),
    /** The account it was for, if there is one. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("sign_in_failure_email_idx").on(t.email, t.createdAt),
    index("sign_in_failure_ip_idx").on(t.ipAddress, t.createdAt),
  ],
);

/**
 * "Email me a link to sign in again": a one-time link that clears the wrong-password
 * count for an email (sign-in-guard.ts). Only the token's hash is kept.
 */
export const signInUnlock = sqliteTable(
  "sign_in_unlock",
  {
    id: id(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamps.createdAt,
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("sign_in_unlock_email_idx").on(t.email, t.createdAt)],
);

/**
 * "Add from a web address": a photo or document the server is downloading for an
 * item (jobs/download.ts). It disappears when the file arrives (as an attachment);
 * a failed one stays, with why, until someone dismisses it.
 */
export const pendingDownload = sqliteTable(
  "pending_download",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** "photo" | "document"; null: by what arrives. */
    kind: text("kind").$type<"photo" | "document">(),
    status: text("status").$type<"pending" | "failed">().notNull().default("pending"),
    error: text("error"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("pending_download_item_idx").on(t.itemId)],
);

/** ALTCHA challenges already used, so a solved one can't be replayed (kept until it expires anyway). */
export const spentChallenge = sqliteTable("spent_challenge", {
  signature: text("signature").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Somewhere else a person gets their reminders: an Apprise URL (ntfy, Pushover,
 * Telegram, email…), sent through the apprise-api sidecar. Per person and
 * household, like push subscriptions; the URL holds tokens, so it's sealed
 * with the household key.
 */
export const notificationChannel = sqliteTable(
  "notification_channel",
  {
    id: id(),
    householdId: householdId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The URL's scheme (ntfys, pover…), to show which service it is without opening it. */
    service: text("service").notNull(),
    urlSealed: text("url_sealed").notNull(),
    /** Last day a reminder went out, so the daily job sends at most one a day. */
    lastNotifiedOn: text("last_notified_on"),
    /** Why the last send failed; null once one works. */
    lastError: text("last_error"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("notification_channel_user_idx").on(t.userId, t.householdId)],
);

/**
 * A room scan (lib/room-scans.ts): one to five photos of a room or box; the vision model lists what it sees
 * (`candidates`, with boxes where the model gives them), someone ticks what to keep, and those become items there.
 * pending (being looked at) → ready (to review) → done (items made) | failed. Its photos are stored encrypted
 * (`roomscan/<id>/<n>`) for as long as the scan is kept; dismissed scans go to the purge like other deleted rows.
 */
export const roomScan = sqliteTable(
  "room_scan",
  {
    id: id(),
    householdId: householdId(),
    locationId: text("location_id").references(() => location.id, { onDelete: "set null" }),
    /** A box scanned instead of a room: what's found goes inside it. */
    containerItemId: text("container_item_id").references((): AnySQLiteColumn => item.id, { onDelete: "set null" }),
    status: text("status").$type<RoomScanStatus>().notNull().default("pending"),
    photoCount: integer("photo_count").notNull(),
    candidates: text("candidates", { mode: "json" }).$type<RoomScanCandidate[]>(),
    error: text("error"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("room_scan_household_idx").on(t.householdId, t.status)],
);

/**
 * A label someone brought: a pre-printed asset tag or QR sticker from elsewhere, stuck on an item or box. Scanning it
 * opens the item, like Ferret's own labels. `code` as scans store it (stock.scanKey: product codes as 13-digit EAN,
 * anything else as scanned); unique per household — two households can buy the same roll of stickers.
 */
export const ownLabel = sqliteTable(
  "own_label",
  {
    id: id(),
    householdId: householdId(),
    code: text("code").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("own_label_code_idx").on(t.householdId, t.code), index("own_label_item_idx").on(t.householdId, t.itemId)],
);

/**
 * A QR label: a short code (printed with its QR) that opens a box or a place.
 * Labels can be printed blank and claimed later — stick one on a box while
 * packing, scan it, "this is a new box". Codes are unique across all households.
 */
export const label = sqliteTable(
  "label",
  {
    id: id(),
    householdId: householdId(),
    code: text("code").notNull().unique(),
    itemId: text("item_id").references(() => item.id, { onDelete: "set null" }),
    locationId: text("location_id").references(() => location.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("label_item_idx").on(t.householdId, t.itemId), index("label_location_idx").on(t.householdId, t.locationId)],
);

/**
 * Ferret's own barcode book, shared by every household on this server: what a
 * barcode is — learned from items people save with it ("ferret"), or, for codes
 * nobody has named yet, from the online product database ("upcitemdb",
 * optional). It outlives the items. A name someone saved wins over the database.
 * Global, so no household-only data here: no categories, no (encrypted) photos.
 */
export const barcodeProduct = sqliteTable("barcode_product", {
  barcode: text("barcode").primaryKey(), // digits only
  /** Null while nothing is known (see notFoundAt). */
  name: text("name"),
  brand: text("brand"),
  model: text("model"),
  source: text("source").$type<"ferret" | "upcitemdb">(),
  /** What the online database said (photos, prices, description), when it was asked. */
  external: text("external", { mode: "json" }).$type<ProductInfo>(),
  /** When the online database last didn't know it (asked again after a month). */
  notFoundAt: integer("not_found_at", { mode: "timestamp_ms" }),
  updatedAt: timestamps.updatedAt,
});

/**
 * A household's own barcode book: what its people called the thing with this barcode, learned from items they
 * saved. Kept per household — item names are the household's words, not public facts, so they never reach
 * another household (barcode_product holds only what the online database says).
 */
export const householdBarcode = sqliteTable(
  "household_barcode",
  {
    householdId: householdId(),
    barcode: text("barcode").notNull(), // digits only, as productCode()
    name: text("name").notNull(),
    brand: text("brand"),
    model: text("model"),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [primaryKey({ columns: [t.householdId, t.barcode] })],
);

/**
 * Each backup (lib/backup.ts): the whole server's, not one household's — the database and every household's files
 * go together. The newest rows say how backups are doing (Settings, the bell); old ones are pruned.
 */
export const backupRun = sqliteTable("backup_run", {
  id: id(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  /** "running" | "ok" | "failed". */
  status: text("status").$type<"running" | "ok" | "failed">().notNull(),
  /** The snapshot's name in the backup folder. */
  snapshot: text("snapshot"),
  /** Encrypted database copy, bytes. */
  dbBytes: integer("db_bytes"),
  /** Files the snapshot needs, and how many of them were new this time. */
  files: integer("files"),
  filesCopied: integer("files_copied"),
  filesBytes: integer("files_bytes"),
  /** What the restore check found, in words ("12 items, 30 files; 3 opened"). */
  checked: text("checked"),
  error: text("error"),
});

/** Settings of the whole server, not of a household: `admin` = the server admin's user id (lib/server-admin.ts). */
export const serverSetting = sqliteTable("server_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date()),
});

/**
 * Scan to count (lib/stock.ts): what scanning a code does to an item — open it ("lookup", the default), take some out
 * ("use"), put some in ("restock"), or ask. Per household, so it stays out of the shared barcode book. `code` is a
 * product barcode as 13-digit EAN where it is one (products.productCode), `label:<CODE>` for Ferret's own QR labels,
 * or the code as scanned. One code can be on several items (spares in two places): the scan asks which, the one
 * scanned most recently first.
 */
export const stockRule = sqliteTable(
  "stock_rule",
  {
    id: id(),
    householdId: householdId(),
    code: text("code").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    behaviour: text("behaviour").$type<"lookup" | "use" | "restock" | "ask">().notNull().default("lookup"),
    /** How many one scan takes out or puts in (a 12-pack's barcode restocks 12). */
    step: integer("step").notNull().default(1),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("stock_rule_code_item_idx").on(t.householdId, t.code, t.itemId), index("stock_rule_item_idx").on(t.householdId, t.itemId)],
);

/** Every change to an item's count: by a scan, by hand, by editing the item, by an undo — who, how, and what it left. */
export const stockMovement = sqliteTable(
  "stock_movement",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    quantityAfter: integer("quantity_after").notNull(),
    /** "scan" | "manual" | "edit" | "undo" | "maintenance". */
    reason: text("reason").$type<"scan" | "manual" | "edit" | "undo" | "maintenance">().notNull(),
    note: text("note"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    via: text("via").notNull(),
    /** Set when it was undone (by a later "undo" movement). */
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
    /** A scan made offline and sent later carries the phone's own id for it, so sending it twice changes the count once. */
    clientId: text("client_id"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("stock_movement_item_idx").on(t.householdId, t.itemId, t.createdAt),
    uniqueIndex("stock_movement_client_idx").on(t.householdId, t.clientId),
  ],
);

/**
 * Smart-home pairing codes on an item (lib/pairing.ts): HomeKit or Matter. The code and the QR's text are a secret —
 * anyone on the network with them can pair with a reset accessory — so they're sealed with the household key (`sealed`:
 * FileStore.seal, label `pairing:<id>`). Only what's needed to list them is plain.
 */
export const pairingCode = sqliteTable(
  "pairing_code",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"homekit" | "matter">().notNull(),
    /** A note: "the bridge", "back door". */
    label: text("label"),
    /** HomeKit's category ("Door lock"), when the QR says. */
    category: text("category"),
    /** Whether the QR's text is kept (it can be shown as a QR again). */
    hasQr: integer("has_qr", { mode: "boolean" }).notNull().default(false),
    sealed: text("sealed").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("pairing_code_item_idx").on(t.householdId, t.itemId)],
);

/**
 * A read-only link to the insurance report (the whole household or one property), a tag's or a category's things —
 * for an insurer or an executor, no account needed (lib/shares.ts). The token is kept as a hash (to find the link)
 * and sealed with the household key (so its owner can copy it again); it stops at `expiresAt` or when turned off.
 */
export const shareLink = sqliteTable(
  "share_link",
  {
    id: id(),
    householdId: householdId(),
    kind: text("kind").$type<"report" | "tag" | "category">().notNull(),
    propertyId: text("property_id").references(() => property.id, { onDelete: "cascade" }),
    tag: text("tag"),
    categoryId: text("category_id").references(() => category.id, { onDelete: "cascade" }),
    /** Who it's for, as its maker put it ("State Farm claim"). */
    label: text("label"),
    /** Photos, receipts and manuals open from the link too. */
    includeFiles: integer("include_files", { mode: "boolean" }).notNull().default(true),
    tokenHash: text("token_hash").notNull(),
    tokenSealed: text("token_sealed").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    views: integer("views").notNull().default(0),
    lastViewedAt: integer("last_viewed_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("share_link_token_idx").on(t.tokenHash), index("share_link_household_idx").on(t.householdId)],
);

/** Each time a share link was opened: when, and from where. */
export const shareView = sqliteTable(
  "share_view",
  {
    id: id(),
    householdId: householdId(),
    linkId: text("link_id")
      .notNull()
      .references(() => shareLink.id, { onDelete: "cascade" }),
    at: timestamps.createdAt,
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [index("share_view_link_idx").on(t.linkId, t.at)],
);

/**
 * Lending (lib/loans.ts): a thing lent to someone, or borrowed from them, until it's back. A lent thing can email its
 * borrower a reminder every so often (`remindEvery`), with a link to say it's back or to stop the reminders (`token*`).
 */
export const loan = sqliteTable(
  "loan",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"lent" | "borrowed">().notNull(),
    person: text("person").notNull(),
    /** Lent: where reminders go (optional). */
    email: text("email"),
    since: text("since").notNull(), // ISO yyyy-mm-dd
    dueOn: text("due_on"),
    note: text("note"),
    /** "week" | "2weeks" | "month" — reminders by email to the borrower; null = none. */
    remindEvery: text("remind_every").$type<"week" | "2weeks" | "month">(),
    lastRemindedOn: text("last_reminded_on"),
    /** The borrower's page: "I've given it back" / "stop these reminders". */
    tokenHash: text("token_hash"),
    tokenSealed: text("token_sealed"),
    /** The borrower said it's back (it stays out until someone here agrees). */
    borrowerReturnedAt: integer("borrower_returned_at", { mode: "timestamp_ms" }),
    /** The borrower asked for no more reminders. */
    remindersStoppedAt: integer("reminders_stopped_at", { mode: "timestamp_ms" }),
    returnedOn: text("returned_on"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [index("loan_household_idx").on(t.householdId, t.returnedOn), index("loan_item_idx").on(t.itemId), uniqueIndex("loan_token_idx").on(t.tokenHash)],
);

/**
 * Product recalls from the CPSC (lib/recalls.ts) — public data, shared by every household, synced daily. `searchText`
 * is title, description, products and companies, normalised (lower case, letters and digits) for matching.
 */
export const recall = sqliteTable(
  "recall",
  {
    /** The CPSC's RecallID. */
    id: text("id").primaryKey(),
    number: text("number"),
    recalledOn: text("recalled_on").notNull(), // ISO yyyy-mm-dd
    title: text("title").notNull(),
    url: text("url"),
    description: text("description"),
    hazard: text("hazard"),
    remedy: text("remedy"),
    contact: text("contact"),
    /** Product names and models, and the companies (makers, importers, distributors), as given. */
    products: text("products", { mode: "json" }).$type<{ name: string; model: string }[]>().notNull(),
    companies: text("companies", { mode: "json" }).$type<string[]>().notNull(),
    upcs: text("upcs", { mode: "json" }).$type<string[]>().notNull(),
    imageUrl: text("image_url"),
    searchText: text("search_text").notNull(),
  },
  (t) => [index("recall_date_idx").on(t.recalledOn)],
);

/** A recall that matches one of a household's things, until someone says it isn't theirs or it's dealt with. */
export const itemRecall = sqliteTable(
  "item_recall",
  {
    id: id(),
    householdId: householdId(),
    itemId: text("item_id")
      .notNull()
      .references(() => item.id, { onDelete: "cascade" }),
    recallId: text("recall_id")
      .notNull()
      .references(() => recall.id, { onDelete: "cascade" }),
    /** "barcode" | "model": the same product; "possible": the same maker and kind of thing — check the model. */
    match: text("match").$type<"barcode" | "model" | "possible">().notNull(),
    /** open → dismissed ("not mine") or done ("dealt with it"). */
    status: text("status").$type<"open" | "dismissed" | "done">().notNull().default("open"),
    foundAt: timestamps.createdAt,
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("item_recall_pair_idx").on(t.itemId, t.recallId), index("item_recall_household_idx").on(t.householdId, t.status)],
);

/**
 * An insurance limit (lib/coverage.ts): the whole contents cover ("Coverage C"), or a special limit on a kind of thing
 * — jewelry, firearms — by category or tag; optionally for one property. Compared with what the inventory is worth.
 */
export const coverageLimit = sqliteTable(
  "coverage_limit",
  {
    id: id(),
    householdId: householdId(),
    label: text("label").notNull(),
    limitCents: integer("limit_cents").notNull(),
    scope: text("scope").$type<"all" | "category" | "tag">().notNull(),
    propertyId: text("property_id").references(() => property.id, { onDelete: "cascade" }),
    categoryId: text("category_id").references(() => category.id, { onDelete: "cascade" }),
    tag: text("tag"),
    note: text("note"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [index("coverage_limit_household_idx").on(t.householdId)],
);

/** One person's settings in one household: the weekly summary (lib/digest.ts). */
export const personSetting = sqliteTable(
  "person_setting",
  {
    householdId: householdId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The weekly summary's day, 0 = Sunday … 6 = Saturday; null = none. */
    weeklyDay: integer("weekly_day"),
    /** Also by email to the account's address. */
    weeklyEmail: integer("weekly_email", { mode: "boolean" }).notNull().default(false),
    lastWeeklyOn: text("last_weekly_on"),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] })],
);

/** Brands already asked about (lib/recalls.ts): the CPSC's answer is kept and asked for again after a week. */
export const recallBrand = sqliteTable("recall_brand", {
  /** The brand, normalised ("black decker"). */
  brand: text("brand").primaryKey(),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
  /** How many recalls the CPSC had for it. */
  found: integer("found").notNull().default(0),
});

/**
 * Failed calls to the services Ferret depends on (lib/service-errors.ts) — the AI models, the vector store, docling,
 * Apprise, push, the barcode and recall databases, maps — one row per service and message, counted. For the server
 * admin: Settings → Server, the bell, and an alert when a service starts failing.
 */
export const serviceError = sqliteTable(
  "service_error",
  {
    id: id(),
    service: text("service").notNull(),
    /** What failed: the port's method ("embed", "send"…). */
    operation: text("operation").notNull(),
    message: text("message").notNull(),
    count: integer("count").notNull().default(1),
    /**
     * The latest one's details, for triage (JSON: lib/service-errors.ts FailureRecord) — how long it took, where it was
     * called from, what the adapter knew (ports.ts FailureDetail). Never prompts or what people own.
     */
    detail: text("detail"),
    firstAt: integer("first_at", { mode: "timestamp_ms" }).notNull(),
    lastAt: integer("last_at", { mode: "timestamp_ms" }).notNull(),
    /** When the server admin was last told about this one. */
    notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("service_error_key_idx").on(t.service, t.operation, t.message), index("service_error_last_idx").on(t.lastAt)],
);

/**
 * What each person used, per plan period (lib/plan.ts): AI actions by kind and online barcode lookups — counted on
 * every server, limited only by a plan (Deps.entitlements). `userId` "" is the household's own background work.
 */
export const planUsage = sqliteTable(
  "plan_usage",
  {
    householdId: householdId(),
    /** The plan's period start (yyyy-mm-dd), or the calendar month (yyyy-mm) without a plan. */
    period: text("period").notNull(),
    userId: text("user_id").notNull().default(""),
    /** lib/plan.ts UsageKind: "ai.photo", "ai.document", "ai.ask", "barcode.lookup". */
    kind: text("kind").notNull(),
    units: integer("units").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.period, t.userId, t.kind] })],
);

/**
 * Invitations emailed (lib/invitation-email.ts): Better Auth's `invitation` holds the invitation itself; this is when
 * Ferret last emailed its link, or why that failed — Settings → Household's "Sent by email" and Send again.
 */
export const invitationEmail = sqliteTable(
  "invitation_email",
  {
    invitationId: text("invitation_id")
      .primaryKey()
      .references(() => invitation.id, { onDelete: "cascade" }),
    householdId: householdId(),
    /** When the email was queued (Invite, or Send again). */
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    /** When it last went out; null while it's waiting (or if it never could). */
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    /** Why the last try failed, for whoever invited them. */
    error: text("error"),
  },
  (t) => [index("invitation_email_household_idx").on(t.householdId, t.sentAt)],
);
