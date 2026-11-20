/**
 * Ports — the small set of interfaces that keep Ferret portable.
 *
 * Core code only talks to these; the adapters in src/adapters/local implement them for the Node server (server.ts):
 *
 *   Db        → SQLite file (libSQL); any SQLite with async queries, ≤ 100 bound parameters a query, no transactions
 *   Blobs     → folder on disk (encrypted)
 *   Vectors   → Qdrant
 *   AI        → Ollama (vision + embeddings)
 *   Jobs      → in-process SQLite job runner
 *   Images    → sharp (libvips)
 *   Documents → docling-serve
 *   Reranker  → bge-reranker on vLLM
 *   Chat      → gpt-oss on vLLM (text)
 *   Notifier  → apprise-api (ntfy, Pushover…)
 *   Downloader→ node:https, public IPs only
 *   WebhookSender → node:http(s); public IPs only unless the server admin set it up
 *   Backups   → VACUUM INTO + a folder (NAS)
 *   HomeAssistant → its WebSocket API (LAN)
 *   Recalls   → CPSC's recall API (fetch)
 *   Speech    → a Whisper-style transcription server (OpenAI-compatible /v1/audio/transcriptions)
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { CardGame, CardInfo, PlanLimits } from "@ferret/shared";
import type * as schema from "./db/schema";
import type { Catalogs } from "./lib/language";

/** Drizzle database — sync (libSQL) or async drivers alike. Always `await` queries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = BaseSQLiteDatabase<"sync" | "async", any, typeof schema>;

/**
 * What an adapter knows about a failed call that helps tell why: the model, why its reply stopped, sizes, tokens,
 * attempts — kept with the service error log's entry and emailed to the server admin (lib/service-errors.ts). Never
 * what people typed or own: no prompts, no item names (a model's reply only as its first and last few words).
 */
export type FailureDetail = Record<string, string | number | boolean | null | undefined>;

/** An adapter's error with its FailureDetail. Callers see an ordinary Error. */
export class ServiceFailure extends Error {
  constructor(
    message: string,
    readonly detail: FailureDetail,
  ) {
    super(message);
    this.name = "ServiceFailure";
  }
}

export interface BlobObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
}

