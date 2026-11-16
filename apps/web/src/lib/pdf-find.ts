/**
 * Finding a search's words in a PDF the viewer opened (DocumentViewer.tsx): which pages have them, and where on each
 * page to mark them. Search matches word stems ("filters" finds "filter"), so this does roughly the same.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

/** A box to mark, in the page's own units at scale 1, from its top left. */
export interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PageMatches {
  /** 0-based. */
  page: number;
  marks: Mark[];
}

function stem(word: string) {
  for (const end of ["ing", "ed", "es", "s"]) if (word.length - end.length >= 3 && word.endsWith(end)) return word.slice(0, -end.length);
  return word;
}

/** The words of a search, as stems. */
export function termsOf(find: string) {
  return [...new Set((find.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2).map(stem))];
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Runs of three words, to recognise a passage on a page whatever its line breaks and layout. */
const shinglesOf = (words: string[]) => new Set(words.slice(2).map((w, i) => `${words[i]} ${words[i + 1]} ${w}`));

/**
 * The pages with the most of the search's words (all of them, if any page has them all), in order, and the boxes of
 * those words on each. With `near` (the passage the search found), the page that passage is on comes first. A PDF with
 * no text (a scan) finds nothing.
 */
export async function findInPdf(
  pdf: PDFDocumentProxy,
  find: string,
  transform: (m: number[], n: number[]) => number[],
  near?: string,
): Promise<PageMatches[]> {
  const terms = termsOf(find);
  if (!terms.length) return [];
  const passage = near ? shinglesOf(wordsOf(near)) : new Set<string>();
  let nearest = { page: -1, score: 0 };
  const found: (PageMatches & { score: number })[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const hit = new Set<string>();
    const marks: Mark[] = [];
    const pageWords: string[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str) continue;
      if (passage.size) pageWords.push(...wordsOf(item.str));
      const text = item.str;
      const tx = transform(viewport.transform, item.transform);
      const height = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || item.height;
      const left = tx[4] ?? 0;
      const top = (tx[5] ?? 0) - height;
      for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
        const word = m[0].toLowerCase();
        const term = terms.find((t) => word.startsWith(t) || stem(word) === t);
        if (!term) continue;
        hit.add(term);
        const start = m.index ?? 0;
        marks.push({
          x: left + (item.width * start) / text.length,
          y: top,
          w: (item.width * m[0].length) / text.length,
          h: height * 1.15,
        });
      }
    }
    page.cleanup();
    if (!hit.size) continue;
    found.push({ page: n - 1, marks, score: hit.size });
    if (passage.size) {
      const own = shinglesOf(pageWords);
      let score = 0;
      for (const s of passage) if (own.has(s)) score++;
      if (score > nearest.score) nearest = { page: n - 1, score };
    }
  }
  const best = Math.max(0, ...found.map((f) => f.score));
  const pages = found.filter((f) => f.score === best || f.page === nearest.page);
  const first = pages.findIndex((f) => f.page === nearest.page);
  if (first > 0) pages.unshift(...pages.splice(first, 1));
  return pages.map(({ page, marks }) => ({ page, marks }));
}
