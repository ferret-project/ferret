/**
 * Open Library (openlibrary.org, the Internet Archive's): books by ISBN — no key, plain fetch, only the ISBN is sent.
 * Answers in the barcode books' shape (title, author as the "brand", a cover as the photo), marked as a book.
 */
import type { ProductInfo } from "@ferret/shared";
import type { ProductLookup } from "../../ports";

type Book = {
  title?: string;
  subtitle?: string;
  authors?: { name?: string }[];
  publishers?: { name?: string }[];
  publish_date?: string;
  number_of_pages?: number;
  cover?: { small?: string; medium?: string; large?: string };
  url?: string;
};

export class OpenLibraryBooks implements ProductLookup {
  async lookup(isbn: string): Promise<ProductInfo | null> {
    const key = `ISBN:${isbn}`;
    const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`;
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Ferret home inventory (book look-up)" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Open Library: HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, Book>;
    const book = body[key];
    const title = book?.title?.trim();
    if (!book || !title) return null;
    const authors = (book.authors ?? []).map((a) => a.name?.trim()).filter(Boolean) as string[];
    const publisher = book.publishers?.[0]?.name?.trim();
    const published = [publisher, book.publish_date?.trim()].filter(Boolean).join(", ");
    const about = [book.subtitle?.trim(), book.number_of_pages ? `${book.number_of_pages} pages` : null, published || null].filter(Boolean).join(" · ");
    const cover = book.cover?.large ?? book.cover?.medium;
    return {
      barcode: isbn,
      title,
      ...(authors.length ? { brand: authors.slice(0, 3).join(", ") } : {}),
      ...(about ? { description: about } : {}),
      category: "Books",
      images: cover?.startsWith("https://") ? [cover] : [],
      source: "Open Library",
      kind: "book",
    };
  }
}
