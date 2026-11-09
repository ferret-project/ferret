/** Real app + migrations on a disposable local database; deliberately no external service adapters. */
import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalDb, runMigrations } from "../src/adapters/local/db";
import { FsBlobs } from "../src/adapters/local/blobs";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const data = mkdtempSync(path.join(tmpdir(), "ferret-i18n-e2e-"));
const { db } = createLocalDb(`file:${path.join(data, "ferret.db")}`);
await runMigrations(db, path.resolve("migrations"));
const config = loadConfig({
  NODE_ENV: "test",
  PUBLIC_URL: "http://127.0.0.1:15173",
  ALLOW_SIGNUP: "true",
  AUTH_SECRET: "localization-browser-tests-not-a-production-secret",
  FILES_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(17))),
});
const { app } = createApp({ db, blobs: new FsBlobs(path.join(data, "blobs")) }, config);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 18887 });
console.log(`Localization test app: http://127.0.0.1:18887; disposable data: ${data}`);
