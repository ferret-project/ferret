/**
 * Reminders to other apps (ntfy, Pushover, Telegram, email…): each person adds
 * Apprise URLs in Settings, kept sealed with the household key because they
 * hold tokens, and the daily reminder job sends to them through deps.notifier.
 */
import type { NotificationChannel, NotificationChannelInput } from "@ferret/shared";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { notificationChannel, pushSubscription } from "../db/schema";
import type { Db, Deps, Notifier } from "../ports";
import type { FileStore } from "./files";

/** Enough for a phone, a family channel and email, without letting a list grow unchecked. */
const MAX_CHANNELS = 10;

type Owner = { db: Db; files: FileStore; householdId: string; userId: string };
type Row = typeof notificationChannel.$inferSelect;

const sealLabel = (userId: string) => `notify:${userId}`;

/** Ferret's own mail sender (MAIL_URL, an Apprise mailto URL), addressed to one person (Apprise's `to=`). */
export const mailTo = (mailUrl: string, email: string) => `${mailUrl}${mailUrl.includes("?") ? "&" : "?"}to=${encodeURIComponent(email)}`;

const summary = (row: Row): NotificationChannel => ({
  id: row.id,
  name: row.name,
  service: row.service,
  createdAt: row.createdAt.toISOString(),
  lastNotifiedOn: row.lastNotifiedOn,
  lastError: row.lastError,
});

const mine = (o: Owner) => and(eq(notificationChannel.householdId, o.householdId), eq(notificationChannel.userId, o.userId));

export async function listChannels(o: Owner) {
  const rows = await o.db.select().from(notificationChannel).where(mine(o)).orderBy(notificationChannel.createdAt);
  return rows.map(summary);
}

export async function addChannel(o: Owner, input: NotificationChannelInput) {
  if ((await listChannels(o)).length >= MAX_CHANNELS) {
    throw new HTTPException(409, { message: `You can have up to ${MAX_CHANNELS} — remove one first` });
  }
  const [row] = await o.db
    .insert(notificationChannel)
    .values({
      householdId: o.householdId,
      userId: o.userId,
      name: input.name,
      service: input.url.slice(0, input.url.indexOf("://")).toLowerCase(),
      urlSealed: await o.files.seal(o.householdId, sealLabel(o.userId), input.url),
    })
    .returning();
  return summary(row!);
}

export async function removeChannel(o: Owner, id: string) {
  const gone = await o.db
    .delete(notificationChannel)
    .where(and(mine(o), eq(notificationChannel.id, id)))
    .returning({ id: notificationChannel.id });
  if (!gone.length) throw new HTTPException(404, { message: "No such notification" });
}

/**
 * Sends to one channel and records how it went (lastError). Returns the error
 * message, or null when it was delivered.
 */
export async function deliver(db: Db, files: FileStore, notifier: Notifier, row: Row, message: { title: string; body: string }) {
  let error: string | null = null;
  try {
    const url = await files.open(row.householdId, sealLabel(row.userId), row.urlSealed);
    await notifier.send(url, message);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (error !== row.lastError) await db.update(notificationChannel).set({ lastError: error }).where(eq(notificationChannel.id, row.id));
  return error;
}

/** A test message to one of this person's channels; 502 with the reason if it didn't go. */
export async function testChannel(o: Owner, notifier: Notifier, id: string, appUrl: string) {
  const [row] = await o.db.select().from(notificationChannel).where(and(mine(o), eq(notificationChannel.id, id)));
  if (!row) throw new HTTPException(404, { message: "No such notification" });
  const error = await deliver(o.db, o.files, notifier, row, {
    title: "Ferret reminders are on",
    body: `You'll hear from Ferret here when maintenance is due or a warranty is about to end.\n\n${appUrl}/#/`,
  });
  if (error) throw new HTTPException(502, { message: error });
}

/**
 * One message to one person, wherever they hear from Ferret: every device with push, every Apprise channel they
 * added (in any household), and — with `email` and Ferret's own mail sender — their account's address.
 */
export async function notifyPerson(
  deps: Pick<Deps, "db" | "push" | "notifier"> & { files: FileStore; mailUrl?: string },
  userId: string,
  message: { title: string; body: string; url: string; tag: string },
  /** `details`: more, for the email only (a service error's triage notes) — too long for a push or a chat app. */
  opts: { email?: string | null; details?: string } = {},
) {
  const { db, push, notifier, files } = deps;
  if (push) {
    for (const sub of await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))) {
      const sent = await push.send(sub, { title: message.title, body: message.body, url: message.url, tag: message.tag }).catch(() => "failed" as const);
      if (sent === "gone") await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
    }
  }
  if (notifier) {
    for (const channel of await db.select().from(notificationChannel).where(eq(notificationChannel.userId, userId))) {
      await deliver(db, files, notifier, channel, { title: message.title, body: `${message.body}\n\n${message.url}` });
    }
    if (opts.email && deps.mailUrl) {
      const details = opts.details ? `\n\n${opts.details}` : "";
      await notifier.send(mailTo(deps.mailUrl, opts.email), { title: message.title, body: `${message.body}\n\n${message.url}${details}` }).catch(() => {});
    }
  }
}