export interface Blobs {
  put(key: string, data: ReadableStream<Uint8Array> | Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}

export interface VectorPoint {
  /** A UUID. */
  id: string;
  vector: number[];
  payload: Record<string, string | number>;
}

/** How many times an event happened on a day (UTC), and for a visit, from which `?ref=`. */
export interface AnalyticsCount {
  day: string;
  event: string;
  ref: string | null;
  n: number;
}

/** Counts of events — nothing about people (lib/analytics.ts). `count` never waits; `report` reads them back. */
export interface Analytics {
  count(event: string, ref?: string): void;
  /** The last `days` days' counts, or null when they can't be read from here. */
  report?(days: number): Promise<AnalyticsCount[] | null>;
}

/**
 * What the hosting itself has used, against what its plan includes — Settings → Server → Demo, for whoever pays for a
 * public demo's hosting. Plain rows, worded by the service: Ferret only draws them.
 */
export interface HostingUsage {
  report(now: Date): Promise<HostingUsageReport>;
}

export interface HostingUsageReport {
  /** The card's heading, e.g. "Hosting this month". */
  title: string;
  /** A line under it: what's counted, how fresh. */
  note?: string;
  /** Each metered thing, with what the plan includes (shown as a bar). */
  rows: { label: string; used: number; included: number; unit?: "bytes" }[];
  /** More detail, folded away: a summary line and label/value rows. */
  details?: { summary: string; rows: { label: string; value: string }[] };
}

/** Redeems a token from a person-check widget (once): whether it passed, for which action, on which hostname. */
export interface HumanCheck {
  verify(token: string, ip?: string): Promise<{ success: boolean; action?: string; hostname?: string; issuedAt?: number }>;
}

export interface Vectors {
  upsert(points: VectorPoint[]): Promise<void>;
  /** Nearest points whose payload matches every key/value in `filter` (always include householdId). */
  query(
    vector: number[],
    opts: { limit: number; filter: Record<string, string> },
  ): Promise<{ id: string; score: number; payload: Record<string, string | number> }[]>;
  deleteWhere(filter: Record<string, string>): Promise<void>;
  /**
   * Which store this is ("Qdrant gpu.lan:6333/ferret"), for the search index's signature (lib/search-index.ts): a
   * different one starts empty, so every item is embedded again.
   */
  readonly store?: string;
  /** Removes every point — when the embedding model changed, so old and new vectors never mix. */
  clear?(): Promise<void>;
}

/**
 * A model that replies with JSON shaped by `schema` (JSON Schema). `maxTokens`: a ceiling on the reply, thinking
 * included — for long answers (a room's list) a model can otherwise reason on for minutes.
 */
export interface TextModel {
  json(request: { prompt: string; schema: object; image?: { data: Uint8Array; contentType: string }; maxTokens?: number }): Promise<unknown>;
}

/** The vision + embedding models (json() accepts an image). */
export interface Ai extends TextModel {
  /** One vector per text. Queries and documents can differ (instruction-tuned embedding models). */
  embed(texts: string[], purpose: "document" | "query"): Promise<number[][]>;
  /** The embedding model's name, for the search index's signature: when it changes, every item is embedded again. */
  readonly embedModel?: string;
}

/** Speech to text: a short recording (naming things during a walkthrough). */
export interface Speech {
  /** The words said, or "" for none. Throws when the server can't be reached or refuses it. */
  transcribe(audio: Uint8Array, contentType: string): Promise<string>;
}

export interface Reranker {
  /** How well each document answers the query (0–1), in the same order as `documents`. */
  rerank(query: string, documents: string[]): Promise<number[]>;
}

export interface Documents {
  /** Converts a PDF or document image to Markdown. Slow (minutes for long PDFs): call it from a job. */
  toMarkdown(data: Uint8Array, filename: string, contentType: string): Promise<string>;
}

/** A trading card game's catalog (TCGdex for Pokémon, Scryfall for Magic): cards by what's printed on them, and prices. */
export interface CardCatalog {
  /** Cards matching what was read or typed, best first (at most a dozen). Empty when none. */
  find(q: { name?: string | null; number?: string | null; setTotal?: string | null; setCode?: string | null }): Promise<CardInfo[]>;
  /** One card by its catalog id, with today's prices. Null when the catalog has no such card. */
  get(id: string): Promise<CardInfo | null>;
}

export interface Jobs {
  enqueue(type: string, payload: unknown): Promise<void>;
}

/**
 * Runs one background job. Throw to have it retried later (with backoff);
 * `lastAttempt` is true when this is the final try, so it can record the failure.
 */
export type JobHandler = (payload: unknown, ctx: { lastAttempt: boolean }) => Promise<void>;

export type { ProductInfo } from "@ferret/shared";
import type { ProductInfo } from "@ferret/shared";

export interface ProductLookup {
  /** The product, or null if the database doesn't know the code. Throws on network errors or a used-up quota (retry later). */
  lookup(barcode: string): Promise<ProductInfo | null>;
  /** What the database said is left of its allowance at the last lookup, if it says (Settings → Server). */
  quota?(): ProductQuota | null;
}

/** An online barcode database's allowance, as it reported it. */
export interface ProductQuota {
  limit: number;
  remaining: number;
  /** When it fills up again. */
  resetsAt: Date;
}

/** A small map picture of an address, centred on it with a pin (Apple Maps Web Snapshots). */
export interface MapImages {
  /** PNG bytes. Throws if the map service fails or doesn't know the address. */
  snapshot(address: string, opts: { scheme: "light" | "dark" }): Promise<Uint8Array<ArrayBuffer>>;
}

/** A product recall as the CPSC's API gives it (the fields Ferret reads). */
export interface RawRecall {
  RecallID: number;
  RecallNumber?: string;
  RecallDate: string;
  Title: string;
  Description?: string;
  URL?: string;
  ConsumerContact?: string;
  Products?: { Name?: string; Model?: string; Type?: string }[];
  Manufacturers?: { Name?: string }[];
  Importers?: { Name?: string }[];
  Distributors?: { Name?: string }[];
  Hazards?: { Name?: string }[];
  Remedies?: { Name?: string }[];
  Images?: { URL?: string }[];
  ProductUPCs?: ({ UPC?: string } | string)[];
}

/** Product recalls (the CPSC's public data). */
export interface Recalls {
  /** Every recall naming this brand (in its title, or as its maker). Throws on network trouble (try again later). */
  forBrand(brand: string): Promise<RawRecall[]>;
}

/** A VIN as NHTSA's vPIC decodes it (empty values left out). */
export interface RawVinDecode {
  make: string | null;
  model: string | null;
  year: number | null;
  trim: string | null;
  body: string | null;
  displacementL: number | null;
  cylinders: number | null;
  fuel: string | null;
  drive: string | null;
}

/** One NHTSA recall campaign for a make, model and year. */
export interface RawVehicleRecall {
  campaign: string;
  /** yyyy-mm-dd. */
  reportedOn: string;
  manufacturer: string | null;
  component: string | null;
  summary: string | null;
  consequence: string | null;
  remedy: string | null;
  notes: string | null;
}

/** NHTSA's public vehicle data (switched on by the server admin: Settings → Server). Throws on network trouble. */
export interface VehicleData {
  /** What a VIN says (make, model, year…), or null when NHTSA can't decode it. */
  decodeVin(vin: string): Promise<RawVinDecode | null>;
  /** Every recall campaign for this make, model and model year. */
  recalls(make: string, model: string, year: number): Promise<RawVehicleRecall[]>;
}

/** iFixit's public device search (switched on by the server admin: Settings → Server). Throws on network trouble. */
/** What YouTube says about a video (how-to videos on maintenance tasks). */
export interface VideoInfo {
  videoId: string;
  title: string;
  channel: string | null;
  /** Only with a key (oEmbed doesn't say). */
  seconds: number | null;
}
export interface Videos {
  /** A video's title and channel; null when YouTube says there's no such (public, embeddable) video. */
  describe(videoId: string): Promise<VideoInfo | null>;
  /** YouTube's search (embeddable videos only, best first) — only with a YouTube key; absent without one. */
  search?(query: string): Promise<VideoInfo[]>;
}

export interface RepairGuides {
  /** Devices iFixit has guides for, best match first: their title and their page (always on www.ifixit.com). */
  searchDevices(query: string): Promise<{ title: string; url: string }[]>;
}

/** Home Assistant's registries as its WebSocket API returns them (the fields an import reads). */
export interface HaRegistry {
  floors: { floor_id: string; name: string; level?: number | null }[];
  areas: { area_id: string; name: string; floor_id?: string | null }[];
  devices: {
    id: string;
    name: string | null;
    name_by_user?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    model_id?: string | null;
    serial_number?: string | null;
    area_id?: string | null;
    entry_type?: string | null;
    disabled_by?: string | null;
    via_device_id?: string | null;
    configuration_url?: string | null;
    primary_config_entry?: string | null;
    config_entries?: string[];
    connections?: [string, string][];
    identifiers?: [string, string][];
  }[];
  configEntries: { entry_id: string; domain: string; title: string }[];
}

/** Reads Home Assistant's floors, areas and devices once, for an import. Nothing is kept: not the token, not the answer. */
export interface HomeAssistant {
  /** Throws HomeAssistantError with words a person can act on (can't reach it, token refused, not Home Assistant). */
  registry(url: string, token: string): Promise<HaRegistry>;
}

export class HomeAssistantError extends Error {}

/** Where a browser said to deliver its push messages (the PWA's PushSubscription). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Push {
  /** The VAPID public key browsers subscribe with. */
  publicKey: string;
  /** "gone" = the browser unsubscribed or the subscription expired: forget it. */
  send(target: PushTarget, message: { title: string; body: string; url: string; tag?: string }): Promise<"sent" | "gone">;
}

