/** Books by ISBN from Open Library (lib/products.ts): a second barcode source, switched on by the server admin. */
import type { BarcodeMatch, ItemProduct, ProductInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import type { ProductLookup } from "../src/ports";
import { GoogleBooks, coverUrl, toBook } from "../src/adapters/local/googlebooks";
import { FakeProducts, setup } from "./helpers";
import { MergedBooks, mergeBooks } from "../src/lib/books";

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

  it("ask Google Books with Open Library once the server admin saves its key, and keep the key sealed", async () => {
    const books = new FakeBooks();
    const keys: string[] = [];
    const google = Object.assign(new FakeBooks(), {
      check: async (key: string) => key === "good-google-key",
      lookup: async (isbn: string): Promise<ProductInfo | null> => {
        keys.push(isbn);
        return isbn === "9780593135204" ? { barcode: isbn, title: "Project Hail Mary", brand: "Andy Weir", category: "Books", images: [], source: "Google Books", kind: "book" } : null;
      },
    });
    const s = await setup({ books, googleBooks: google });
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/books", { enabled: true });
    // No key yet: Open Library alone.
    await scan(ann, "9780593135204");
    expect(keys).toEqual([]);
    expect((await send(ann, "PUT", "/api/v1/server/books/google", { key: "a-wrong-key" })).status).toBe(422);
    expect(await json(send(ann, "PUT", "/api/v1/server/books/google", { key: "good-google-key" }))).toMatchObject({ google: { available: true, hint: "…-key" } });
    expect(JSON.stringify(await json(ann.as("/api/v1/server/books")))).not.toContain("good-google-key");
    const found = await scan(ann, "9780593135204");
    expect(found.match).toMatchObject({ name: "Project Hail Mary", sourceName: "Google Books" });
    // Both are asked about every book now, and what they say is merged.
    await scan(ann, LEAN_STARTUP);
    expect(keys).toEqual(["9780593135204", LEAN_STARTUP]);
    const bob = await s.user("bob");
    expect((await send(bob, "PUT", "/api/v1/server/books/google", { key: "good-google-key" })).status).toBe(403);
  });

  it("take only a Google Books answer that really has the ISBN, over https", async () => {
    expect(coverUrl("http://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api")).toBe("https://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=1&source=gbs_api");
    const volume = { volumeInfo: { title: "Project Hail Mary", authors: ["Andy Weir"], pageCount: 497, publisher: "Ballantine Books", publishedDate: "2021-05-04", industryIdentifiers: [{ type: "ISBN_13", identifier: "9780593135204" }] } };
    expect(toBook("9780593135204", volume)).toMatchObject({ title: "Project Hail Mary", brand: "Andy Weir", description: "497 pages · Ballantine Books, 2021-05-04", source: "Google Books" });
    expect(toBook("9780000000002", volume)).toBeNull();
    const urls: URL[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify({ items: [{ volumeInfo: { title: "Something else", industryIdentifiers: [{ type: "ISBN_13", identifier: "9781111111111" }] } }, volume] }), { status: 200 });
    }) as typeof fetch;
    expect(await new GoogleBooks(async () => null, fetcher).lookup("9780593135204")).toBeNull(); // no key: not asked
    expect(urls).toHaveLength(0);
    expect(await new GoogleBooks(async () => "k", fetcher).lookup("9780593135204")).toMatchObject({ title: "Project Hail Mary" });
    expect(urls[0]!.searchParams.get("q")).toBe("isbn:9780593135204");
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

describe("books merged from every source, field by field", () => {
  const ol: ProductInfo = {
    barcode: "9780593135204", title: "Project Hail Mary", brand: "Andy Weir", category: "Books", images: [], source: "Open Library", kind: "book",
    book: { title: "Project Hail Mary", authors: ["Andy Weir"], publisher: "Ballantine Books", published: "2021", pages: 476 },
  };
  const google: ProductInfo = {
    barcode: "9780593135204", title: "Project Hail Mary: A Novel", brand: "Andy Weir", category: "Books", images: ["https://books.google.com/c.jpg"], source: "Google Books", kind: "book",
    book: { title: "Project Hail Mary: A Novel", authors: ["Andy Weir"], publisher: "Random House", published: "2021-05-04", pages: 497, synopsis: "A lone astronaut…", language: "en", covers: ["https://books.google.com/c.jpg"] },
  };
  const hardcover: ProductInfo = {
    barcode: "9780593135204", title: "Project Hail Mary: A Novel", category: "Books", images: ["https://hardcover.app/c.jpg"], source: "Hardcover", kind: "book",
    book: { title: "Project Hail Mary: A Novel", series: "", covers: ["https://hardcover.app/c.jpg"] },
  };

  it("takes each field from the source best at it, and says where it came from", () => {
    const merged = mergeBooks("9780593135204", [{ source: "Open Library", info: ol }, { source: "Google Books", info: google }])!;
    expect(merged.book).toMatchObject({
      title: "Project Hail Mary", publisher: "Ballantine Books", pages: 476, synopsis: "A lone astronaut…", language: "en",
      covers: ["https://books.google.com/c.jpg"],
      from: { title: "Open Library", publisher: "Open Library", synopsis: "Google Books", covers: "Google Books" },
    });
    expect(merged).toMatchObject({ title: "Project Hail Mary", brand: "Andy Weir", images: ["https://books.google.com/c.jpg"], source: "Open Library and Google Books", kind: "book" });
    expect(merged.description).toBe("476 pages · Ballantine Books, 2021");
  });

  it("goes with what most sources agree on, and keeps every cover as a fallback", () => {
    const merged = mergeBooks("9780593135204", [{ source: "Open Library", info: ol }, { source: "Google Books", info: google }, { source: "Hardcover", info: hardcover }])!;
    expect(merged.book?.title).toBe("Project Hail Mary: A Novel"); // two of three
    expect(merged.book?.from?.title).toBe("Hardcover");
    expect(merged.images).toEqual(["https://hardcover.app/c.jpg", "https://books.google.com/c.jpg"]);
    expect(merged.book?.series).toBeUndefined(); // empty isn't an answer
  });

  it("answers when one source fails and another knows the book; throws only when all fail", async () => {
    const failing: ProductLookup = { lookup: async () => { throw new Error("down"); } };
    const knows: ProductLookup = { lookup: async () => google };
    const unknown: ProductLookup = { lookup: async () => null };
    expect(await new MergedBooks([{ name: "Open Library", lookup: failing }, { name: "Google Books", lookup: knows }]).lookup("9780593135204")).toMatchObject({ title: "Project Hail Mary: A Novel", source: "Google Books" });
    expect(await new MergedBooks([{ name: "Open Library", lookup: unknown }, { name: "Google Books", lookup: unknown }]).lookup("9780593135204")).toBeNull();
    await expect(new MergedBooks([{ name: "Open Library", lookup: failing }, { name: "Google Books", lookup: unknown }]).lookup("9780593135204")).rejects.toThrow("down");
  });
});
