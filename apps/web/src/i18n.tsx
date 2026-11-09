import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { intlLocale, languageOf, message, translate, plural, type Language, type MessageValues } from "@ferret/shared/i18n";

const STORAGE_KEY = "ferret-language";
function storedLanguage(): Language {
  try { return languageOf(localStorage.getItem(STORAGE_KEY) ?? navigator.language); } catch { return "en"; }
}
let language = typeof window === "undefined" ? "en" as const : storedLanguage();
const listeners = new Set<() => void>();
export const currentLanguage = () => language;
export const locale = () => intlLocale(language);
export function setLanguage(value: Language) {
  const next = languageOf(value);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage may be blocked. */ }
  if (next === language) return;
  language = next;
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("ferret-language"));
  for (const listener of listeners) listener();
}
if (typeof window !== "undefined") {
  document.documentElement.lang = language;
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) setLanguage(languageOf(event.newValue));
  });
}
export function useLanguage() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, currentLanguage, () => "en" as const);
}
export const t = (source: string, values?: MessageValues) => translate(language, source, values);
export const tn = (count: number, one: string, other: string, values?: MessageValues) => plural(language, count, one, other, values);
export const trn = (count: number, one: string, other: string, values: Record<string, ReactNode>) => tr(language === "hu" || count === 1 ? one : other, { ...values, count });

/** Rich message values stay React nodes: no innerHTML, DOM scanning, or translated user data. */
export function tr(source: string, values: Record<string, ReactNode>): ReactNode {
  return message(language, source).split(/(\{\w+\})/g).map((part, index) => {
    const key = part.slice(1, -1);
    return <Fragment key={index}>{/^\{\w+\}$/.test(part) && Object.hasOwn(values, key) ? values[key] : part}</Fragment>;
  });
}

/** Remount on a deliberate language change so module consumers and query results cannot retain stale copy. */
export function LanguageRoot({ children }: { children: ReactNode }) {
  const selected = useLanguage();
  return <Fragment key={selected}>{children}</Fragment>;
}

/** Synchronize the stored preference after sign-in, including on a new device. */
export function LanguageAccount({ userId }: { userId: string }) {
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/language", { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        let guest: string | null = null;
        try { guest = localStorage.getItem(STORAGE_KEY); } catch { /* Storage may be blocked. */ }
        if (!data.personal && guest) {
          const saved = await fetch("/api/v1/language", { method: "PUT", credentials: "include", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: languageOf(guest) }) });
          if (saved.ok) setLanguage(languageOf(guest));
        } else setLanguage(languageOf(data.language));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [userId]);
  return null;
}

export function LanguageSelector({ account = false }: { account?: boolean }) {
  const selected = useLanguage();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    void fetch("/api/v1/language", { credentials: "include", signal: controller.signal })
      .then(async (response) => { if (response.ok) { const data = await response.json(); setLanguage(languageOf(data.language)); } })
      .catch(() => {});
    return () => controller.abort();
  }, [account]);
  async function choose(value: Language) {
    setError(null);
    if (account) {
      try {
        const response = await fetch("/api/v1/language", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", "Accept-Language": value }, body: JSON.stringify({ language: value }) });
        if (!response.ok) throw new Error(t("Couldn't save the language. Try again."));
      } catch (error) { setError(error instanceof Error ? error.message : t("Something went wrong")); return; }
    }
    setLanguage(value);
  }
  return <label className="flex flex-wrap items-center gap-2 text-sm">
    <span>{t("Language")}</span>
    <select className="select select-sm w-auto" aria-label={t("Language")} value={selected} onChange={(event) => void choose(languageOf(event.target.value))}>
      <option value="en" lang="en">English</option><option value="hu" lang="hu">Magyar</option>
    </select>
    {error && <span role="alert" className="text-error">{error}</span>}
  </label>;
}
