/**
 * Money in the household's currency (Settings → Household → Currency), written the reader's way (their browser's
 * language: a German sees 1.234,56 €). `Screens` (App.tsx) and the share page set the currency before their screens
 * draw; every amount on screen goes through `money`.
 */
import { DEFAULT_CURRENCY, currencySymbol as symbolOf, formatMoney, parseMoney } from "@ferret/shared/utils";
import { locale } from "../i18n";

let current = DEFAULT_CURRENCY;
const KEY = "ferret.currency.";

/** The currency amounts are shown in now. */
export const currentCurrency = () => current;

/** Shows amounts in `currency` from now on, and remembers it on this device for the household (the next first draw). */
export function showAmountsIn(currency: string, householdId?: string) {
  current = currency;
  if (householdId) {
    try {
      localStorage.setItem(KEY + householdId, currency);
    } catch {
      // Private window or storage off: it's only a head start.
    }
  }
}

/** What this device last saw the household's currency as (before its settings have loaded). */
export function rememberedCurrency(householdId: string) {
  try {
    return localStorage.getItem(KEY + householdId) ?? DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

/** An amount (×100): whole units from 1,000 up (totals), unless `exact` (one thing's value or price). */
export const money = (cents: number, exact = false) => formatMoney(cents, current, { exact, locale: locale() });

/** An amount in whole units only (chart labels, totals in a sentence). */
export const moneyWhole = (cents: number) => formatMoney(cents, current, { whole: true, locale: locale() });

/** The currency's symbol, for the prefix on amount fields: "$", "€". */
export const currencySymbol = () => symbolOf(current, locale());

/** The reader's decimal mark ("," in German), to read what they type. */
export const decimalMark = (): "." | "," => ((1.5).toLocaleString(locale()).includes(",") ? "," : ".");

/** What's typed in an amount field ("12,50", "1.234", "$80") → ×100; null when empty or not an amount. */
export function toCents(raw: FormDataEntryValue | string | null | undefined) {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text ? parseMoney(text, decimalMark()) : null;
}

/** An amount for an amount field to start from: "12.5" → "12,50" in German. */
export function centsToInput(cents: number | null | undefined, wholeOnly = false) {
  if (cents == null) return "";
  return (cents / 100).toLocaleString(locale(), { useGrouping: false, maximumFractionDigits: wholeOnly ? 0 : 2, minimumFractionDigits: wholeOnly || cents % 100 === 0 ? 0 : 2 });
}
