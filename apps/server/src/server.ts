/**
 * Node entry point (Docker). Wires local adapters into the app,
 * runs migrations, and serves the built web app from the same port.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { FsBlobs } from "./adapters/local/blobs";
import { FolderBackupTarget, SqliteSnapshots } from "./adapters/local/backup";
import { OpenAiModels } from "./adapters/local/ai";
import { OpenAiChat } from "./adapters/local/chat";
import { createLocalDb, runMigrations } from "./adapters/local/db";
import { ensureDataDir } from "./adapters/local/data-dir";
import { MissingSecret, SECRETS_FILE, resolveSecrets } from "./adapters/local/secrets";
import { DoclingDocuments } from "./adapters/local/docling";
import { SharpImages } from "./adapters/local/images";
import { PdfJsPages } from "./adapters/local/pdf";
import { DbJobs } from "./adapters/local/jobs";
import { WebCryptoPush } from "./lib/web-push";
import { SafeDownloader } from "./adapters/local/download";
import { AppriseNotifier } from "./adapters/local/apprise";
import { NodeWebhookSender } from "./adapters/local/webhooks";
import { UpcItemDb } from "./adapters/local/upcitemdb";
import { AppleMapSnapshots } from "./adapters/local/apple-maps";
import { HomeAssistantWebSocket } from "./adapters/local/home-assistant";
import { CpscRecalls } from "./adapters/local/cpsc";
import { NhtsaVehicles } from "./adapters/local/nhtsa";
import { IfixitGuides } from "./adapters/local/ifixit";
import { OpenLibraryBooks } from "./adapters/local/openlibrary";
import { QdrantVectors } from "./adapters/local/qdrant";
import { VllmReranker } from "./adapters/local/reranker";
import { OpenAiSpeech } from "./adapters/local/speech";
import { docsScriptHashes, mountDocs, mountWebApp } from "./adapters/local/web";
import { markAuthProxy, proxyList, withClientAddress } from "./adapters/local/proxy";
import { NodeTls } from "./adapters/local/certificates";
import { applyCertificates } from "./lib/certificates";
import { otherMasterKeys } from "./lib/files";
import { createApp } from "./app";
import { jobSchedule } from "./jobs/schedule";
import { watched } from "./lib/service-errors";
import { doclingOptions, loadConfig, vapidSubject, vapidSubjectProblem } from "./config";

const here = path.dirname(fileURLToPath(import.meta.url));
// The data folder first: the secrets Ferret makes for you live in it (adapters/local/secrets.ts).
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "./data");
ensureDataDir(dataDir);

const { db } = createLocalDb(`file:${path.join(dataDir, "ferret.db")}`);
// Migrations live next to the bundle in production (dist/migrations) and in ./migrations in dev.
const migrationsFolder = [path.join(here, "migrations"), path.join(here, "../migrations")].find((p) => existsSync(p));
if (!migrationsFolder) throw new Error("Migrations folder not found");
await runMigrations(db, migrationsFolder);

// AUTH_SECRET, FILES_KEY and the push keys: the settings' where set, else the ones Ferret made (or makes now).
const secrets = await resolveSecrets({ dataDir, env: process.env, db }).catch((err: unknown) => {
  if (!(err instanceof MissingSecret)) throw err;
  console.error(err.message);
  process.exit(1);
});
const config = loadConfig(secrets.env);
if (secrets.made.length) {
  const list = secrets.made.length > 1 ? `${secrets.made.slice(0, -1).join(", ")} and ${secrets.made.at(-1)}` : secrets.made[0];
  console.log(`🔑 Made ${list}, kept in ${path.join(dataDir, SECRETS_FILE)}.`);
}
if (!config.publicUrlSet) {
  console.warn(
    `   ⚠ PUBLIC_URL isn't set: sign-ins work from local addresses it's opened at (an IP, umbrel.local…), but links it sends and passkeys use ${config.PUBLIC_URL}. Set PUBLIC_URL to the address people use.`,
  );
}
if (secrets.sources.FILES_KEY === "ferret") {
  console.log("   FILES_KEY is kept in the data folder. Save a copy elsewhere (Settings → Server shows how) — without it, no photo, document or backup can be opened.");
}

// A FILES_KEY other than the one the files were sealed with: stop now, not on the first photo.
const keys = await otherMasterKeys(db, config.FILES_KEY);
if (keys.needed.length) {
  console.error(
    [
      `FILES_KEY is not the key this server's files were sealed with.`,
      `  Set:    ${keys.set}`,
      `  Needed: ${keys.needed.join(", ")}`,
      `Put the original FILES_KEY back (your password manager), or recover it from a key file:`,
      `  node dist/cli.js key recover /path/to/ferret-key-${keys.needed[0]}.json`,
    ].join("\n"),
  );
  process.exit(1);
}

// Optional integrations switch on when configured (see config.ts).
const images = new SharpImages();
const pdfPages = new PdfJsPages();
const jobs = new DbJobs(db);
const apiKey = config.AI_API_KEY;
const ai = config.VISION_URL
  ? new OpenAiModels(
      { vision: config.VISION_URL, embed: config.EMBED_URL ?? config.VISION_URL, apiKey },
      { vision: config.VISION_MODEL, embed: config.EMBED_MODEL },
    )
  : undefined;
const chat = config.CHAT_URL
  ? new OpenAiChat(config.CHAT_URL, config.CHAT_MODEL, { reasoningEffort: config.CHAT_REASONING || undefined, apiKey })
  : undefined;
const documents = config.DOCLING_URL ? new DoclingDocuments(config.DOCLING_URL, doclingOptions(config)) : undefined;
const vectors =
  config.QDRANT_URL && ai ? new QdrantVectors(config.QDRANT_URL, config.QDRANT_API_KEY, config.QDRANT_COLLECTION) : undefined;
const reranker = config.RERANK_URL ? new VllmReranker(config.RERANK_URL, config.RERANK_MODEL, apiKey) : undefined;
const speech = config.SPEECH_URL ? new OpenAiSpeech(config.SPEECH_URL, config.SPEECH_MODEL, apiKey) : undefined;
const push =
  config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
    ? new WebCryptoPush(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, vapidSubject(config))
    : undefined;
const notifier = config.APPRISE_URL ? new AppriseNotifier(config.APPRISE_URL) : undefined;
const products = config.BARCODE_LOOKUP === "upcitemdb" ? new UpcItemDb(config.UPCITEMDB_KEY) : undefined;
// Recall checks are switched on (or off) by the server admin in Settings → Server.
const recalls = new CpscRecalls();
// VINs decoded and vehicle recalls, from NHTSA: also off until the server admin switches them on.
const vehicles = new NhtsaVehicles();
// "Repair guides on iFixit" links: off until the server admin switches them on.
const repairGuides = new IfixitGuides();
// Books by ISBN from Open Library (a second barcode source): off until the server admin switches it on.
const books = new OpenLibraryBooks();
const maps =
  config.APPLE_MAPS_TEAM_ID && config.APPLE_MAPS_KEY_ID && config.APPLE_MAPS_PRIVATE_KEY
    ? new AppleMapSnapshots(config.APPLE_MAPS_TEAM_ID, config.APPLE_MAPS_KEY_ID, config.APPLE_MAPS_PRIVATE_KEY)
    : undefined;
const backups = config.BACKUP_DIR
  ? { snapshots: new SqliteSnapshots(db), target: new FolderBackupTarget(path.resolve(config.BACKUP_DIR)) }
  : undefined;
// The services Ferret calls, watched: every failure goes in the server admin's error log (lib/service-errors.ts).
// (Downloads and Home Assistant reads fail on what people typed, so they're not.)
const deps = {
  db,
  blobs: new FsBlobs(path.join(dataDir, "files")),
  images,
  pdfPages,
  jobs,
  ai: watched(db, "ai", ai),
  chat: watched(db, "chat", chat),
  documents: watched(db, "documents", documents),
  vectors: watched(db, "vectors", vectors),
  reranker: watched(db, "reranker", reranker),
  speech: watched(db, "speech", speech),
  push: watched(db, "push", push),
  notifier: watched(db, "notifier", notifier),
  products: watched(db, "products", products),
  maps: watched(db, "maps", maps),
  backups,
  downloader: new SafeDownloader(),
  // Not watched either: a webhook fails on the address a household gave (its delivery log says why).
  webhooks: new NodeWebhookSender(),
  homeAssistant: new HomeAssistantWebSocket(),
  recalls: watched(db, "recalls", recalls),
  vehicles: watched(db, "vehicles", vehicles),
  repairGuides: watched(db, "repair guides", repairGuides),
  books: watched(db, "books", books),
  tls: new NodeTls(),
  secrets: { sources: secrets.sources, file: path.join(dataDir, SECRETS_FILE), filesKeyId: keys.set },
};
// Certificates the server admin added for Ferret's own connections (Settings → Server), before anything connects.
await applyCertificates(deps, config.FILES_KEY);
// The help at /docs, when it's been built (apps/docs): its CSP allows its own inline scripts by hash.
const docsRoot = path.resolve(config.DOCS_DIST);
const hasDocs = existsSync(path.join(docsRoot, "csp.json"));
const { app, files, auth } = createApp(deps, config, { docsScriptHashes: hasDocs ? docsScriptHashes(docsRoot) : [] });

// Background jobs (jobs/schedule.ts — the same list any runtime uses), and the periodic ones on timers.
const schedule = jobSchedule({ deps, files, auth, config, jobs });
jobs.register(schedule.handlers);
await schedule.atStart();
setInterval(() => void schedule.every10Minutes(), 10 * 60 * 1000);
setInterval(() => void schedule.hourly(), 60 * 60 * 1000);
setInterval(() => void schedule.daily(), 24 * 60 * 60 * 1000);
await jobs.start();

if (hasDocs) mountDocs(app, docsRoot);
else console.warn(`Help not found at ${docsRoot} — /docs is off. (pnpm --filter @ferret/docs build)`);

// Web app (SPA), served from the same port.
const webRoot = path.resolve(config.WEB_DIST);
if (existsSync(webRoot)) {
  mountWebApp(app, webRoot);
} else {
  console.warn(`Web app not found at ${webRoot} — API only. (Run the Vite dev server for the UI.)`);
}

// The client's address for Better Auth's limits, the sign-in guard and log, unlock requests and the openings of share
// and borrower links (the only readers of X-Forwarded-For): believed only from TRUSTED_PROXIES.
const trustedProxies = proxyList(config.TRUSTED_PROXIES);
const readsAddress = (req: Request) => /^\/api\/(auth|v1\/sign-in|v1\/shared|v1\/borrowed)\//.test(new URL(req.url).pathname);

// Sign-in by a forward-auth proxy's headers (lib/sso.ts): believed only when the connection itself is from
// TRUSTED_HEADER_PROXIES — marked here, and a mark a client sends is always taken off.
const authProxies = config.TRUSTED_HEADER_AUTH ? proxyList(config.TRUSTED_HEADER_PROXIES) : null;

serve(
  {
    fetch: (req, env) => {
      const peer = env.incoming.socket.remoteAddress;
      const ours = markAuthProxy(req, peer, authProxies);
      return app.fetch(readsAddress(ours) ? withClientAddress(ours, peer, trustedProxies) : ours, env);
    },
    port: config.PORT,
  },
  (info) => {
  console.log(`🐾 Ferret listening on http://localhost:${info.port}  (public: ${config.PUBLIC_URL})`);
  const on = (enabled: unknown, detail: string, hint: string) => (enabled ? detail : `off (${hint})`);
  console.log(`   Photo analysis: ${on(ai, `${config.VISION_MODEL} at ${config.VISION_URL}`, "set VISION_URL")}`);
  console.log(`   Questions/text: ${on(chat ?? ai, chat ? `${config.CHAT_MODEL} at ${config.CHAT_URL}` : `${config.VISION_MODEL} (set CHAT_URL for a stronger model)`, "set VISION_URL or CHAT_URL")}`);
  console.log(`   Document text:  ${on(documents, `docling at ${config.DOCLING_URL}`, "set DOCLING_URL")}`);
  console.log(
    `   Smart search:   ${on(vectors, `${config.EMBED_MODEL}${config.EMBED_URL !== config.VISION_URL ? ` at ${config.EMBED_URL}` : ""} → Qdrant ${config.QDRANT_COLLECTION}`, "set QDRANT_URL and VISION_URL")}`,
  );
  console.log(`   Reranking:      ${on(vectors && reranker, `${config.RERANK_MODEL} at ${config.RERANK_URL}`, "set RERANK_URL")}`);
  console.log(`   Speech to text: ${on(speech, `${config.SPEECH_MODEL} at ${config.SPEECH_URL}`, "set SPEECH_URL")}`);
  console.log("   Recalls:        the US CPSC's recalls, if the server admin switches them on (Settings → Server)");
  console.log("   Books:          Open Library for ISBNs, if the server admin switches it on (Settings → Server)");
  console.log("   Repair guides:  iFixit links for things' brand and model, if the server admin switches them on (Settings → Server)");
  console.log("   Vehicles:       NHTSA's VIN decoding and vehicle recalls, if the server admin switches them on (Settings → Server)");
  console.log(`   Barcode lookup: ${on(products, `UPCitemdb${config.UPCITEMDB_KEY ? " (paid key)" : " (free: 100 a day)"}`, "set BARCODE_LOOKUP=upcitemdb")} + Ferret's own barcode book`);
  console.log(`   Push reminders: ${on(push, `daily from ${config.REMIND_HOUR}:00 (TZ ${process.env.TZ ?? "system"})`, "set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY")}`);
  const subjectProblem = push && vapidSubjectProblem(vapidSubject(config));
  if (subjectProblem) {
    console.warn(`   ⚠ Push to iPhones and Safari won't work: the VAPID subject (${vapidSubject(config)}) ${subjectProblem}. Set VAPID_SUBJECT to a mailto: or https: address on a public domain.`);
  }
  console.log(`   Email:          ${on(notifier && config.MAIL_URL, "through Apprise (password reset, sign-in links, emailed sign-in)", "set MAIL_URL, with APPRISE_URL — needed for password reset")}`);
  console.log(`   Maps:           ${on(maps, "Apple Maps pictures of property addresses", "set APPLE_MAPS_TEAM_ID, APPLE_MAPS_KEY_ID and APPLE_MAPS_PRIVATE_KEY")}`);
  console.log(`   Backups:        ${on(backups, `nightly from ${config.BACKUP_HOUR}:00 to ${config.BACKUP_DIR}, keeping ${config.BACKUP_KEEP}`, "set BACKUP_DIR")}`);
  console.log(`   Other apps:     ${on(notifier, `Apprise at ${config.APPRISE_URL}, daily from ${config.REMIND_HOUR}:00`, "set APPRISE_URL")}`);
  console.log(`   Single sign-on: ${on(config.OIDC_ISSUER, `OIDC with ${config.OIDC_ISSUER}`, "set OIDC_ISSUER and OIDC_CLIENT_ID")}${config.TRUSTED_HEADER_AUTH ? `; ${config.TRUSTED_HEADER_EMAIL} from ${config.TRUSTED_HEADER_PROXIES}` : ""}`);
  },
);
