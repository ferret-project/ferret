/**
 * Books by ISBN from every book source the server has switched on — Open Library (keyless), Google Books and
 * Hardcover (each with the server admin's key) — asked at once and merged field by field, rather than trusting
 * whichever answered first: the title most of them agree on, the publisher and date of the edition from the
 * catalogues that track editions, the cover and blurb from the ones that have them. `book.from` says where each field
 * came from. Any source failing is fine while another answers; all of them failing throws (the job tries again).
 */
import type { BookDetails, BookField, ProductInfo } from "@ferret/shared";
import type { ProductLookup } from "../ports";

export interface BookSource {
  /** As shown to people: "Open Library", "Google Books", "Hardcover". */
  name: string;
  lookup: ProductLookup;
}

/** For each field, the sources best at it, first to last (a source not listed comes after them). */
const PREFER: Record<BookField, string[]> = {
  title: ["Open Library", "Hardcover", "Google Books"],
  subtitle: ["Open Library", "Google Books", "Hardcover"],
  authors: ["Open Library", "Hardcover", "Google Books"],
  // The edition's own facts: the catalogues that record editions.
  publisher: ["Open Library", "Google Books", "Hardcover"],
  published: ["Open Library", "Google Books", "Hardcover"],
  pages: ["Open Library", "Google Books", "Hardcover"],
  // Open Library rarely has a blurb or a cover for newer books; the others usually do.
  synopsis: ["Google Books", "Hardcover", "Open Library"],
  covers: ["Hardcover", "Google Books", "Open Library"],
  subjects: ["Google Books", "Open Library", "Hardcover"],
  series: ["Hardcover", "Open Library", "Google Books"],
  language: ["Google Books", "Hardcover", "Open Library"],
};

const rank = (field: BookField, source: string) => {
  const i = PREFER[field].indexOf(source);
  return i < 0 ? PREFER[field].length : i;
};
const present = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v != null);
const same = (v: unknown) => (Array.isArray(v) ? v.join("|") : String(v)).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * One field from several answers: what most of them agree on (two or more saying the same), else the best source's.
 * Covers are the exception — every distinct picture is kept, best source first, so there's a fallback.
 */
function pick<K extends BookField>(field: K, answers: { source: string; book: BookDetails }[]): { value: BookDetails[K]; from: string } | null {
  const having = answers.filter((a) => present(a.book[field])).sort((a, b) => rank(field, a.source) - rank(field, b.source));
  if (!having.length) return null;
  if (field === "covers") {
    const covers = [...new Set(having.flatMap((a) => a.book.covers ?? []))];
    return { value: covers as BookDetails[K], from: having[0]!.source };
  }
  const votes = new Map<string, number>();
  for (const a of having) votes.set(same(a.book[field]), (votes.get(same(a.book[field])) ?? 0) + 1);
  const agreed = having.find((a) => (votes.get(same(a.book[field])) ?? 0) >= 2 && (votes.get(same(a.book[field])) ?? 0) > having.length / 2);
  const chosen = agreed ?? having[0]!;
  return { value: chosen.book[field], from: chosen.source };
}

const FIELDS: BookField[] = ["title", "subtitle", "authors", "publisher", "published", "pages", "synopsis", "subjects", "series", "language", "covers"];

/** The answers merged into one book, in the barcode books' shape (author as the "brand", the cover as the photo). */
export function mergeBooks(isbn: string, answers: { source: string; info: ProductInfo }[]): ProductInfo | null {
  const books = answers.map((a) => ({ source: a.source, book: a.info.book ?? fromFlat(a.info) }));
  if (!books.length) return null;
  const merged: Partial<BookDetails> = {};
  const from: BookDetails["from"] = {};
  for (const field of FIELDS) {
    const got = pick(field, books);
    if (!got) continue;
    (merged as Record<string, unknown>)[field] = got.value;
    from[field] = got.from;
  }
  if (!merged.title) return null;
  const book = { ...merged, from } as BookDetails;
  const published = [book.publisher, book.published].filter(Boolean).join(", ");
  const about = [book.subtitle, book.pages ? `${book.pages} pages` : null, published || null].filter(Boolean).join(" · ");
  const used = [...new Set(Object.values(from))].sort((a, b) => FIELDS.findIndex((f) => from[f] === a) - FIELDS.findIndex((f) => from[f] === b));
  return {
    barcode: isbn,
    title: book.title,
    ...(book.authors?.length ? { brand: book.authors.slice(0, 3).join(", ") } : {}),
    ...(about ? { description: about } : {}),
    category: "Books",
    images: book.covers ?? [],
    source: used.join(" and "),
    kind: "book",
    book,
  };
}

/** An answer from before sources gave details: what its flat fields say. */
function fromFlat(info: ProductInfo): BookDetails {
  return {
    title: info.title,
    ...(info.brand ? { authors: info.brand.split(", ") } : {}),
    ...(info.images.length ? { covers: info.images } : {}),
  };
}

/** Every book source asked at once, merged. Null when none knows the ISBN; throws only when every one failed. */
export class MergedBooks implements ProductLookup {
  constructor(private readonly sources: BookSource[]) {}

  async lookup(isbn: string): Promise<ProductInfo | null> {
    const results = await Promise.allSettled(this.sources.map((s) => s.lookup.lookup(isbn)));
    const answers = results.flatMap((r, i) => (r.status === "fulfilled" && r.value ? [{ source: this.sources[i]!.name, info: r.value }] : []));
    if (!answers.length) {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      // Every source failed: try again later. Some said "don't know" and others failed: try again too, the failed
      // one might know.
      if (failed) throw failed.reason;
      return null;
    }
    return mergeBooks(isbn, answers);
  }
}
