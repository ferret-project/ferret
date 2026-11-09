/**
 * Money in a household's currency (Settings → Household → Currency). Amounts are stored as integers: the amount × 100
 * whatever the currency ("cents" in the code — a yen amount is ×100 too), so nothing stored changes with the currency.
 * Shown with the currency's own decimals (¥1,500, not ¥1,500.00) in the reader's own way of writing numbers.
 */

/** Where a household hasn't chosen: Ferret's money was dollars before there was a choice. */
export const DEFAULT_CURRENCY = "USD";

/** Whether `code` is an ISO 4217 currency this runtime can write (e.g. "EUR"). */
export function isCurrency(code: string) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const known = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("currency");
  if (known) return known.includes(code);
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, locale: string | undefined, fraction: "exact" | "whole" | "auto") {
  const key = `${currency}|${locale ?? ""}|${fraction}`;
  let f = formatters.get(key);
  if (!f) {
    // Forints are presented as whole amounts even on browsers with older CLDR
    // defaults. Leave currencyDigits/moneyNumber and stored amounts unchanged.
    const digits = currency === "HUF" ? 0 : currencyDigits(currency);
    f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: isCurrency(currency) ? currency : DEFAULT_CURRENCY,
      minimumFractionDigits: fraction === "exact" ? digits : fraction === "whole" ? 0 : undefined,
      maximumFractionDigits: fraction === "whole" ? 0 : digits,
    });
    formatters.set(key, f);
  }
  return f;
}

/** How many decimals a currency is written with (USD 2, JPY 0, KWD 3). */
export function currencyDigits(currency: string) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export interface MoneyOptions {
  /** One thing's price or value: always its decimals ($80.00). */
  exact?: boolean;
  /** Whole units only ($1,235): totals in sentences. */
  whole?: boolean;
  /** How to write numbers; the runtime's own when left out (the browser's language in the app). */
  locale?: string;
}

/**
 * An amount (×100) in a currency: whole units from 1,000 up (totals) unless `exact`, e.g. "$1,234", "$12.50",
 * "1.234 €" (German), "¥1,500".
 */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY, opts: MoneyOptions = {}) {
  const fraction = opts.exact ? "exact" : opts.whole || Math.abs(cents) >= 100_000 ? "whole" : "auto";
  return formatter(currency, opts.locale, fraction).format(cents / 100);
}

/** An amount as a plain number for a spreadsheet: "1234.50" (the currency's decimals, a dot, no symbol). */
export const moneyNumber = (cents: number, currency: string = DEFAULT_CURRENCY) => (cents / 100).toFixed(currencyDigits(currency));

/** A currency's symbol where it's written: "$", "€", "£", "CHF". */
export function currencySymbol(currency: string = DEFAULT_CURRENCY, locale?: string) {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** A currency's name: "Euro", "US Dollar". */
export function currencyName(currency: string, locale?: string) {
  try {
    return new Intl.DisplayNames(locale, { type: "currency" }).of(currency) ?? currency;
  } catch {
    return currency;
  }
}

/** Countries (ISO 3166) whose money isn't simply named after them — and the euro area. */
const EURO = "AD AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MC ME MT NL PT SI SK SM VA XK".split(" ");
const BY_REGION: Record<string, string> = {
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU",
  GB: "GBP", IM: "GBP", JE: "GBP", GG: "GBP", CH: "CHF", LI: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK",
  PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", RS: "RSD", UA: "UAH", TR: "TRY", IL: "ILS",
  AU: "AUD", NZ: "NZD", JP: "JPY", CN: "CNY", HK: "HKD", TW: "TWD", KR: "KRW", SG: "SGD", MY: "MYR", TH: "THB",
  ID: "IDR", PH: "PHP", VN: "VND", IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", AE: "AED", SA: "SAR", QA: "QAR",
  KW: "KWD", EG: "EGP", ZA: "ZAR", NG: "NGN", KE: "KES", MA: "MAD",
  PR: "USD", EC: "USD", SV: "USD", PA: "USD",
};
for (const r of EURO) BY_REGION[r] = "EUR";

/** The currency where a locale's country is ("de-AT" → EUR, "en-GB" → GBP); dollars when it can't tell. */
export function currencyForLocale(locale: string | undefined) {
  if (!locale) return DEFAULT_CURRENCY;
  try {
    const region = new Intl.Locale(locale).maximize().region;
    const code = region ? BY_REGION[region] : undefined;
    return code && isCurrency(code) ? code : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

/** Every currency the runtime knows, for the picker (most-used first, then A–Z). */
export function currencyChoices() {
  const common = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "MXN", "BRL", "INR", "ZAR"];
  const all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("currency") ?? common;
  return { common: common.filter((c) => all.includes(c)), rest: all.filter((c) => !common.includes(c)) };
}