/** Notifications to other apps — ntfy, Pushover, Telegram, email… — each addressed by an Apprise URL. */
export interface Notifier {
  /**
   * Throws, with a reason a person can act on, if it wasn't delivered. `html`: Ferret's own emails (lib/email.ts) —
   * used for email addresses only; everything else gets `body`.
   */
  send(url: string, message: { title: string; body: string; html?: string }): Promise<void>;
}

/**
 * Downloads a file someone gave the address of — from the public internet only:
 * never a private, loopback, link-local or other internal address (else anyone who
 * can add a photo could make the server reach into the LAN), checked on every hop.
 */
export interface Downloader {
  /**
   * Only files it's told to accept: refused unread if the server declares another type (`contentTypes`; HTML,
   * scripts, SVG… never), and dropped after the first bytes if they aren't one (`accepts`, a file-signature check).
   * Nothing downloaded is ever run. Throws DownloadError with a reason a person can act on.
   */
  get(
    url: string,
    opts: { maxBytes: number; contentTypes: readonly string[]; accepts: (head: Uint8Array) => boolean },
  ): Promise<{ bytes: Uint8Array; filename: string | null; finalUrl: string }>;
}

/** Why a download didn't work, in words for the person who asked for it. */
export class DownloadError extends Error {}

/**
 * Posts a household's webhook events (lib/webhooks.ts) to the address it gave. Redirects are never followed (a 3xx is
 * an answer like any other). Without `allowLocal`, only addresses on the public internet — checked when connecting,
 * so a name can't point inside the network — else anywhere the server can reach (its own network: n8n, Home
 * Assistant), which only whoever runs the server can set up.
 */
