/**
 * Google Books: books by ISBN, a second source after Open Library (better for recent and non-English books). Needs
 * the server admin's free API key, which this adapter is given a way to fetch (it's kept sealed — lib/server-keys.ts);
 * without one it knows nothing. Plain fetch; only the ISBN is sent. Answers in the barcode books' shape, like Open
 * Library's.
 */
import type { ProductInfo } from "@ferret/shared";
import type { ProductLookup } from "../../ports";

const API = "https://www.googleapis.com/books/v1/volumes";

type Volume = {
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    pageCount?: number;
    description?: string;
    language?: string;
    categories?: string[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    industryIdentifiers?: { type: string; identifier: string }[];
  };
};

/** Google's cover links are plain http with a page-curl effect: the same picture over https, without it. */
export const coverUrl = (link: string | undefined) => (link ? link.replace(/^http:\/\//, "https://").replace(/&edge=curl/, "") : null);

export function toBook(isbn: string, v: Volume): ProductInfo | null {
  const info = v.volumeInfo;
  const title = info?.title?.trim();
  // Google answers a search, not a lookup: only a book that really has this ISBN.
  if (!info || !title || !info.industryIdentifiers?.some((i) => i.identifier.replace(/-/g, "") === isbn)) return null;
  const published = [info.publisher?.trim(), info.publishedDate?.trim()].filter(Boolean).join(", ");
  const about = [info.subtitle?.trim(), info.pageCount ? `${info.pageCount} pages` : null, published || null].filter(Boolean).join(" · ");
  const cover = coverUrl(info.imageLinks?.thumbnail);
  return {
    barcode: isbn,
    title,
    ...(info.authors?.length ? { brand: info.authors.slice(0, 3).join(", ") } : {}),
    ...(about ? { description: about } : {}),
    category: "Books",
    images: cover ? [cover] : [],
    source: "Google Books",
    kind: "book",
    book: {
      title,
      ...(info.subtitle?.trim() ? { subtitle: info.subtitle.trim() } : {}),
      ...(info.authors?.length ? { authors: info.authors } : {}),
      ...(info.publisher?.trim() ? { publisher: info.publisher.trim() } : {}),
      ...(info.publishedDate?.trim() ? { published: info.publishedDate.trim() } : {}),
      ...(info.pageCount ? { pages: info.pageCount } : {}),
      // Google's blurbs can carry a little HTML.
      ...(info.description?.trim() ? { synopsis: info.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000) } : {}),
      ...(info.categories?.length ? { subjects: info.categories.slice(0, 5) } : {}),
      ...(info.language ? { language: info.language } : {}),
      ...(cover ? { covers: [cover] } : {}),
    },
  };
}

export class GoogleBooks implements ProductLookup {
  constructor(
    private readonly key: () => Promise<string | null>,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private ask(key: string, isbn: string) {
    return this.fetcher(`${API}?${new URLSearchParams({ q: `isbn:${isbn}`, key })}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  }

  /** Whether Google takes this key (before it's saved). */
  async check(key: string) {
    const res = await this.ask(key, "9780593135204");
    if (res.status === 400 || res.status === 403) return false;
    if (!res.ok) throw new Error(`Google Books: HTTP ${res.status}`);
    return true;
  }

  async lookup(isbn: string): Promise<ProductInfo | null> {
    const key = await this.key();
    if (!key) return null;
    const res = await this.ask(key, isbn);
    if (!res.ok) throw new Error(`Google Books: HTTP ${res.status}`);
    const body = (await res.json()) as { items?: Volume[] };
    for (const v of body.items ?? []) {
      const book = toBook(isbn, v);
      if (book) return book;
    }
    return null;
  }
}
