/**
 * Ferret's own emails (MAIL_URL): one layout for all of them — a heading, a few paragraphs, at most one button for the
 * thing to do (with its link written out too, for copying), lists (the weekly summary), and a quiet footnote. Rendered
 * as HTML and as plain text from the same parts.
 *
 * The HTML is what email apps can show: tables, inline styles in the theme's colours, a dark version for apps that
 * honour `prefers-color-scheme`, no images (a home server's pictures wouldn't load outside the house, and many apps
 * block them anyway). Apprise writes the plain-text part itself from the HTML, so every link is visible text, never
 * only behind a button. Text from people (names, households, things) is escaped.
 */

export interface EmailItem {
  text: string;
  detail?: string;
  urgent?: boolean;
}

export interface EmailContent {
  /** The subject line. */
  subject: string;
  /** The big line at the top; the subject if left out. */
  heading?: string;
  /** "Hi Sam," */
  greeting?: string;
  paragraphs: string[];
  /** The one thing to do: a button, its link written out under it, and how long it works. */
  action?: { label: string; url: string; note?: string };
  /** Lists under headings, after the button (the weekly summary). */
  sections?: { heading: string; items: EmailItem[] }[];
  /** Small print at the end: "If you didn't ask for this, ignore it." */
  footnote?: string;
  /** Preformatted notes (a service error's triage), in a box. */
  details?: string;
  /** Ferret's address, for the footer; else the action's. */
  appUrl?: string;
}

export interface RenderedEmail {
  title: string;
  body: string;
  html: string;
}

