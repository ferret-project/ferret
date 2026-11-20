/**
 * Prices that come in another currency — UPCitemdb's are US dollars, card marketplaces' dollars or euros — in the
 * household's, with the day's exchange rates when the server fetches them (lib/exchange.ts on the server). Without a
 * rate a price shows in its own currency and isn't offered as a value.
 */
import type { ExchangeRates } from "@ferret/shared";
import { convertCents, formatMoney } from "@ferret/shared/utils";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { currentCurrency } from "./money";

/** The day's rates, or null (the server doesn't fetch them). */
export function useRates(): ExchangeRates | null {
  return useQuery({ queryKey: ["exchange-rates"], queryFn: api.exchangeRates, staleTime: 60 * 60_000 }).data?.rates ?? null;
}

/** An amount in `from` as the household's: its cents (null without a rate), and whether it was converted. */
export function inHousehold(cents: number, from: string, rates: ExchangeRates | null) {
  const to = currentCurrency();
  const converted = convertCents(cents, from, to, rates);
  return converted == null ? null : { cents: converted, converted: from !== to };
}

/** "$9.99"; "≈ 40,58 zł ($9.99)" when converted; in its own currency when there's no rate. */
export function foreignMoneyText(cents: number, from: string, rates: ExchangeRates | null) {
  const own = formatMoney(cents, from, { exact: true });
  const mine = inHousehold(cents, from, rates);
  if (!mine || !mine.converted) return own;
  return `≈ ${formatMoney(mine.cents, currentCurrency(), { exact: true })} (${own})`;
}
