/**
 * Searching inside one item: the passages of its own text that have the words — its documents (split at their headings,
 * so a manual answers with "8.2 Cleaning and bag inspection"), what its photos say, its warranties, its description and
 * notes. One item's text is small (a manual is tens of KB), so it's read whole and matched here: every word, loosely
 * (endings: "filters" finds "filter", "clean" finds "cleaning"; and the start of a longer word while typing).
 */
import type { ItemFindResult, ItemPassage } from "@ferret/shared";
import type { SearchDoc } from "./search-text";

/** A passage is cut near this long, at a paragraph break when there is one. */
const PASSAGE_CHARS = 900;
/** The window shown around the first match. */
const SNIPPET_BEFORE = 90;
const SNIPPET_CHARS = 280;
const MAX_PASSAGES = 30;

const WORD = /[\p{L}\p{N}]+/gu;
/** Left out of a search of several words ("how do I clean the filter" → clean, filter) — unless nothing else is left. */
const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its my of on or should the this to was what when where which who why will with you your".split(" "),
);

/** A word with its common English endings taken off, so forms of it match each other. */
export function stem(word: string) {
  const w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** The words searched for, as stems. */
export function searchTerms(query: string) {
  const words = [...query.matchAll(WORD)].map((m) => m[0].toLowerCase());
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  return [...new Set((kept.length ? kept : words).map(stem))];
}

function matches(word: string, term: string) {
  const lower = word.toLowerCase();
  const s = stem(lower);
  return s === term || (term.length >= 3 && (lower.startsWith(term) || s.startsWith(term)));
}

interface Raw {
  source: ItemPassage["source"];
  label: string;
  heading?: string;
  attachmentId?: string;
  warrantyId?: string;
  text: string;
}

/** Cuts text into passages of about PASSAGE_CHARS, at paragraph breaks. */
function chunks(text: string) {
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (current && current.length + p.length > PASSAGE_CHARS) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${p}` : p;
    while (current.length > PASSAGE_CHARS * 2) {
      // One very long paragraph (a table): cut at the last line break or space before the limit.
      const cut = Math.max(current.lastIndexOf("\n", PASSAGE_CHARS), current.lastIndexOf(" ", PASSAGE_CHARS), PASSAGE_CHARS / 2);
      out.push(current.slice(0, cut).trim());
      current = current.slice(cut).trim();
    }
  }
  if (current) out.push(current);
  return out;
}

/** A document's text (docling's Markdown) as sections under their headings, each cut into passages. */
function sections(markdown: string) {
  const out: { heading?: string; text: string }[] = [];
  let heading: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    for (const text of chunks(lines.join("\n"))) out.push({ heading, text });
    lines = [];
  };
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      heading = h[1];
    } else {
      lines.push(line);
    }
  }
  flush();
  return out;
}

/** Everything of the item's own that can be searched, as passages. */
export function itemPassages(doc: SearchDoc): Raw[] {
  const out: Raw[] = [];
  const it = doc.item;
  if (it.description) for (const text of chunks(it.description)) out.push({ source: "item", label: "Description", text });
  if (it.notes) for (const text of chunks(it.notes)) out.push({ source: "item", label: "Notes", text });
  for (const w of doc.warranties) {
    const text = [`${w.startsOn ? `${w.startsOn} to ` : "Until "}${w.endsOn}`, w.coverage, w.notes].filter(Boolean).join("\n\n");
    out.push({ source: "warranty", label: w.provider || "Warranty", warrantyId: w.id, text });
  }
  for (const f of doc.files) {
    const a = f.analysisStatus === "done" ? f.analysis : null;
    if (!a) continue;
    if (f.kind === "document") {
      for (const s of sections(a.text || a.description)) out.push({ source: "document", label: f.filename, attachmentId: f.id, ...s });
    } else {
      const text = [a.description, a.text].filter(Boolean).join("\n\n");
      for (const t of chunks(text)) out.push({ source: "photo", label: f.filename, attachmentId: f.id, text: t });
    }
  }
  return out;
}

/** Where each of the terms appears in `text`: [start, end) of each matching word. */
function marksIn(text: string, terms: string[]) {
  const marks: [number, number][] = [];
  for (const m of text.matchAll(WORD)) {
    if (terms.some((t) => matches(m[0], t))) marks.push([m.index, m.index + m[0].length]);
  }
  return marks;
}

function snippetOf(text: string, firstMatch: number, terms: string[]) {
  let start = Math.max(0, firstMatch - SNIPPET_BEFORE);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start; // not mid-word
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  if (end < text.length) end = text.lastIndexOf(" ", end) > start ? text.lastIndexOf(" ", end) : end;
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  const snippet = `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
  return { snippet, marks: marksIn(snippet, terms) };
}

/** A manual's table of contents (lines of dot leaders): it has every word, and answers nothing — listed last. */
const isContents = (p: Raw) => /contents/i.test(p.heading ?? "") || (p.text.match(/\.{6,}/g)?.length ?? 0) >= 3;

/** The passages of one item that have the words, best first: every word before some; not a table of contents; a heading match; then how densely. */
export function findInItem(doc: SearchDoc, query: string, limit = MAX_PASSAGES): ItemFindResult {
  const terms = searchTerms(query);
  if (!terms.length) return { passages: [], total: 0 };
  const scored = itemPassages(doc)
    .map((p, order) => {
      const words = [...p.text.matchAll(WORD)];
      const found = new Set<string>();
      let count = 0;
      let first = -1;
      for (const w of words) {
        const hit = terms.filter((t) => matches(w[0], t));
        if (!hit.length) continue;
        hit.forEach((t) => found.add(t));
        count++;
        if (first < 0) first = w.index;
      }
      const inHeading = p.heading ? terms.filter((t) => [...p.heading!.matchAll(WORD)].some((w) => matches(w[0], t))) : [];
      inHeading.forEach((t) => found.add(t));
      // How dense the matches are: a short section about it beats a long one that mentions it in passing.
      const density = count / Math.sqrt(Math.max(words.length, 20));
      return { p, order, found: found.size, inHeading: inHeading.length, density, contents: isContents(p), first };
    })
    .filter((s) => s.found > 0);
  // Several words: passages with all of them, if any have; else the ones with most.
  const best = Math.max(0, ...scored.map((s) => s.found));
  const kept = scored
    .filter((s) => s.found === best)
    .sort((a, b) => Number(a.contents) - Number(b.contents) || b.inHeading - a.inHeading || b.density - a.density || a.order - b.order);
  return {
    total: kept.length,
    passages: kept.slice(0, limit).map(({ p, first }) => ({
      source: p.source,
      label: p.label,
      ...(p.heading ? { heading: p.heading } : {}),
      ...(p.attachmentId ? { attachmentId: p.attachmentId } : {}),
      ...(p.warrantyId ? { warrantyId: p.warrantyId } : {}),
      ...snippetOf(p.text, Math.max(0, first), terms),
      text: p.text,
    })),
  };
}
