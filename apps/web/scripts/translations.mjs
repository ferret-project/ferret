#!/usr/bin/env node
/**
 * Ferret's translations. Ferret itself is English only; every other language is the community's, in
 * https://github.com/ferret-project/ferret-translations (translated on Weblate). This script:
 *
 *   node apps/web/scripts/translations.mjs prepare    before the web app's build: fetch the translations into
 *                                            apps/web/src/locales/ (gitignored), bring each up to date with the
 *                                            code's strings (new ones fall back to English), and write
 *                                            languages.json (each language's name and how much is translated).
 *                                            Also server.json: the server's own text (emails, push — its tr("…")
 *                                            calls) in each language, compiled, which the server's build takes along.
 *   node apps/web/scripts/translations.mjs template   write apps/web/src/locales/messages.pot — the English source list
 *                                            that CI pushes to the translations repo.
 *
 * Where translations come from (prepare):
 *   FERRET_TRANSLATIONS=off          English only, nothing fetched.
 *   FERRET_TRANSLATIONS_DIR=<path>   a local clone of ferret-translations (for translators trying their work).
 *   FERRET_TRANSLATIONS_REF=<ref>    a branch, tag or commit of the repo on GitHub (default: main).
 * If they can't be fetched (no network), the build goes on in English.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileMessageOrThrow } from "@lingui/message-utils/compileMessage";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import { parsePo, stringifyPo } from "pofile-ts";

const REPO = "ferret-project/ferret-translations";
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(web, "src/locales");
const lingui = path.join(web, "node_modules/.bin/lingui");
/** A language's file: en, de, pt-BR, zh-Hans… */
const LANGUAGE_FILE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\.po$/;

const say = (text) => console.log(`translations: ${text}`);

