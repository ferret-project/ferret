/**
 * Frankfurter (frankfurter.dev, open source): the European Central Bank's daily reference rates for about 30
 * currencies. No key, plain fetch, and nothing about anyone is sent — only "today's rates, please".
 */
import type { ExchangeRates } from "@ferret/shared";
import type { ExchangeRateSource } from "../../ports";

const USER_AGENT = "Ferret/1 (https://github.com/ferret-project/ferret)";

export class FrankfurterRates implements ExchangeRateSource {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async latest(): Promise<ExchangeRates> {
    const res = await this.fetcher("https://api.frankfurter.dev/v1/latest?base=EUR", { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Frankfurter: HTTP ${res.status}`);
    const body = (await res.json()) as { base?: string; date?: string; rates?: Record<string, number> };
    if (!body.base || !body.date || !body.rates) throw new Error("Frankfurter: an answer without rates");
    return { base: body.base, date: body.date, rates: { ...body.rates, [body.base]: 1 } };
  }
}
