/**
 * Daily reminders: once a day (from REMIND_HOUR), each person gets one message
 * listing what's urgent in their household — maintenance overdue or due today,
 * warranties ending within a week, things that have run out (the bell's
 * "urgent" entries) — on every
 * device subscribed to Web Push and every Apprise channel they added. Nothing
 * when nothing is urgent. Subscriptions the browser has dropped are forgotten;
 * a channel that fails keeps its error for Settings and is tried again next hour.
 * The same tick sends lending reminders to borrowers (lib/loans.ts) and the weekly summaries (lib/digest.ts).
 */
import { type AttentionItem, localParts, today } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { notificationChannel, pushSubscription } from "../db/schema";
import { needsAttention } from "../lib/attention";
import { membership } from "../lib/context";
import type { FileStore } from "../lib/files";
import { sendLoanReminders } from "../lib/loans";
import { sendWeeklyDigests } from "../lib/digest";
import { deliver } from "../lib/notifications";
import type { Deps, JobHandler } from "../ports";
import { dayFrom, zoneCache } from "../lib/household-time";

/** Kept from when reminders were maintenance only, so jobs already queued still run. */
export const REMIND_JOB = "maintenance.remind";

interface Digest {
  title: string;
  /** Entries as "title — detail", most urgent first. */
  lines: string[];
  /** One line per entry, for a push notification's small space. */
  short: string;
  url: string;
}

/** What to tell this person today, or null when nothing's urgent. */
export async function dailyDigest(caller: Parameters<typeof needsAttention>[0], appUrl: string): Promise<Digest | null> {
  const urgent = (await needsAttention(caller)).filter((a) => a.severity === "urgent");
  if (!urgent.length) return null;
  const maintenanceOnly = urgent.every((a) => a.kind === "maintenance");
  const shoppingOnly = urgent.length === 1 && urgent[0]!.kind === "shopping";
  return {
    title: maintenanceOnly
      ? maintenanceTitle(urgent, caller.timeZone)
      : shoppingOnly
        ? "Something's run out"
        : urgent.length === 1
          ? "A warranty is ending"
          : `${urgent.length} things need attention`,
    lines: urgent.map((a) => `${a.title} — ${a.detail}`),
    short: urgent.slice(0, 4).map((a) => a.title).join(" · "),
    url: `${appUrl}/#/${maintenanceOnly ? "maintenance" : shoppingOnly ? "shopping" : ""}`,
  };
}

function maintenanceTitle(tasks: AttentionItem[], timeZone: string) {
  const on = today(undefined, timeZone);
  const overdue = tasks.filter((t) => t.date && t.date < on).length;
  if (tasks.length === 1) return overdue ? "Overdue maintenance" : "Maintenance due today";
  return `${tasks.length} maintenance tasks ${overdue === tasks.length ? "overdue" : "due"}`;
}

/** The longer text for Apprise channels (ntfy, email…), with a link back. */
const fullBody = (d: Digest) => `${d.lines.slice(0, 10).map((l) => `• ${l}`).join("\n")}${d.lines.length > 10 ? `\n…and ${d.lines.length - 10} more` : ""}\n\n${d.url}`;

export function sendReminders(deps: Deps & { files: FileStore; appUrl: string; remindHour: number; mailUrl?: string; now?: () => Date }): JobHandler {
  return async () => {
    const { db, push, notifier, files } = deps;
    const now = deps.now?.() ?? new Date();
    if (!push && !notifier) return;
    // Each household its own morning: its today, once it's REMIND_HOUR there.
    const zoneOf = zoneCache(db);
    const dayFor = dayFrom(db, now, deps.remindHour);

    // One digest per person and household, shared by all their devices and channels.
    const digests = new Map<string, Digest | null | "left">();
    const digestFor = async (householdId: string, userId: string) => {
      const key = `${householdId}:${userId}`;
      if (!digests.has(key)) {
        const member = await membership(db, householdId, userId);
        digests.set(key, member ? await dailyDigest({ deps, db, householdId, userId, timeZone: await zoneOf(householdId), via: "web" }, deps.appUrl) : "left");
      }
      return digests.get(key)!;
    };

    if (push) {
      for (const sub of await db.select().from(pushSubscription)) {
        const on = await dayFor(sub.householdId);
        if (!on || sub.lastNotifiedOn === on) continue;
        const digest = await digestFor(sub.householdId, sub.userId);
        if (digest === "left") {
          await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
          continue;
        }
        if (digest) {
          const result = await push.send(sub, { title: digest.title, body: digest.short, url: digest.url, tag: "ferret-reminders" });
          if (result === "gone") {
            await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
            continue;
          }
        }
        await db.update(pushSubscription).set({ lastNotifiedOn: on }).where(eq(pushSubscription.id, sub.id));
      }
    }

    if (notifier) {
      for (const channel of await db.select().from(notificationChannel)) {
        const on = await dayFor(channel.householdId);
        if (!on || channel.lastNotifiedOn === on) continue;
        const digest = await digestFor(channel.householdId, channel.userId);
        if (digest === "left") {
          await db.delete(notificationChannel).where(eq(notificationChannel.id, channel.id));
          continue;
        }
        // A failed send leaves lastNotifiedOn alone, so the next hourly check tries again.
        if (digest && (await deliver(db, files, notifier, channel, { title: digest.title, body: fullBody(digest) }))) continue;
        await db.update(notificationChannel).set({ lastNotifiedOn: on }).where(eq(notificationChannel.id, channel.id));
      }
    }

    // Borrowers of lent things, by email, as often as each loan asks.
    await sendLoanReminders({ db, notifier, files, mailUrl: deps.mailUrl, appUrl: deps.appUrl, dayFor });
    // The weekly summary, for whoever's day it is.
    await sendWeeklyDigests({ ...deps, now, dayFor });
  };
}