function run(args) {
  const r = spawnSync(lingui, args, { cwd: web, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`lingui ${args.join(" ")} failed`);
}

/** The translations repo's locales/ folder, from a local clone or GitHub; null if neither can be had. */
async function fetchLocales() {
  const local = process.env.FERRET_TRANSLATIONS_DIR;
  if (local) return path.join(path.resolve(local), "locales");
  const ref = process.env.FERRET_TRANSLATIONS_REF || "main";
  const tmp = mkdtempSync(path.join(tmpdir(), "ferret-translations-"));
  try {
    const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const tar = spawnSync("tar", ["-xzf", "-", "--strip-components=1", "-C", tmp], { input: Buffer.from(await res.arrayBuffer()) });
    if (tar.status !== 0) throw new Error(`tar: ${tar.stderr}`);
    say(`fetched ${REPO}@${ref}`);
    return path.join(tmp, "locales");
  } catch (e) {
    say(`couldn't fetch ${REPO}@${ref} (${e.message}) — English only`);
    return null;
  }
}

/** The placeholders ({name}, plural arguments) and tags (<0>…</0>) a message uses — a translation must use the same. */
function shape(message) {
  const names = [];
  const walk = (tokens) => {
    for (const t of tokens) {
      if (!Array.isArray(t)) continue;
      names.push(t[0]);
      if (t[2] && typeof t[2] === "object") for (const [k, v] of Object.entries(t[2])) if (k !== "offset" && Array.isArray(v)) walk(v);
    }
  };
  walk(compileMessageOrThrow(message));
  const tags = message.match(/<\/?\d+\s*\/?>/g) ?? [];
  // Which ones, not how often: a language with more plural forms repeats them.
  return JSON.stringify([[...new Set(names)].sort(), [...new Set(tags.map((t) => t.replace(/\s/g, "")))].sort()]);
}

/**
 * Blanks translations that would break: ones that don't parse, or whose placeholders or tags differ from the English
 * — they then show in English instead of as a broken string or a bare id. Also ones still marked "Needs editing"
 * (fuzzy: machine drafts, or changed English) until someone approves them. Returns how much is translated (%).
 */
function checkLanguage(file) {
  const po = parsePo(readFileSync(file, "utf8"));
  const items = po.items.filter((i) => !i.obsolete && i.msgid);
  const blanked = [];
  let unreviewed = 0;
  for (const item of items) {
    const text = item.msgstr[0];
    if (!text) continue;
    if (item.flags?.fuzzy) {
      item.msgstr = item.msgstr.map(() => "");
      unreviewed++;
      continue;
    }
    let ok;
    try {
      ok = shape(text) === shape(item.msgid);
    } catch {
      ok = false;
    }
    if (!ok) {
      blanked.push(`  "${item.msgid}" → "${text}"`);
      item.msgstr = [""];
    }
  }
  if (unreviewed) say(`${path.basename(file)}: ${unreviewed} waiting for review ("Needs editing") — shown in English for now`);
  if (blanked.length || unreviewed) writeFileSync(file, stringifyPo(po));
  if (blanked.length) {
    say(`${path.basename(file)}: ${blanked.length} translation(s) left out — placeholders, tags or plural syntax don't match the English:`);
    for (const line of blanked) console.log(line);
  }
  const done = items.filter((i) => i.msgstr[0]).length;
  return items.length ? Math.floor((done / items.length) * 100) : 0;
}

/**
 * The server's part of each language (strings from apps/server/src), compiled and keyed by message id like the app's
 * catalogs — read by the server (lib/language.ts) to write emails and notifications in each person's language. Run
 * after checkLanguage, so broken or unreviewed translations are already left out.
 */
function serverCatalogs() {
  const catalogs = {};
  for (const f of readdirSync(out).filter((f) => LANGUAGE_FILE.test(f) && f !== "en.po")) {
    const messages = {};
    for (const item of parsePo(readFileSync(path.join(out, f), "utf8")).items) {
      const text = item.msgstr[0];
      if (item.obsolete || !item.msgid || !text || !item.references.some((r) => r.includes("server/src/"))) continue;
      messages[generateMessageId(item.msgid, item.msgctxt ?? "")] = compileMessageOrThrow(text);
    }
    catalogs[f.slice(0, -3)] = messages;
  }
  writeFileSync(path.join(out, "server.json"), JSON.stringify(catalogs));
  say(`server.json: ${Object.entries(catalogs).map(([code, m]) => `${code} ${Object.keys(m).length}`).join(", ") || "English only"}`);
}

function languageName(code) {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

async function prepare() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (process.env.FERRET_TRANSLATIONS !== "off") {
    const from = await fetchLocales();
    if (from && existsSync(from)) {
      for (const f of readdirSync(from)) if (LANGUAGE_FILE.test(f) && f !== "en.po") copyFileSync(path.join(from, f), path.join(out, f));
    }
  }
  // English from the code, and every language brought up to date with it (lingui.config.ts lists what's there).
  run(["extract", "--clean"]);
  const languages = readdirSync(out)
    .filter((f) => LANGUAGE_FILE.test(f))
    .map((f) => {
      const code = f.slice(0, -3);
      return { code, name: languageName(code), percent: code === "en" ? 100 : checkLanguage(path.join(out, f)) };
    })
    .sort((a, b) => (a.code === "en" ? -1 : b.code === "en" ? 1 : a.name.localeCompare(b.name)));
  writeFileSync(path.join(out, "languages.json"), `${JSON.stringify(languages, null, 2)}\n`);
  serverCatalogs();
  say(languages.map((l) => `${l.code} ${l.percent}%`).join(", "));
}

function template() {
  mkdirSync(out, { recursive: true });
  run(["extract-template"]);
  // The date it was made would change the file on every run; only the strings should.
  const pot = path.join(out, "messages.pot");
  writeFileSync(pot, readFileSync(pot, "utf8").replace(/^"POT-Creation-Date:.*\\n"\r?\n/m, ""));
  say(`wrote ${path.relative(process.cwd(), pot)}`);
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "template") template();
else {
  console.error("usage: node scripts/translations.mjs prepare|template");
  process.exit(1);
}
