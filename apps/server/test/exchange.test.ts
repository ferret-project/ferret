/** Exchange rates (lib/exchange.ts): prices in another currency shown, and offered, in the household's. */
import type { BarcodeMatch, CardInfo, ExchangeRateStatus, ExchangeRates } from "@ferret/shared";
import { convertCents } from "@ferret/shared/utils";
import { describe, expect, it } from "vitest";
import { FrankfurterRates } from "../src/adapters/local/frankfurter";
import { priceFor } from "../src/lib/cards";
import type { CardCatalog, ExchangeRateSource } from "../src/ports";
import { FakeProducts, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const RATES: ExchangeRates = { base: "EUR", date: "2026-11-20", rates: { EUR: 1, USD: 1.25, PLN: 4.25 } };

class FakeRates implements ExchangeRateSource {
  calls = 0;
  async latest() {
    this.calls++;
    return RATES;
  }
}

const CARD: CardInfo = {
  game: "pokemon",
  id: "sv03.5-025",
  name: "Pikachu",
  set: "151",
  setCode: "sv03.5",
  number: "025",
  finishes: ["Normal"],
  prices: [
    { finish: "Normal", currency: "USD", cents: 100, source: "TCGplayer" },
    { finish: "Normal", currency: "EUR", cents: 90, source: "Cardmarket" },
  ],
};

describe("exchange rates", () => {
  it("convert through the base currency, and know when they can't", () => {
    expect(convertCents(1000, "USD", "PLN", RATES)).toBe(3400); // $10 → €8 → 34 zł
    expect(convertCents(1000, "USD", "USD", null)).toBe(1000);
    expect(convertCents(1000, "USD", "JPY", RATES)).toBeNull();
    expect(convertCents(1000, "USD", "PLN", null)).toBeNull();
  });

  it("price a card in the household's currency: its own marketplace first, else TCGplayer's converted", () => {
    expect(priceFor(CARD, null, "EUR", RATES)).toMatchObject({ cents: 90, source: "Cardmarket" });
    expect(priceFor(CARD, null, "PLN", RATES)).toEqual({ finish: "Normal", currency: "PLN", cents: 340, source: "TCGplayer", original: { cents: 100, currency: "USD" } });
    expect(priceFor(CARD, null, "PLN", null)).toBeNull();
  });

  it("are off until the server admin switches them on, then fetched once a day for everyone", async () => {
    const exchangeRates = new FakeRates();
    const s = await setup({ exchangeRates });
    const ann = await s.user("ann");
    expect(await json(ann.as("/api/v1/exchange-rates"))).toEqual({ rates: null });
    expect(await json<ExchangeRateStatus>(send(ann, "PUT", "/api/v1/server/exchange-rates", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    await s.jobs.drain();
    expect(await json(ann.as("/api/v1/exchange-rates"))).toEqual({ rates: RATES });
    expect(await json(ann.as("/api/v1/server/exchange-rates"))).toMatchObject({ date: "2026-11-20" });
    // Asked again the same day: the kept rates do.
    await s.jobs.enqueue("exchange-rates.refresh", {});
    await s.jobs.drain();
    expect(exchangeRates.calls).toBe(1);
    // Off again: none.
    await send(ann, "PUT", "/api/v1/server/exchange-rates", { enabled: false });
    expect(await json(ann.as("/api/v1/exchange-rates"))).toEqual({ rates: null });
  });

  it("price a card thing in złoty", async () => {
    const pokemon: CardCatalog = { find: async () => [CARD], get: async () => CARD };
    const s = await setup({ exchangeRates: new FakeRates(), cards: { pokemon } });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/cards", { enabled: true });
    await send(ann, "PUT", "/api/v1/household/settings", { currency: "PLN" });
    const card = await ann.addItem({ name: "Pikachu", card: { game: "pokemon", id: CARD.id } });
    expect((await json<{ price: unknown }>(ann.as(`/api/v1/items/${card.id}/card`))).price).toBeNull(); // no rates yet
    await send(ann, "PUT", "/api/v1/server/exchange-rates", { enabled: true });
    await s.jobs.drain();
    expect((await json<{ price: unknown }>(ann.as(`/api/v1/items/${card.id}/card`))).price).toMatchObject({ currency: "PLN", cents: 340, original: { currency: "USD", cents: 100 } });
  });

  it("say which currency a product database's price is in", async () => {
    const products = new FakeProducts({ "0012345678905": { title: "Drill", images: [], typicalPriceCents: 9999, currency: "USD" } });
    const s = await setup({ products });
    const ann = await s.user("ann");
    expect((await json<{ match: BarcodeMatch }>(ann.as("/api/v1/barcodes/012345678905"))).match).toMatchObject({ typicalPriceCents: 9999, priceCurrency: "USD" });
  });

  it("are read from Frankfurter's answer, the base counted as 1", async () => {
    const fetcher = (async () => Response.json({ amount: 1, base: "EUR", date: "2026-11-20", rates: { USD: 1.25 } })) as unknown as typeof fetch;
    expect(await new FrankfurterRates(fetcher).latest()).toEqual({ base: "EUR", date: "2026-11-20", rates: { USD: 1.25, EUR: 1 } });
  });
});
