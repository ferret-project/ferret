import en from "./locales/en.json";
import hu from "./locales/hu.json";

/** Language controls presentation only. IDs, dates in API payloads and monetary units never change. */
export const languages = ["en", "hu"] as const;
export type Language = (typeof languages)[number];
export const languageOf = (value: unknown): Language => typeof value === "string" && /^hu(?:-|$)/i.test(value) ? "hu" : "en";
export const intlLocale = (language: Language) => language === "hu" ? "hu-HU" : "en-US";
export type MessageValues = Record<string, unknown>;
const catalogs: Record<Language, Record<string, string>> = { en, hu };

/** Source messages are readable keys and also the English fallback for new or missing translations. */
export function message(language: Language, source: string): string {
  return catalogs[language]?.[source] ?? en[source as keyof typeof en] ?? source;
}

/** One-pass interpolation: inserted values can never become message syntax or HTML. */
export function translate(language: Language, source: string, values: MessageValues = {}): string {
  return message(language, source).replace(/\{(\w+)\}/g, (token, key: string) =>
    Object.hasOwn(values, key) ? String(values[key] ?? "") : token,
  );
}

/** Hungarian uses the singular noun after numbers; English has two forms. */
export function plural(language: Language, count: number, one: string, other: string, values: MessageValues = {}) {
  return translate(language, language === "hu" || new Intl.PluralRules(intlLocale(language)).select(count) === "one" ? one : other, { ...values, count });
}
