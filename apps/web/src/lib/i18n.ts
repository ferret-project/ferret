/**
 * Which language the app is in. Ferret's text is English in the code (Lingui macros); other languages come from the
 * community's translations, fetched into ../locales/ at build time (apps/web/scripts/translations.mjs) with languages.json
 * saying how much of each is translated. Chosen per device (the account menu), else the browser's language — but only
 * a language that's mostly translated; anything not translated yet shows in English.
 */
import { i18n } from "@lingui/core";

export type Language = { code: string; name: string; percent: number };

/** Offered without asking, and picked from the browser's language, from this much translated. */
export const MOSTLY_TRANSLATED = 80;
const STORAGE_KEY = "ferret-language";

const catalogs = import.meta.glob<{ messages: Record<string, unknown> }>("../locales/*.po");
const listed = import.meta.glob<Language[]>("../locales/languages.json", { eager: true, import: "default" });

/** The languages this build has (English always). */
export const LANGUAGES: Language[] = Object.values(listed)[0] ?? [{ code: "en", name: "English", percent: 100 }];

const has = (code: string) => LANGUAGES.some((l) => l.code === code) && !!catalogs[`../locales/${code}.po`];

function stored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The person's choice on this device, else the first of the browser's languages that's mostly translated. */
function choose(): string {
  const choice = stored();
  if (choice && (choice === "en" || has(choice))) return choice;
  const mostly = LANGUAGES.filter((l) => l.percent >= MOSTLY_TRANSLATED && has(l.code)).map((l) => l.code);
  for (const wanted of navigator.languages ?? [navigator.language]) {
    const exact = mostly.find((c) => c.toLowerCase() === wanted.toLowerCase());
    const base = mostly.find((c) => c.toLowerCase() === wanted.split("-")[0]!.toLowerCase());
    if (exact ?? base) return (exact ?? base)!;
  }
  return "en";
}

/** Loads the chosen language before the app draws (main.tsx). */
export async function startLanguage() {
  const code = choose();
  const load = catalogs[`../locales/${code}.po`];
  // In development without fetched translations there's no catalog: the macros carry the English themselves.
  const messages = load ? (await load()).messages : {};
  i18n.loadAndActivate({ locale: code, messages: messages as never });
  document.documentElement.lang = code;
}

export const currentLanguage = () => i18n.locale || "en";

/** Whether this device has a language chosen (rather than following the browser). */
export const chosenOnDevice = () => Boolean(stored());

/** Switches language on this device; the page reloads so everything, menus included, is in the new one. */
export function setLanguage(code: string) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Private browsing: just for now.
  }
  location.reload();
}
