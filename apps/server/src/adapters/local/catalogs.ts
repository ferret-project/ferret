/**
 * The server's translations (lib/language.ts), as `translations.mjs prepare` wrote them: next to the bundled server
 * (build.mjs copies them there), or — running from source — in the web app's fetched locales. None: English only.
 */
import { readFileSync } from "node:fs";
import type { Catalogs } from "../../lib/language";

const PLACES = [
  new URL("./locales.json", import.meta.url), // dist/locales.json beside dist/server.js
  new URL("../../../../web/src/locales/server.json", import.meta.url), // apps/server/src/adapters/local → apps/web
];

export function loadCatalogs(): Catalogs | undefined {
  for (const place of PLACES) {
    try {
      return JSON.parse(readFileSync(place, "utf8")) as Catalogs;
    } catch {
      // not there
    }
  }
  return undefined;
}
