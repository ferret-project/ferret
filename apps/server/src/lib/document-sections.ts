/**
 * The part of a document that answers a question, whole: for "how do I descale it?" the manual's whole "11 Descaling"
 * section — every numbered step under it, its sub-sections ("11.1 Preparing", "11.2 Running the cycle") and the
 * warnings in it — rather than a fixed-size piece that may stop at step 4 or leave the caution out.
 *
 * A document's text is docling's Markdown. Its structure comes from two places, since docling often writes every
 * heading at the same level: the Markdown level, and a heading's own numbering ("11", "11.2", "11.2.3"). Headings that
 * are only a notice ("WARNING", "Caution", "Note") are not sections: they stay in the text of the section they're in.
 * A scan with no headings is read as lines, and a run of numbered steps is kept together.
 */
import { matches, searchTerms, stem } from "./item-search";

export interface DocSection {
  /** The section's heading, with the chapter it's in when that names it better ("11 Descaling › 11.2 Running the cycle"); none for a headingless scan. */
  title?: string;
  /** Its text, sub-sections and notices included. */
  text: string;
  /** True when it was longer than allowed and the rest was left out (the text then says so). */
  cut: boolean;
  /** The start of its body: the document viewer opens at the page with this (data-near). */
  near: string;
  /** How well it matches the question: comparable between sections of one item's documents. */
  score: number;
}