/** The theme's colours (apps/web/src/index.css), as hex — email apps don't know oklch. */
const LIGHT = { page: "#f6efe6", card: "#fdf9f4", line: "#e7dcd0", text: "#35251b", muted: "#6b5d53", accent: "#874c30", onAccent: "#fdf8f1", urgent: "#af2b25", code: "#f6efe6" };
const DARK = { page: "#191410", card: "#28211c", line: "#3d332d", text: "#ede7de", muted: "#b9b1a8", accent: "#d59466", onAccent: "#23140b", urgent: "#f17264", code: "#191410" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Escaped, with web addresses made links and line breaks kept. */
function inline(s: string) {
  return escape(s)
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" style="color:${LIGHT.accent}">${url}</a>`)
    .replace(/\n/g, "<br>");
}

function hostOf(url: string | undefined) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function renderEmail(c: EmailContent): RenderedEmail {
  const heading = c.heading ?? c.subject;
  const appUrl = c.appUrl ?? (c.action ? new URL(c.action.url).origin : undefined);
  const host = hostOf(appUrl);
  return { title: c.subject, body: renderText(c, appUrl, host), html: renderHtml(c, heading, appUrl, host) };
}

function renderText(c: EmailContent, appUrl: string | undefined, host: string | null) {
  const parts: string[] = [];
  if (c.greeting) parts.push(c.greeting);
  parts.push(...c.paragraphs);
  if (c.action) parts.push(`${c.action.label}:\n${c.action.url}${c.action.note ? `\n${c.action.note}` : ""}`);
  for (const s of c.sections ?? []) {
    parts.push(`${s.heading}\n${s.items.map((i) => `• ${i.text}${i.detail ? ` — ${i.detail}` : ""}${i.urgent ? " (urgent)" : ""}`).join("\n")}`);
  }
  if (c.details) parts.push(c.details);
  if (c.footnote) parts.push(c.footnote);
  if (host) parts.push(`— Ferret · ${appUrl}`);
  return parts.join("\n\n");
}

function renderHtml(c: EmailContent, heading: string, appUrl: string | undefined, host: string | null) {
  const L = LIGHT;
  const p = (html: string, extra = "") => `<p class="t" style="margin:0 0 16px;font-size:16px;line-height:1.55;color:${L.text};${extra}">${html}</p>`;
  const muted = (html: string, extra = "") => `<p class="m" style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${L.muted};${extra}">${html}</p>`;
  const body: string[] = [];
  body.push(`<h1 class="t" style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:650;color:${L.text}">${escape(heading)}</h1>`);
  if (c.greeting) body.push(p(escape(c.greeting)));
  for (const para of c.paragraphs) body.push(p(inline(para)));
  if (c.action) {
    const url = escape(c.action.url);
    body.push(
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px"><tr>` +
        `<td class="b" bgcolor="${L.accent}" style="border-radius:10px;background:${L.accent}">` +
        `<a class="bl" href="${url}" style="display:inline-block;padding:13px 22px;font-size:16px;font-weight:600;line-height:1.2;color:${L.onAccent};text-decoration:none;border-radius:10px">${escape(c.action.label)}</a>` +
        `</td></tr></table>`,
    );
    if (c.action.note) body.push(muted(escape(c.action.note)));
    body.push(muted(`Or copy this link: <a href="${url}" style="color:${L.accent};word-break:break-all">${url}</a>`, "margin-bottom:20px"));
  }
  for (const s of c.sections ?? []) {
    body.push(`<h2 class="t" style="margin:24px 0 8px;font-size:15px;line-height:1.4;font-weight:650;color:${L.text}">${escape(s.heading)}</h2>`);
    body.push(
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 8px">` +
        s.items
          .map(
            (i) =>
              `<tr><td class="ln" style="padding:9px 0;border-top:1px solid ${L.line};font-size:15px;line-height:1.45;color:${L.text}">` +
              `<span class="t" style="color:${L.text}">${escape(i.text)}</span>` +
              (i.urgent ? ` <span class="u" style="font-size:13px;font-weight:600;color:${L.urgent}">· Urgent</span>` : "") +
              (i.detail ? `<br><span class="m" style="font-size:13px;color:${L.muted}">${escape(i.detail)}</span>` : "") +
              `</td></tr>`,
          )
          .join("") +
        `</table>`,
    );
  }
  if (c.details) {
    body.push(
      `<pre class="pre" style="margin:8px 0 16px;padding:12px;border-radius:8px;background:${L.code};border:1px solid ${L.line};font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${L.text};white-space:pre-wrap;word-break:break-word">${escape(c.details)}</pre>`,
    );
  }
  if (c.footnote) body.push(muted(inline(c.footnote), "margin:20px 0 0"));

  const D = DARK;
  const style =
    `@media (prefers-color-scheme: dark){` +
    `.pg{background:${D.page}!important}.cd{background:${D.card}!important;border-color:${D.line}!important}` +
    `.t{color:${D.text}!important}.m{color:${D.muted}!important}.u{color:${D.urgent}!important}.ln{border-color:${D.line}!important}` +
    `.br,a{color:${D.accent}!important}.b{background:${D.accent}!important}a.bl{color:${D.onAccent}!important}` +
    `.pre{background:${D.code}!important;border-color:${D.line}!important;color:${D.text}!important}}` +
    `@media (max-width:480px){.cd{padding:22px 18px!important}}`;
  // What an inbox shows beside the subject: the first paragraph.
  const preview = c.paragraphs[0];
  const footer = host
    ? `<a href="${escape(appUrl!)}" style="color:${L.muted};text-decoration:underline" class="m">${escape(host)}</a>`
    : "";

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${escape(c.subject)}</title><style>${style}</style></head>` +
    `<body class="pg" style="margin:0;padding:0;background:${L.page};font-family:${FONT}">` +
    (preview ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(preview)}</div>` : "") +
    `<table role="presentation" class="pg" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${L.page}" style="background:${L.page}"><tr><td align="center" style="padding:28px 12px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;font-family:${FONT}">` +
    `<tr><td class="br" style="padding:0 4px 14px;font-size:19px;font-weight:700;letter-spacing:-0.01em;color:${L.accent}">Ferret</td></tr>` +
    `<tr><td class="cd" bgcolor="${L.card}" style="background:${L.card};border:1px solid ${L.line};border-radius:14px;padding:30px 28px">${body.join("")}</td></tr>` +
    (footer ? `<tr><td class="m" style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:${L.muted}">Sent by Ferret at ${footer}</td></tr>` : "") +
    `</table></td></tr></table></body></html>`
  );
}
