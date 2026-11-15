/** Books by ISBN from Open Library (lib/products.ts): a second barcode source, switched on by the server admin. */
import type { BarcodeMatch, ItemProduct, ProductInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import type { ProductLookup } from "../src/ports";
import { FakeProducts, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const scan = (u: User, code: string) => json<{ match: BarcodeMatch | null }>(u.as(`/api/v1/barcodes/${code}`));

const LEAN_STARTUP = "9780307887894";

class FakeBooks implements ProductLookup {
  asked: string[] = [];
  async lookup(isbn: string): Promise<ProductInfo | null> {
    this.asked.push(isbn);
    if (isbn !== LEAN_STARTUP) return null;
    return {
      barcode: isbn,
      title: "The Lean Startup",
      brand: "Eric Ries",
      description: "336 pages · Crown Business, September 13, 2011",
      category: "Books",
      images: ["https://covers.openlibrary.org/b/id/7104760-L.jpg"],
      source: "Open Library",
      kind: "book",
    };
  }
}

describe("book look-ups", () => {
  it("ask Open Library about an ISBN once switched on — and never the product database, nor a plan's lookups", async () => {
    const books = new FakeBooks();
    const products = new FakeProducts();
    const s = await setup({ books, products });
    const ann = await s.user("ann");

    // Off: an ISBN goes to the product database like any barcode.
    await scan(ann, LEAN_STARTUP);
    expect(books.asked).toEqual([]);

    expect(await json(send(ann, "PUT", "/api/v1/server/books", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    const isbn = "9781492052203";
    const found = await scan(ann, LEAN_STARTUP); // asked of Open Library now: the earlier "unknown" was the product database's
    expect(books.asked).toContain(LEAN_STARTUP);
    expect(found.match).toMatchObject({ name: "The Lean Startup", brand: "Eric Ries", source: "openlibrary" });
    // An ISBN Open Library doesn't know isn't sent to the product database either.
    const asked = products.calls.length;
    await scan(ann, isbn);
    expect(books.asked).toContain(isbn);
    expect(products.calls.length).toBe(asked);
    // Not a book: the product database, as ever.
    await scan(ann, "012345678905");
    expect(products.calls.at(-1)).toBe("0012345678905");
    expect(await json(ann.as("/api/v1/server/books"))).toMatchObject({ books: 1 });
  });

  it("offer a saved book's title, author and cover on its page", async () => {
    const books = new FakeBooks();
    const s = await setup({ books });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/books", { enabled: true });
    const book = await ann.addItem({ name: "Book", barcode: LEAN_STARTUP });
    await s.jobs.drain();
    const product = await json<ItemProduct>(ann.as(`/api/v1/items/${book.id}/product`));
    expect(product).toMatchObject({ status: "found", product: { title: "The Lean Startup", brand: "Eric Ries", kind: "book", source: "Open Library" } });
  });
});
