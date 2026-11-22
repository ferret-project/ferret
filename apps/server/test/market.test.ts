/** "On eBay now" (lib/market.ts, adapters/local/ebay.ts): listings by barcode, else brand and model; kept in memory only. */
import type { ItemMarketListings, MarketListing, MarketListingsStatus } from "@ferret/shared";
import { afterEach, describe, expect, it } from "vitest";
import { EbayListings, toListing } from "../src/adapters/local/ebay";
import { forgetMarketListings, marketQuery } from "../src/lib/market";
import type { MarketListings, MarketQuery } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const listing = (title: string, dollars: number, currency = "USD"): MarketListing => ({
  title,
  priceCents: dollars * 100,
  currency,
  shippingCents: 0,
  condition: "Used",
  buyingOption: "fixed",
  bids: null,
  endsAt: null,
  imageUrl: null,
  url: `https://www.ebay.com/itm/${dollars}`,
});

class FakeEbay implements MarketListings {
  asked: MarketQuery[] = [];
  keys = "APP-ID CERT-ID";
  saved = false;
  failing = false;
  async check(key: string) {
    return key === this.keys;
  }
  async search(q: MarketQuery) {
    this.asked.push(q);
    if (this.failing) throw new Error("eBay search: HTTP 503");
    if (q.gtin === "885911425308") return { total: 2, listings: [listing("DeWalt DCD771 drill", 60), listing("DCD771C2 kit", 95)] };
    if (q.text === "Makita XFD131") return { total: 7, listings: [listing("Makita XFD131 driver", 80), listing("Makita XFD-131 bare", 45), listing("Makita XFD10Z drill", 30), listing("Makita XFD131", 120)] };
    return { total: 0, listings: [] };
  }
}

afterEach(() => forgetMarketListings());

describe("On eBay now", () => {
  it("is off until the server admin saves keys eBay accepts", async () => {
    const ebay = new FakeEbay();
    const { user } = await setup({ marketListings: ebay });
    const ann = await user("ann");
    const drill = await ann.addItem({ name: "Drill", brand: "DeWalt", model: "DCD771", barcode: "0885911425308" });

    expect(await json(ann.as(`/api/v1/items/${drill.id}/ebay`))).toEqual({ status: "off" });
    expect(await json<MarketListingsStatus>(ann.as("/api/v1/server/ebay"))).toEqual({ available: true, hint: null });
    expect((await send(ann, "PUT", "/api/v1/server/ebay", { key: "only-one-part" })).status).toBe(422);
    expect((await send(ann, "PUT", "/api/v1/server/ebay", { key: "WRONG-ID CERT-ID" })).status).toBe(422);
    expect(await json(send(ann, "PUT", "/api/v1/server/ebay", { key: "APP-ID CERT-ID" }))).toEqual({ available: true, hint: "…T-ID" });
    expect(ebay.asked).toEqual([]);

    const card = await json<ItemMarketListings>(ann.as(`/api/v1/items/${drill.id}/ebay`));
    expect(card).toMatchObject({
      status: "found",
      by: "barcode",
      query: "885911425308",
      marketplace: "EBAY_US",
      total: 2,
      range: { lowCents: 6000, highCents: 9500, currency: "USD", of: 2 },
      searchUrl: "https://www.ebay.com/sch/i.html?_nkw=885911425308",
    });
    expect(card.listings).toHaveLength(2);
    // The 13-digit EAN goes as eBay's 12-digit UPC-A.
    expect(ebay.asked).toEqual([{ marketplace: "EBAY_US", gtin: "885911425308", limit: 20 }]);

    // Asked again within the hour: from memory, eBay isn't.
    await json(ann.as(`/api/v1/items/${drill.id}/ebay`));
    expect(ebay.asked).toHaveLength(1);

    expect(await json(send(ann, "PUT", "/api/v1/server/ebay", { key: null }))).toEqual({ available: true, hint: null });
    expect(await json(ann.as(`/api/v1/items/${drill.id}/ebay`))).toEqual({ status: "off" });
  });

  it("falls back to brand and model, needs a model number, never writes to the thing, and says when eBay fails", async () => {
    const ebay = new FakeEbay();
    const { user } = await setup({ marketListings: ebay });
    const ann = await user("ann");
    await send(ann, "PUT", "/api/v1/server/ebay", { key: "APP-ID CERT-ID" });
    const driver = await ann.addItem({ name: "Impact driver", brand: "Makita", model: "XFD131", barcode: "088381111111" });
    const couch = await ann.addItem({ name: "Couch", brand: "IKEA", model: "Classic" });

    const card = await json<ItemMarketListings>(ann.as(`/api/v1/items/${driver.id}/ebay`));
    expect(card).toMatchObject({ status: "found", by: "words", query: "Makita XFD131", total: 7, range: { lowCents: 4500, highCents: 12000, of: 3 } });
    expect(ebay.asked.map((q) => q.gtin ?? q.text)).toEqual(["088381111111", "Makita XFD131"]);
    expect(await json(ann.as(`/api/v1/items/${couch.id}/ebay`))).toEqual({ status: "none" });

    const after = await json<Record<string, unknown>>(ann.as(`/api/v1/items/${driver.id}`));
    expect(after.valueCents ?? null).toBeNull();

    forgetMarketListings();
    ebay.failing = true;
    expect(await json(ann.as(`/api/v1/items/${driver.id}/ebay`))).toEqual({ status: "unavailable" });
  });

  it("is the server admin's to set up", async () => {
    const { user } = await setup({ marketListings: new FakeEbay() });
    const ann = await user("ann");
    const bob = await user("bob");
    void ann;
    expect((await send(bob, "PUT", "/api/v1/server/ebay", { key: "APP-ID CERT-ID" })).status).toBe(403);
  });
});

