/**
 * Private calendar feeds of due maintenance (iCalendar / webcal), so reminders
 * show up in Apple Calendar or Google Calendar with an alert on the day. A feed
 * belongs to one person in one household; the link carries a random token and
 * only its SHA-256 is stored.
 */
import { describeInterval, type MaintenanceTask, today } from "@ferret/shared";
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

/** iCalendar text: escape \ ; , and newlines. */
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

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

/**
 * One all-day event per open task, on its due date — overdue ones on today, so
 * they don't hide in the past — with an alert at 9:00 that morning.
 */
export function toICalendar(tasks: MaintenanceTask[], opts: { name: string; appUrl: string; timeZone: string; now?: Date }) {
  const on = today(opts.now, opts.timeZone);
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
    const day = t.dueOn < on ? on : t.dueOn;
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const what = t.itemName ? `${t.title} (${t.itemName})` : t.title;
    const details = [
      t.status === "overdue" ? `Overdue — was due ${t.dueOn}.` : null,
      `Repeats ${describeInterval(t.intervalCount, t.intervalUnit)}.`,
      t.place ? `Where: ${t.place}` : null,
      t.lastDoneOn ? `Last done ${t.lastDoneOn}.` : null,
      t.notes,
      `Mark it done in Ferret: ${opts.appUrl}/#/maintenance`,
    ].filter(Boolean);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@ferret`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(day)}`,
      `DTEND;VALUE=DATE:${compactDate(next.toISOString().slice(0, 10))}`,
      `SUMMARY:${escape(t.status === "overdue" ? `Overdue: ${what}` : what)}`,
      `DESCRIPTION:${escape(details.join("\n"))}`,
      ...(t.place ? [`LOCATION:${escape(t.place)}`] : []),
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escape(what)}`,
      "TRIGGER:PT9H",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
