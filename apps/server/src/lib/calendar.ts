import { currentLanguage } from "./i18n";
import { t as translateText } from "./i18n";
/**
 * Private calendar feeds of due maintenance (iCalendar / webcal), so reminders
 * show up in Apple Calendar or Google Calendar with an alert on the day. A feed
 * belongs to one person in one household; the link carries a random token and
 * only its SHA-256 is stored.
 */
import { MAINTENANCE_AHEAD_MONTHS, addDays, addMonths, describeInterval, type MaintenanceTask, taskOccurrences, today } from "@ferret/shared";
import { and, eq } from "drizzle-orm";
import { calendarFeed } from "../db/schema";
import type { Db } from "../ports";
import type { FileStore } from "./files";

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new feed for this person and household, replacing their old one. Returns the token. */
export async function createFeed(db: Db, files: FileStore, householdId: string, userId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.delete(calendarFeed).where(and(eq(calendarFeed.householdId, householdId), eq(calendarFeed.userId, userId)));
  await db.insert(calendarFeed).values({
    householdId,
    userId,
    tokenHash: await hashToken(token),
    tokenSealed: await files.seal(householdId, sealLabel(userId), token),
  });
  return token;
}

/** This person's feed token, if they have one that was kept (older feeds weren't). */
export async function feedToken(db: Db, files: FileStore, householdId: string, userId: string) {
  const [feed] = await db
    .select()
    .from(calendarFeed)
    .where(and(eq(calendarFeed.householdId, householdId), eq(calendarFeed.userId, userId)));
  if (!feed) return undefined;
  return { createdAt: feed.createdAt, token: feed.tokenSealed ? await files.open(householdId, sealLabel(userId), feed.tokenSealed) : null };
}

const sealLabel = (userId: string) => `calendar-feed/${userId}`;

export async function findFeed(db: Db, token: string) {
  const [feed] = await db.select().from(calendarFeed).where(eq(calendarFeed.tokenHash, await hashToken(token)));
  return feed;
}

/** iCalendar text: escape \ ; , and line breaks (any kind); other control characters go. */
const escape = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, "\\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/** Lines longer than 75 octets are folded (continuation lines start with a space). */
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    if (new TextEncoder().encode(current + ch).length > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
    }
    current += ch;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const compactDate = (iso: string) => iso.replace(/-/g, "");

/** How far ahead the feed lists a task's repeats, and at most how many of each. */
export const FEED_MONTHS = MAINTENANCE_AHEAD_MONTHS;
export const FEED_REPEATS = 52;

/**
 * One all-day event per open task on its due date — overdue ones on today, so they don't hide in the past — with an
 * alert at 9:00 that morning; then its repeats for the next year (`taskOccurrences`, as the app's Month view shows
 * them), marked expected and without an alert: each becomes the real one once the one before is done, and if it
 * isn't, the overdue event is already alerting.
 */
export function toICalendar(tasks: MaintenanceTask[], opts: { name: string; appUrl: string; timeZone: string; now?: Date }) {
  const on = today(opts.now, opts.timeZone);
  const until = addDays(addMonths(on, FEED_MONTHS), -1);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ferret//Maintenance//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(opts.name)}`,
    "X-PUBLISHED-TTL:PT6H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
  ];
  for (const t of tasks) {
    if (!t.dueOn) continue;
    const what = t.itemName ? `${t.title} (${t.itemName})` : t.title;
    const about = [
      translateText("Repeats {v0}.", { v0: describeInterval(t.intervalCount, t.intervalUnit, currentLanguage()) }),
      t.place ? translateText("Where: {v0}", { v0: t.place }) : null,
      t.lastDoneOn ? translateText("Last done {v0}.", { v0: t.lastDoneOn }) : null,
      t.notes,
      translateText("Mark it done in Ferret: {v0}/#/maintenance", { v0: opts.appUrl }),
    ];
    // The real one always, however far off; repeats only within the year.
    const occurrences = taskOccurrences(t, on, t.dueOn > until ? t.dueOn : until, on);
    let repeats = 0;
    for (const o of occurrences) {
      const expected = o.kind === "expected";
      if (expected && (o.on > until || ++repeats > FEED_REPEATS)) break;
      const next = addDays(o.on, 1);
      const details = [
        o.kind === "overdue" ? translateText("Overdue — was due {v0}.", { v0: t.dueOn }) : null,
        expected ? translateText("Expected, if the one before is done on time — it moves when that one's done.") : null,
        t.part?.shortOn && o.on >= t.part.shortOn ? translateText("Not enough {v0} left by then — buy more.", { v0: t.part.name }) : null,
        ...about,
      ].filter(Boolean);
      const summary = o.kind === "overdue" ? translateText("Overdue: {v0}", { v0: what }) : expected ? translateText("{v0} (expected)", { v0: what }) : what;
      lines.push(
        "BEGIN:VEVENT",
        // The real one keeps the task's own id, so calendars that already have it update it in place.
        `UID:${expected ? `${t.id}-${compactDate(o.on)}` : t.id}@ferret`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${compactDate(o.on)}`,
        `DTEND;VALUE=DATE:${compactDate(next)}`,
        `SUMMARY:${escape(summary)}`,
        `DESCRIPTION:${escape(details.join("\n"))}`,
        ...(t.place ? [`LOCATION:${escape(t.place)}`] : []),
        "TRANSP:TRANSPARENT",
        ...(expected ? [] : ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escape(what)}`, "TRIGGER:PT9H", "END:VALARM"]),
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
