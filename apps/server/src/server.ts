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
import { OllamaAi } from "./adapters/local/ai";
import { OpenAiChat } from "./adapters/local/chat";
import { createLocalDb, runMigrations } from "./adapters/local/db";
import { DoclingDocuments } from "./adapters/local/docling";
import { SharpImages } from "./adapters/local/images";
import { PdfJsPages } from "./adapters/local/pdf";
import { DbJobs } from "./adapters/local/jobs";
import { WebCryptoPush } from "./lib/web-push";
import { SafeDownloader } from "./adapters/local/download";
import { AppriseNotifier } from "./adapters/local/apprise";
import { UpcItemDb } from "./adapters/local/upcitemdb";
import { AppleMapSnapshots } from "./adapters/local/apple-maps";
import { HomeAssistantWebSocket } from "./adapters/local/home-assistant";
import { CpscRecalls } from "./adapters/local/cpsc";
import { QdrantVectors } from "./adapters/local/qdrant";
import { VllmReranker } from "./adapters/local/reranker";
import { docsScriptHashes, mountDocs, mountWebApp } from "./adapters/local/web";
import { markAuthProxy, proxyList, withClientAddress } from "./adapters/local/proxy";
import { createApp } from "./app";
import { jobSchedule } from "./jobs/schedule";
import { watched } from "./lib/service-errors";
import { doclingOptions, loadConfig, vapidSubject } from "./config";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(process.env);
const dataDir = path.resolve(config.DATA_DIR);

const { db } = createLocalDb(`file:${path.join(dataDir, "ferret.db")}`);
// Migrations live next to the bundle in production (dist/migrations) and in ./migrations in dev.
const migrationsFolder = [path.join(here, "migrations"), path.join(here, "../migrations")].find((p) => existsSync(p));
if (!migrationsFolder) throw new Error("Migrations folder not found");
await runMigrations(db, migrationsFolder);

// Optional integrations switch on when configured (see config.ts).
const images = new SharpImages();
const pdfPages = new PdfJsPages();
const jobs = new DbJobs(db);
const ai = config.OLLAMA_URL
  ? new OllamaAi(config.OLLAMA_URL, { vision: config.VISION_MODEL, embed: config.EMBED_MODEL })
  : undefined;
const chat = config.CHAT_URL
  ? new OpenAiChat(config.CHAT_URL, config.CHAT_MODEL, { reasoningEffort: config.CHAT_REASONING || undefined })
  : undefined;
const documents = config.DOCLING_URL ? new DoclingDocuments(config.DOCLING_URL, doclingOptions(config)) : undefined;
const vectors =
  config.QDRANT_URL && ai ? new QdrantVectors(config.QDRANT_URL, config.QDRANT_API_KEY, config.QDRANT_COLLECTION) : undefined;
const reranker = config.RERANK_URL ? new VllmReranker(config.RERANK_URL, config.RERANK_MODEL) : undefined;
const push =
  config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY
    ? new WebCryptoPush(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, vapidSubject(config))
    : undefined;
const notifier = config.APPRISE_URL ? new AppriseNotifier(config.APPRISE_URL) : undefined;
const products = config.BARCODE_LOOKUP === "upcitemdb" ? new UpcItemDb(config.UPCITEMDB_KEY) : undefined;
// Recall checks are switched on (or off) by the server admin in Settings → Server.
const recalls = new CpscRecalls();
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
  push: watched(db, "push", push),
  notifier: watched(db, "notifier", notifier),
  products: watched(db, "products", products),
  maps: watched(db, "maps", maps),
  backups,
  downloader: new SafeDownloader(),
  homeAssistant: new HomeAssistantWebSocket(),
  recalls: watched(db, "recalls", recalls),
};
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

// The client's address for Better Auth's limits, the sign-in guard and log, and unlock requests (the only readers of
// X-Forwarded-For): believed only from TRUSTED_PROXIES.
const trustedProxies = proxyList(config.TRUSTED_PROXIES);
const readsAddress = (req: Request) => /^\/api\/(auth|v1\/sign-in)\//.test(new URL(req.url).pathname);

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
  console.log(`   Photo analysis: ${on(ai, `${config.VISION_MODEL} at ${config.OLLAMA_URL}`, "set OLLAMA_URL")}`);
  console.log(`   Questions/text: ${on(chat ?? ai, chat ? `${config.CHAT_MODEL} at ${config.CHAT_URL}` : `${config.VISION_MODEL} (set CHAT_URL for a stronger model)`, "set OLLAMA_URL or CHAT_URL")}`);
  console.log(`   Document text:  ${on(documents, `docling at ${config.DOCLING_URL}`, "set DOCLING_URL")}`);
  console.log(
    `   Smart search:   ${on(vectors, `${config.EMBED_MODEL} → Qdrant ${config.QDRANT_COLLECTION}`, "set QDRANT_URL and OLLAMA_URL")}`,
  );
  console.log(`   Reranking:      ${on(vectors && reranker, `${config.RERANK_MODEL} at ${config.RERANK_URL}`, "set RERANK_URL")}`);
  console.log("   Recalls:        the US CPSC's recalls, if the server admin switches them on (Settings → Server)");
  console.log(`   Barcode lookup: ${on(products, `UPCitemdb${config.UPCITEMDB_KEY ? " (paid key)" : " (free: 100 a day)"}`, "set BARCODE_LOOKUP=upcitemdb")} + Ferret's own barcode book`);
  console.log(`   Push reminders: ${on(push, `daily from ${config.REMIND_HOUR}:00 (TZ ${process.env.TZ ?? "system"})`, "set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY")}`);
  console.log(`   Email:          ${on(notifier && config.MAIL_URL, "through Apprise (password reset, sign-in links, emailed sign-in)", "set MAIL_URL, with APPRISE_URL — needed for password reset")}`);
  console.log(`   Maps:           ${on(maps, "Apple Maps pictures of property addresses", "set APPLE_MAPS_TEAM_ID, APPLE_MAPS_KEY_ID and APPLE_MAPS_PRIVATE_KEY")}`);
  console.log(`   Backups:        ${on(backups, `nightly from ${config.BACKUP_HOUR}:00 to ${config.BACKUP_DIR}, keeping ${config.BACKUP_KEEP}`, "set BACKUP_DIR")}`);
  console.log(`   Other apps:     ${on(notifier, `Apprise at ${config.APPRISE_URL}, daily from ${config.REMIND_HOUR}:00`, "set APPRISE_URL")}`);
  console.log(`   Single sign-on: ${on(config.OIDC_ISSUER, `OIDC with ${config.OIDC_ISSUER}`, "set OIDC_ISSUER and OIDC_CLIENT_ID")}${config.TRUSTED_HEADER_AUTH ? `; ${config.TRUSTED_HEADER_EMAIL} from ${config.TRUSTED_HEADER_PROXIES}` : ""}`);
  },
);
