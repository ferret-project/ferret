/**
 * Open Library's search (openlibrary.org): books by title and author — for the ones a barcode can't find, like old
 * books printed before ISBNs — with the cover, first year published and author. No key (it comes under the book
 * look-ups switch); plain fetch; only the words searched are sent.
 */
import type { CollectibleInfo } from "@ferret/shared";
import type { CollectibleCatalog } from "../../ports";

const API = "https://openlibrary.org/search.json";
const USER_AGENT = "Ferret/1 ( https://github.com/ferret-project/ferret )";
const FIELDS = "key,title,subtitle,author_name,first_publish_year,cover_i,publisher,edition_count,number_of_pages_median";

type Doc = { key: string; title: string; subtitle?: string; author_name?: string[]; first_publish_year?: number; cover_i?: number; publisher?: string[]; edition_count?: number; number_of_pages_median?: number };

export function toBook(d: Doc): CollectibleInfo {
  const id = d.key.replace(/^\/works\//, "");
  return {
    kind: "book",
    id,
    name: d.title,
    title: d.subtitle ?? null,
    author: d.author_name?.slice(0, 3).join(", ") ?? null,
    year: d.first_publish_year ?? null,
    publisher: d.publisher?.[0] ?? null,
    pages: d.number_of_pages_median ?? null,
    editions: d.edition_count ?? null,
    image: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    imageLarge: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    url: `https://openlibrary.org/works/${id}`,
  };
}

export class OpenLibraryWorks implements CollectibleCatalog {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private async search(params: Record<string, string>) {
    const res = await this.fetcher(`${API}?${new URLSearchParams({ fields: FIELDS, ...params })}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Open Library: HTTP ${res.status}`);
    return ((await res.json()) as { docs?: Doc[] }).docs ?? [];
  }

  /** No key to check. */
  async check() {
    return true;
  }

  async get(_key: string, id: string) {
    if (!/^OL\d+W$/.test(id)) return null;
    const [doc] = await this.search({ q: `key:/works/${id}`, limit: "1" });
    return doc ? toBook(doc) : null;
  }

  async find(_key: string, q: { text: string; year?: number | null }) {
    const text = q.text.trim();
    if (!text) return [];
    const found = (await this.search({ q: text, limit: "20" })).map(toBook);
    return q.year ? [...found.filter((b) => b.year === q.year), ...found.filter((b) => b.year !== q.year)] : found;
  }
}
