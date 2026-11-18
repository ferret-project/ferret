/**
 * Translations (Lingui). Ferret's own text is English, written in the code with Lingui's macros (`t\`…\``,
 * `<Trans>…</Trans>`); other languages live in the community's ferret-project/ferret-translations repo and are fetched
 * into src/locales/ (gitignored) at build time by scripts/translations.mjs (here in apps/web) — never kept in this repo.
 */
import { readdirSync } from "node:fs";
import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import babel from "@lingui/cli/api/extractors/babel";
import { serverExtractor } from "./scripts/server-extractor";

const LOCALES_DIR = new URL("./src/locales/", import.meta.url);

/** English, plus every language fetched into src/locales/. */
function locales() {
  let fetched: string[] = [];
  try {
    fetched = readdirSync(LOCALES_DIR)
      .filter((f) => f.endsWith(".po") && f !== "en.po")
      .map((f) => f.slice(0, -3));
  } catch {
    // Not fetched: English only.
  }
  return ["en", ...fetched.sort()];
}

export default defineConfig({
  sourceLocale: "en",
  locales: locales(),
  // A string a language hasn't translated yet shows in English.
  fallbackLocales: { default: "en" },
  // The app's text, and the server's (emails, push: its tr("…") calls, lib/language.ts) — one list for translators.
  catalogs: [{ path: "<rootDir>/src/locales/{locale}", include: ["<rootDir>/src", "<rootDir>/../server/src"], exclude: ["**/node_modules/**"] }],
  extractors: [serverExtractor, babel],
  // No line numbers: the source list (messages.pot) then changes only when the text does.
  format: formatter({ lineNumbers: false }),
});