/** "How do I …", "steps to …": an answer that is a procedure — the reply then lists every step. */
const PROCEDURE =
  /\b(how (do|can|should|would|to)|how['’]?s|steps?|instructions?|procedure|guide|walk me through|what do i do|reset|descal\w*|clean\w*|replac\w*|install\w*|set ?up|pair\w*|program\w*|troubleshoot\w*|calibrat\w*|maintain\w*|assembl\w*|disassembl\w*|empty\w*|drain\w*|defrost\w*|winteri[sz]\w*|unclog\w*|fix\w*|change|remov\w*|refill\w*)\b/i;
export const isProcedureQuestion = (question: string) => PROCEDURE.test(question);

/** The question's own words that say what it's about, as typed ("descale"), not how it's asked or the thing's name: for marking in the document. */
export function questionWords(question: string, ignore = "") {
  const named = new Set(searchTerms(ignore));
  const terms = new Set(searchTerms(question).filter((t) => !named.has(t)));
  return [...new Set([...question.matchAll(WORD)].map((m) => m[0]).filter((w) => terms.has(stem(w))))].join(" ");
}

/** Headings that are a notice, not a section. */
const NOTICE = /^\W*(warning|caution|danger|important|note|notice|attention|tip|hint|safety (note|warning))s?\b/i;
/** A numbered heading: "11", "11.2", "11.2.3 …" (not a year or a model number: at most two digits a part). */
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+\S/;
/** A step: "1.", "2)", "(3)", "Step 4", "a)", or a bulleted one. */
const STEP = /^\s*(?:[-*•]\s*)?(?:\(?\d{1,2}[.)](?!\d)|step\s+\d{1,2}\b|\(?[a-h]\)\s)/i;
/** A table of contents line (dot leaders). */
const LEADERS = /\.{6,}|…{3,}/;
const WORD = /[\p{L}\p{N}]+/gu;

interface Heading {
  title: string;
  level: number;
  /** The line it's on, and where its own text and its sub-sections end. */
  line: number;
  ownEnd: number;
  end: number;
  parent?: number;
}

const clean = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/** The headings of a document, with their levels worked out. */
function headings(lines: string[]): Heading[] {
  const raw: { title: string; md: number; line: number }[] = [];
  lines.forEach((line, i) => {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) return;
    const title = clean(h[2]!);
    if (!title || NOTICE.test(title)) return;
    raw.push({ title, md: h[1]!.length, line: i });
  });
  if (!raw.length) return [];
  const minMd = Math.min(...raw.map((h) => h.md));
  const numbered = raw.filter((h) => NUMBERED.test(h.title)).length >= 3;
  let depth = 0; // of the last numbered heading
  const out: Heading[] = raw.map((h) => {
    const n = numbered ? NUMBERED.exec(h.title) : null;
    let level: number;
    if (n) level = depth = n[1]!.split(".").length;
    // In a numbered manual an unnumbered heading belongs to the numbered section it's in ("Descaling" under "11").
    else if (numbered) level = depth ? depth + 1 : 1;
    else level = h.md - minMd + 1;
    return { title: h.title, level, line: h.line, ownEnd: lines.length, end: lines.length };
  });
  for (let i = 0; i < out.length; i++) {
    const h = out[i]!;
    h.ownEnd = out[i + 1]?.line ?? lines.length;
    const next = out.findIndex((o, j) => j > i && o.level <= h.level);
    h.end = next < 0 ? lines.length : out[next]!.line;
    for (let j = i - 1; j >= 0; j--) {
      if (out[j]!.level < h.level) {
        h.parent = j;
        break;
      }
    }
  }
  return out;
}

const wordsOf = (text: string) => [...text.matchAll(WORD)].map((m) => m[0]);

/**
 * How informative each term is in this document: a word that's in nearly every part ("De'Longhi" in its own manual)
 * says little about which part answers.
 */
function weights(terms: string[], parts: string[][]) {
  const n = parts.length || 1;
  return new Map(terms.map((t) => [t, Math.log(1 + n / (1 + parts.filter((words) => words.some((w) => matches(w, t))).length))]));
}

function score(headingWords: string[], bodyWords: string[], terms: string[], w: Map<string, number>) {
  let s = 0;
  for (const t of terms) {
    if (headingWords.some((x) => matches(x, t))) s += 3 * w.get(t)!;
    const count = bodyWords.filter((x) => matches(x, t)).length;
    if (count) s += w.get(t)! * Math.min(1, count / 2);
  }
  return s;
}

const stepCount = (lines: string[]) => lines.filter((l) => STEP.test(l)).length;

/** Text cut to `max` at a paragraph or line break, saying the rest is in the document. */
function fit(text: string, max: number) {
  if (text.length <= max) return { text, cut: false };
  const room = Math.max(200, max - 90);
  const at = Math.max(text.lastIndexOf("\n\n", room), text.lastIndexOf("\n", room));
  return { text: `${text.slice(0, at > room / 2 ? at : room).trimEnd()}\n[…the section goes on in the document; the rest wasn't read]`, cut: true };
}

const tidy = (lines: string[]) =>
  lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const nearOf = (body: string) => body.replace(/^#+\s.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 240);

/**
 * The sections of one document that best answer the question, best first, each whole up to `maxChars` (the first) and
 * `restChars` (the others), never overlapping. Empty when nothing in it has the question's words.
 */
export function bestSections(
  markdown: string,
  question: string,
  /** `ignore`: words that name the thing itself (its name, brand, model) — every part of its own manual is about it. */
  opts: { maxChars: number; restChars?: number; count?: number; ignore?: string },
): DocSection[] {
  const named = new Set(searchTerms(opts.ignore ?? ""));
  const asked = searchTerms(question);
  const terms = asked.filter((t) => !named.has(t));
  if (asked.length && !terms.length) terms.push(...asked); // "Brava?" alone: nothing else to go on
  if (!terms.length || !markdown.trim()) return [];
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const hs = headings(lines);
  const procedure = isProcedureQuestion(question);
  const count = opts.count ?? 1;
  const restChars = opts.restChars ?? opts.maxChars;
  return hs.length >= 2 ? headed(lines, hs, terms, procedure, count, opts.maxChars, restChars) : headingless(lines, terms, procedure, opts.maxChars);
}

function headed(lines: string[], hs: Heading[], terms: string[], procedure: boolean, count: number, maxChars: number, restChars: number): DocSection[] {
  const own = hs.map((h) => ({ heading: wordsOf(h.title), body: wordsOf(lines.slice(h.line + 1, h.ownEnd).join("\n")) }));
  const w = weights(terms, own.map((o) => [...o.heading, ...o.body]));
  const top = Math.max(...w.values());
  const scored = hs
    .map((h, i) => {
      const body = lines.slice(h.line + 1, h.ownEnd);
      if (/contents/i.test(h.title) || body.filter((l) => LEADERS.test(l)).length >= 3) return { i, s: 0 };
      // A heading with nothing under it (a title page's): nothing to read.
      if (h.end === h.ownEnd && body.join("").trim().length < 20) return { i, s: 0 };
      let s = score(own[i]!.heading, own[i]!.body, terms, w);
      // For a how-to question, a section that is a list of steps beats one that only mentions the words.
      if (s > 0 && procedure && stepCount(lines.slice(h.line + 1, h.end)) >= 2) s += top / 2;
      return { i, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);

  const taken: [number, number][] = [];
  const out: DocSection[] = [];
  for (const { i, s } of scored) {
    if (out.length >= count) break;
    const max = out.length ? restChars : maxChars;
    // Take the chapter rather than one part of it when the chapter's own heading names it as well, and it fits:
    // "11.2 Running the cycle" → "11 Descaling" with its preparation and rinse.
    let pick = i;
    const headingScore = (j: number) => score(own[j]!.heading, [], terms, w);
    while (hs[pick]!.parent != null) {
      const p = hs[pick]!.parent!;
      const size = lines.slice(hs[p]!.line, hs[p]!.end).join("\n").length;
      if (headingScore(p) < headingScore(pick) || headingScore(p) === 0 || size > max) break;
      pick = p;
    }
    const h = hs[pick]!;
    if (taken.some(([a, b]) => h.line < b && a < h.end)) continue;
    taken.push([h.line, h.end]);
    const parent = h.parent != null ? hs[h.parent] : undefined;
    // "11.2 Running the cycle" is clearer with its chapter; a top-level heading stands alone.
    const title = parent && !NUMBERED.test(h.title) ? `${parent.title} › ${h.title}` : h.title;
    const body = tidy(lines.slice(h.line + 1, h.end));
    const { text, cut } = fit(`${h.title}\n${body}`, max);
    out.push({ title, text, cut, near: nearOf(body), score: s });
  }
  return out;
}

/** A scan without headings: the best line, and the run of numbered steps it's in (with a line or two leading in). */
function headingless(all: string[], terms: string[], procedure: boolean, maxChars: number): DocSection[] {
  const lines = all.map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const words = lines.map(wordsOf);
  const w = weights(terms, words);
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    if (LEADERS.test(line)) return;
    // A line and the two after it: an instruction's words are often on the line before its steps.
    let s = score([], [...words[i]!, ...(words[i + 1] ?? []), ...(words[i + 2] ?? [])], terms, w) + score([], words[i]!, terms, w);
    if (s > 0 && procedure && lines.slice(i, i + 4).some((l) => STEP.test(l))) s *= 1.5;
    if (s > bestScore) [best, bestScore] = [i, s];
  });
  if (best < 0) return [];
  const isStep = (i: number) => i >= 0 && i < lines.length && STEP.test(lines[i]!);
  const stepSoon = (i: number, ahead: number) => Array.from({ length: ahead }, (_, k) => i + 1 + k).some(isStep);
  let start = best;
  let end = best + 1;
  if (isStep(best) || stepSoon(best, 3)) {
    // Back to the first step of the run (short lines between steps are part of it), then a line or two leading in.
    while (start > 0 && (isStep(start - 1) || (lines[start - 1]!.length < 200 && isStep(start - 2)))) start--;
    start = Math.max(0, start - (isStep(start) ? 2 : 0));
    // On while steps keep coming: three lines without one end it.
    end = start + 1;
    while (end < lines.length && (isStep(end) || stepSoon(end - 1, 3))) end++;
  } else {
    // No steps: the lines around it.
    while (start > 0 && best - start < 3) start--;
    while (end < lines.length && lines.slice(start, end).join("\n").length < 1200) end++;
  }
  const body = lines.slice(start, end).join("\n");
  const { text, cut } = fit(body, maxChars);
  return [{ text, cut, near: nearOf(body), score: bestScore }];
}