describe("eBay's search terms", () => {
  it("picks a barcode and a brand with a model number", () => {
    expect(marketQuery({ name: "Drill", barcode: "0885911425308", brand: "DeWalt", model: "DCD771" })).toEqual({ gtin: "885911425308", words: "DeWalt DCD771", model: "DCD771" });
    expect(marketQuery({ name: "Book", barcode: "9780140449136" })).toEqual({ gtin: "9780140449136", words: null, model: null });
    expect(marketQuery({ name: "Phone", brand: "Apple", model: "Apple iPhone 12" })).toEqual({ gtin: null, words: "Apple iPhone 12", model: "APPLEIPHONE12" });
    expect(marketQuery({ name: "Couch", brand: "IKEA", model: "Classic" })).toBeNull();
    expect(marketQuery({ name: "Thing", barcode: "X-HM://0023" })).toBeNull();
  });
});

describe("the eBay adapter", () => {
  const summary = {
    title: "DeWalt DCD771C2",
    price: { value: "89.99", currency: "USD" },
    buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
    condition: "Used",
    image: { imageUrl: "https://i.ebayimg.com/images/g/a/s-l225.jpg" },
    itemWebUrl: "https://www.ebay.com/itm/1234",
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "0.00", currency: "USD" } }],
    seller: { username: "someone", feedbackScore: 12 },
  };

  it("keeps what the card shows and drops who's selling", () => {
    const l = toListing(summary)!;
    expect(l).toEqual({
      title: "DeWalt DCD771C2",
      priceCents: 8999,
      currency: "USD",
      shippingCents: 0,
      condition: "Used",
      buyingOption: "fixed",
      bids: null,
      endsAt: null,
      imageUrl: "https://i.ebayimg.com/images/g/a/s-l225.jpg",
      url: "https://www.ebay.com/itm/1234",
    });
    expect(JSON.stringify(l)).not.toContain("someone");
    const auction = toListing({ ...summary, buyingOptions: ["AUCTION"], price: undefined, currentBidPrice: { value: "12.50", currency: "USD" }, bidCount: 3, itemEndDate: "2026-11-25T18:00:00.000Z" })!;
    expect(auction).toMatchObject({ priceCents: 1250, buyingOption: "auction", bids: 3, endsAt: "2026-11-25T18:00:00.000Z" });
    expect(toListing({ ...summary, itemWebUrl: "javascript:alert(1)" })).toBeNull();
  });

  it("gets a token with the keys, reuses it, and searches the marketplace", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/oauth2/token")) {
        const auth = (init?.headers as Record<string, string>).Authorization;
        return auth === `Basic ${btoa("APP:CERT")}` ? Response.json({ access_token: "tok", expires_in: 7200 }) : Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({ total: 1, itemSummaries: [summary] });
    }) as typeof fetch;
    const ebay = new EbayListings(async () => "APP CERT", fetcher);
    expect(await ebay.check("APP WRONG")).toBe(false);
    expect(await ebay.check("APP CERT")).toBe(true);
    const found = await ebay.search({ marketplace: "EBAY_GB", text: "DeWalt DCD771", limit: 20 });
    await ebay.search({ marketplace: "EBAY_GB", gtin: "885911425308", limit: 20 });
    expect(found?.total).toBe(1);
    expect(calls.filter((c) => c.url.includes("/oauth2/token"))).toHaveLength(2);
    const search = calls.find((c) => c.url.includes("item_summary/search"))!;
    expect(search.url).toContain("q=DeWalt+DCD771");
    expect((search.init?.headers as Record<string, string>)["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_GB");
    expect((search.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(await new EbayListings(async () => null, fetcher).search({ marketplace: "EBAY_US", text: "x", limit: 1 })).toBeNull();
  });
});
