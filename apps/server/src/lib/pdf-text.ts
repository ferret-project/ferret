/**
 * Pages a document reader missed. docling reads a PDF's layout (headings, tables) well, but can drop a page — a parts
 * list of dot leaders, an accessories page it took for a picture. The PDF's own text layer (PdfPages.pageTexts) has
 * every page's words, without the layout: a page whose words are mostly not in docling's reading is added after it,
 * under "Page N", so search and Ask find it and the model reads it.
 */

/** Read this many pages at most (a long manual is ~100). */
export const MAX_TEXT_PAGES = 300;
/** A page with fewer distinct words than this isn't worth adding (a cover, a blank page, a page number). */
const MIN_WORDS = 12;
/** Fewer of its words than this share in docling's reading, and the page counts as missed. */
const MISSED_BELOW = 0.6;
/** A part or model number: letters and digits together, or a long number ("717531", "jcdc3-63") — not "2" or "1/2". */
const isCode = (w: string) => /\d/.test(w) && w.length >= 5;
/** A line on a page docling did read needs this many words to count (not a page number or a running header). */
const MIN_LINE_WORDS = 3;

const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]*[\p{L}\p{N}]/gu) ?? []).filter((w) => w.length >= 3));

const share = (words: Set<string>, read: Set<string>) => {
  let found = 0;
  for (const w of words) if (read.has(w)) found++;
  return words.size ? found / words.size : 1;
};

/**
 * What docling's Markdown lacks, as [page number (from 1), text]: a page whose words are mostly not in it, whole; on a
 * page it did read, the lines with a part or model number it doesn't have (a small table under a heading it kept — a
 * manual's "Optional accessories": every word there is elsewhere in the manual but the part numbers).
 */
export function missedPages(markdown: string, pages: string[]): [number, string][] {
  const read = wordsOf(markdown);
  const out: [number, string][] = [];
  pages.forEach((text, i) => {
    const words = wordsOf(text);
    if (words.size < MIN_WORDS) return;
    if (share(words, read) < MISSED_BELOW) return void out.push([i + 1, text]);
    const lines = text.split("\n").filter((line) => {
      const lineWords = wordsOf(line);
      return lineWords.size >= MIN_LINE_WORDS && [...lineWords].some((w) => isCode(w) && !read.has(w));
    });
    if (lines.length) out.push([i + 1, lines.join("\n")]);
  });
  return out;
}

/** A page's text as Markdown: runs of spaces and dot leaders ("Bag ........ 717531") tidied. */
const tidy = (text: string) =>
  text
    .replace(/\s*\.{4,}\s*/g, " … ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** docling's Markdown with the pages it missed added at the end; the text layer alone when there's no Markdown. */
export function withMissedPages(markdown: string | undefined, pages: string[]) {
  const missed = markdown === undefined ? pages.flatMap((t, i) => (t.trim() ? [[i + 1, t] as [number, string]] : [])) : missedPages(markdown, pages);
  if (!missed.length) return markdown;
  const added = missed.map(([n, text]) => `## Page ${n}\n\n${tidy(text)}`).join("\n\n");
  return markdown ? `${markdown.trimEnd()}\n\n${added}` : added;
}