export interface WebhookSender {
  /** The receiver's HTTP status. Throws WebhookError with a reason a person can act on when it couldn't be posted. */
  post(url: string, body: string, headers: Record<string, string>, opts: { allowLocal: boolean }): Promise<{ status: number }>;
}

/** Why a webhook couldn't be posted (couldn't connect, took too long, an address it may not use). */
export class WebhookError extends Error {}

/** Where a household's Paperless-ngx is, and how Ferret signs in to it. */
export interface PaperlessServer {
  url: string;
  token: string;
  /** May be on the server's own network (set up by whoever runs this Ferret). */
  allowLocal: boolean;
}

/** A document as Paperless lists it (API version 9). */
export interface PaperlessDoc {
  id: number;
  title: string;
  correspondent: number | null;
  /** yyyy-mm-dd */
  created: string | null;
  mimeType: string | null;
  content: string;
  tags: number[];
}

/** A household's Paperless-ngx, read with its API token — only ever read: Ferret changes nothing there. */
export interface Paperless {
  /** Who the token signs in as. */
  whoAmI(server: PaperlessServer): Promise<{ user: string }>;
  /** The tag with this name (case doesn't matter), or null. */
  findTag(server: PaperlessServer, name: string): Promise<{ id: number; name: string } | null>;
  /** Documents, newest added first: with a tag, or matching words (Paperless's full-text search). */
  documents(server: PaperlessServer, q: { tagId?: number; query?: string; page?: number; pageSize?: number }): Promise<{ count: number; more: boolean; results: PaperlessDoc[] }>;
  /** Correspondents' names by id. */
  correspondents(server: PaperlessServer, ids: number[]): Promise<Map<number, string>>;
  /** The document's file (its archived PDF when Paperless made one), up to `maxBytes`. */
  download(server: PaperlessServer, id: number, maxBytes: number): Promise<{ bytes: Uint8Array; filename: string; contentType: string }>;
  /** Paperless's small picture of it. */
  thumbnail(server: PaperlessServer, id: number): Promise<{ bytes: Uint8Array; contentType: string }>;
}

/** Why Paperless couldn't be read, in words a person can act on. `status` is Paperless's answer when there was one. */
export class PaperlessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Images {
  /**
   * The image no larger than `maxSize` px on its longest side, rotated upright
   * and stripped of metadata (no GPS). Null if the image can't be decoded.
   */
  resize(data: Uint8Array, maxSize: number, format: "webp" | "jpeg"): Promise<Uint8Array | null>;
}

/**
 * A PDF's first page as a picture (PNG), no larger than `maxSize` px on its longest side — for its thumbnail. Null if
 * it can't be drawn (damaged, encrypted, too slow). The PDF is untrusted: nothing in it may run.
 */
export interface PdfPages {
  firstPage(pdf: Uint8Array, maxSize: number): Promise<Uint8Array | null>;
  /**
   * The text the PDF itself carries, page by page (up to `maxPages`; "" for a page with none, like a scan) — what a
   * document reader can miss (tables, a page it took for a picture). Null if it can't be read.
   */
  pageTexts?(pdf: Uint8Array, maxPages: number): Promise<string[] | null>;
}

/**
 * Where backups are written: a flat set of named files (e.g. a folder on the NAS). Names use `/` for folders.
 * Each write is all-or-nothing, so a half-written file never passes for a backup.
 */
