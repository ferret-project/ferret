/** The Open Food Facts databases (lib/products.ts, adapters/local/openfacts.ts): asked when the product database doesn't know a code. */
import type { BarcodeMatch, ItemProduct, OpenFactsStatus, ProductInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { OpenFactsProducts, categoryOf, toProduct } from "../src/adapters/local/openfacts";
import type { ProductLookup } from "../src/ports";
import { FakeProducts, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const scan = (u: User, code: string) => json<{ match: BarcodeMatch | null }>(u.as(`/api/v1/barcodes/${code}`));

const DIET_COKE = "0049000028911";
const DRILL = "0885911475730";

class FakeOpenFacts implements ProductLookup {
  asked: string[] = [];
  async lookup(code: string): Promise<ProductInfo | null> {
    this.asked.push(code);
    if (code !== DIET_COKE) return null;
    return { barcode: code, title: "Diet Coke Soft Drink 144 fl oz", brand: "Coca-Cola", category: "Sodas", images: ["https://images.openfoodfacts.org/x.jpg"], source: "Open Food Facts" };
  }
}

describe("Open Food Facts look-ups", () => {
  it("are asked when the product database doesn't know a code, once switched on", async () => {
    const openFacts = new FakeOpenFacts();
    const products = new FakeProducts({ [DRILL]: { title: "DEWALT drill", images: [] } });
    const s = await setup({ products, openFacts });
    const ann = await s.user("ann");

    // Off: only the product database.
    expect((await scan(ann, DIET_COKE)).match).toBeNull();
    expect(openFacts.asked).toEqual([]);

    expect(await json<OpenFactsStatus>(send(ann, "PUT", "/api/v1/server/open-facts", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    const coke = await scan(ann, "0049000028920"); // a code nobody has asked about: both, in turn
    expect(coke.match).toBeNull();
    expect(products.calls).toContain("0049000028920");
    expect(openFacts.asked).toContain("0049000028920");

    // Known to the product database: Open Food Facts isn't asked.
    expect((await scan(ann, DRILL)).match).toMatchObject({ name: "DEWALT drill", source: "upcitemdb" });
    expect(openFacts.asked).not.toContain(DRILL);

    // Unknown to both, asked again a moment later: neither is asked twice.
    const before = [products.calls.length, openFacts.asked.length];
    await scan(ann, "0049000028920");
    expect([products.calls.length, openFacts.asked.length]).toEqual(before);
  });

  it("answer by themselves when there's no product database, and offer the product on a thing's page", async () => {
    const openFacts = new FakeOpenFacts();
    const s = await setup({ openFacts });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/open-facts", { enabled: true });
    expect((await scan(ann, DIET_COKE)).match).toMatchObject({ name: "Diet Coke Soft Drink 144 fl oz", brand: "Coca-Cola", source: "openfacts", sourceName: "Open Food Facts" });
    expect(await json(ann.as("/api/v1/server/open-facts"))).toMatchObject({ products: 1 });

    const soda = await ann.addItem({ name: "Soda", barcode: "049000028911" });
    await s.jobs.drain();
    expect(await json<ItemProduct>(ann.as(`/api/v1/items/${soda.id}/product`))).toMatchObject({ status: "found", product: { title: "Diet Coke Soft Drink 144 fl oz", source: "Open Food Facts" } });
  });

  it("still get asked when the product database fails", async () => {
    const openFacts = new FakeOpenFacts();
    const products: ProductLookup = { lookup: async () => Promise.reject(new Error("UPCitemdb: HTTP 429")) };
    const s = await setup({ products, openFacts });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/open-facts", { enabled: true });
    expect((await scan(ann, DIET_COKE)).match).toMatchObject({ source: "openfacts" });
  });
});

describe("the Open Food Facts adapter", () => {
  it("names a product with its size and keeps the most specific category", () => {
    expect(categoryOf("Diet beverages, Sodas")).toBe("Sodas");
    expect(categoryOf("Colas, pt:bebidas cafeína")).toBe("Colas");
    expect(toProduct("1", { product_name: "Nutella", quantity: "400 g e", brands: "Ferrero, Nutella", image_front_url: "https://images.openfoodfacts.org/n.jpg" }, "Open Food Facts")).toEqual({
      barcode: "1",
      title: "Nutella 400 g",
      brand: "Ferrero",
      images: ["https://images.openfoodfacts.org/n.jpg"],
      source: "Open Food Facts",
    });
    expect(toProduct("1", { product_name: "" }, "x")).toBeNull();
  });

  it("asks food, then household goods, then toiletries", async () => {
    const hosts: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      hosts.push(url.host);
      if (url.host === "world.openproductsfacts.org") return Response.json({ status: 1, product: { product_name: "AA batteries", quantity: "8" } });
      return Response.json({ status: 0 });
    }) as typeof fetch;
    const found = await new OpenFactsProducts(fetcher).lookup("0041333424019");
    expect(hosts).toEqual(["world.openfoodfacts.org", "world.openproductsfacts.org"]);
    expect(found).toMatchObject({ title: "AA batteries 8", source: "Open Products Facts" });
  });
});