export interface BackupTarget {
  /** Where it is, for people (e.g. the folder's path). */
  where: string;
  put(name: string, data: Uint8Array): Promise<void>;
  get(name: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Its size in bytes, or null if it isn't there. */
  size(name: string): Promise<number | null>;
  /** Every name under `prefix` (e.g. "files/"), at any depth. */
  list(prefix: string): Promise<string[]>;
  delete(name: string): Promise<void>;
}

/** Copies of the whole database. */
export interface DbSnapshots {
  /** A consistent copy of the live database (SQLite file bytes), taken while the app keeps running. */
  take(): Promise<Uint8Array<ArrayBuffer>>;
  /** Opens a copy on its own, to check it (`close` when done). */
  open(bytes: Uint8Array): Promise<{ db: Db; close(): Promise<void> }>;
}

/** Where search by meaning draws its lines — calibrated per set of models (lib/search.ts SEARCH_PROFILES). */
export interface SearchProfile {
  /** Below this embedding similarity, a meaning match is noise. */
  minScore: number;
  /** Alongside word matches, meaning matches must be this strong. */
  strongScore: number;
  /** Reranker relevance that's a match on its own. */
  rerankMatch: number;
  /** With a judge, meaning matches down to this go to it. */
  judgeFloor: number;
  /** A meaning match this strong is sure: shown at once, never judged. */
  sureScore: number;
  /** Two items' summaries this alike are likely the same thing (lib/duplicates.ts); a little less when in the same place. */
  duplicateScore?: number;
  duplicateScoreSamePlace?: number;
}

/** A household's plan (Deps.entitlements). */
export interface HouseholdPlan {
  name: string;
  limits: PlanLimits;
  /** The period usage is counted in (e.g. the subscription's month); without one, the calendar month (UTC). */
  period?: { start: string; end?: string };
  /** Where the household's owner upgrades, and manages billing (the service's pages; Ferret only links to them). */
  upgradeUrl?: string;
  manageUrl?: string;
  /** More of the service's own pages for the owner, beside those. */
  links?: { label: string; url: string }[];
  /**
   * A line about the plan's state, in the service's words, shown on Settings → Usage (e.g. "Cancelled — Plus stays on
   * until October 22, 2027", "Free trial until …"). Plain text.
   */
  status?: string;
}

/**
 * Plans (lib/plan.ts): what each household may do. Ferret itself has none — without this port everything is
 * unlimited.
 */
export interface Entitlements {
  /** The household's plan, or null for no plan (no limits). */
  plan(householdId: string): Promise<HouseholdPlan | null>;
  /**
   * Whether this account may start another household: null if it may, else why not (e.g. a service allowing one free
   * household per account). Without it, only Ferret's own ceiling applies (10 an account).
   */
  mayCreateHousehold?(userId: string): Promise<string | null>;
}

/** The last backup made somewhere else (Deps.backupElsewhere) — for Settings → Server and the admin's bell. */
export interface BackupElsewhere {
  /** Where the copies go, in words. */
  where: string;
  /** The newest run, if any has reported yet. */
  latest(): Promise<{ at: Date; ok: boolean; detail: string | null } | null>;
}

/** What a certificate says (lib/certificates.ts). */
export interface CertificateDetails {
  subject: string;
  issuer: string;
  notAfter: Date;
  /** SHA-256, as hex pairs. */
  fingerprint: string;
}

/**
 * Ferret's own connections to your other services (Home Assistant, the models, Apprise, the sign-in provider…):
 * certificate authorities to trust besides the public ones, and client certificates to present (mutual TLS) — Settings →
 * Server → Certificates. Never for downloads from the internet, which trust only the public authorities.
 */
export interface TlsSettings {
  /** The certificates in a PEM (one or more). Throws if there are none, or it holds a private key. */
  readPem(pem: string): CertificateDetails[];
  /** A PKCS#12 (.p12/.pfx) file's own certificate. Throws on a wrong password or a broken file. */
  readPkcs12(bytes: Uint8Array, password: string): CertificateDetails;
  /** Use these from now on, in place of what was applied before. A client certificate goes only to its hosts. */
  apply(trusted: string[], clients: { hosts: string[]; pkcs12: Uint8Array; password: string }[]): void;
}

/**
 * How much of a document is kept and searched, for a runtime that needs limits (small database values, short jobs).
 * Absent — a server of its own (server.ts) — a manual is kept, searched and embedded whole.
 */
export interface DocumentLimits {
  /** Characters of a document's text kept (what keyword search and Ask read). */
  textChars?: number;
  /** Pages of a PDF's own text layer read (to fill in what the document reader missed). */
  pdfPages?: number;
  /** ~1,500-character pieces of a document embedded for search by meaning. */
  chunks?: number;
}

/** Everything the app needs, injected at startup by the entry point (server.ts, or another runtime's). */
export interface Deps {
  db: Db;
  blobs: Blobs;
  /** Limits on documents' text (absent: none). */
  documentLimits?: DocumentLimits;
  vectors?: Vectors;
  ai?: Ai;
  jobs?: Jobs;
  /** Without it, photos are stored without thumbnails and the grid falls back to originals. */
  images?: Images;
  /** Thumbnails for PDFs (their first page). */
  pdfPages?: PdfPages;
  documents?: Documents;
  /** Optional second pass for search: better ordering and snippets, and rescues exact passages. */
  reranker?: Reranker;
  /** A stronger text model for questions and reading documents (falls back to `ai`). */
  chat?: TextModel;
  /** Speech to text, for naming things aloud during a walkthrough (needs SPEECH_URL). */
  speech?: Speech;
  /** Web Push for maintenance reminders (needs VAPID keys). */
  push?: Push;
  /** Reminders to other apps through Apprise (needs APPRISE_URL). */
  notifier?: Notifier;
  /** Photos and documents from a web address (public internet only). */
  downloader?: Downloader;
  /** Households' webhooks (Settings → Claude & API). Without it, webhooks are off. */
  webhooks?: WebhookSender;
  /** A household's Paperless-ngx (lib/paperless.ts). Absent: the Paperless connection is hidden. */
  paperless?: Paperless;
  /** Barcode → product details (UPCitemdb), for naming scanned things. */
  products?: ProductLookup;
  /** Map pictures of properties' addresses (Apple Maps, needs a Maps key). */
  maps?: MapImages;
  /** Nightly backups of the database and files (needs BACKUP_DIR). */
  backups?: { snapshots: DbSnapshots; target: BackupTarget };
  /** Importing devices from Home Assistant (its address and a token are given with each import). */
  homeAssistant?: HomeAssistant;
  /** Product recalls to check things against (switched on by the server admin: Settings → Server). */
  recalls?: Recalls;
  /** NHTSA: VINs decoded and vehicle recalls (switched on by the server admin: Settings → Server). */
  vehicles?: VehicleData;
  /** Open Library: books by ISBN, a second barcode book source (switched on by the server admin: Settings → Server). */
  books?: ProductLookup;
  /** Trading card catalogs (Pokémon: TCGdex; Magic: Scryfall), for "Scan cards" (switched on in Settings → Server). */
  cards?: Partial<Record<CardGame, CardCatalog>>;
  /** Open Food Facts, Open Products Facts, Open Beauty Facts: asked when the product database doesn't know a code (switched on in Settings → Server). */
  openFacts?: ProductLookup;
  /** MusicBrainz: CDs and records by barcode, asked when someone scans as music (switched on in Settings → Server). */
  music?: ProductLookup;
  /** iFixit: a "Repair guides" link for things whose brand and model it knows (switched on in Settings → Server). */
  repairGuides?: RepairGuides;
  /** YouTube: how-to videos on maintenance tasks (lib/videos.ts) — describe a pasted link; search with a key. */
  videos?: Videos;
  /** Search's cut-offs for these models (default: "home", lib/search.ts). */
  searchProfile?: SearchProfile;
  /**
   * The server's text in other languages (lib/language.ts): each language's translations by Lingui message id, made
   * with the web app's (apps/web/scripts/translations.mjs prepare). Without it, everything is English.
   */
  catalogs?: Catalogs;
  /** "Are you a person?" before sign-up (a Turnstile widget, lib/turnstile.ts). */
  humanCheck?: HumanCheck;
  /** Counts of what the demo's visitors do (lib/analytics.ts). */
  analytics?: Analytics;
  /** What the demo's hosting has used, against its plan (Settings → Server → Demo). */
  hostingUsage?: HostingUsage;
  /** Households' plans and their limits (lib/plan.ts) — without it, no limits. */
  entitlements?: Entitlements;
  /** Backups that run outside this server (none here: `backups` is Ferret's own). */
  backupElsewhere?: BackupElsewhere;
  /** Certificates for Ferret's own connections (Settings → Server → Certificates) — where the runtime allows it. */
  tls?: TlsSettings;
  /**
   * Where each secret came from — the settings, or made by Ferret and kept in the data folder (server.ts,
   * adapters/local/secrets.ts). Absent: all from the settings (another runtime's own).
   */
  secrets?: {
    sources: Partial<Record<"AUTH_SECRET" | "FILES_KEY" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY", "settings" | "ferret">>;
    file: string;
    /** FILES_KEY's fingerprint (lib/files.ts masterKeyId). */
    filesKeyId: string;
  };
}
