/**
 * The weekly summary: once a week, on the day each person picks (Settings → Notifications; `person_setting`), from
 * REMIND_HOUR — everything in the bell, urgent and not ("soon": claims waiting, things to name, possible recalls,
 * coverage gaps, things lent out a long time…), plus what's lent out. The daily reminder covers only what's urgent; this
 * is the "everything, once a week" view. It goes where the daily one does (push, their Apprise channels) and, if they
 * ask and the server can send email, to their account's address. Nothing is sent when there's nothing to say.
 */
import { type AttentionItem, type WeeklyDigestInput, type WeeklyDigestSetting, localParts, today } from "@ferret/shared";
import { and, eq, isNotNull } from "drizzle-orm";
import { notificationChannel, personSetting, pushSubscription, user } from "../db/schema";
import type { Deps } from "../ports";
import { needsAttention } from "./attention";
import { membership } from "./context";
import type { FileStore } from "./files";
import type { Caller } from "./inventory";
import { listLoans } from "./loans";
import { deliver, mailTo } from "./notifications";
import { zoneCache } from "./household-time";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const GROUPS: [AttentionItem["kind"][], string][] = [
  [["recall"], "Recalls"],
  [["maintenance"], "Maintenance"],
  [["warranty", "claim"], "Warranties and claims"],
  [["loan"], "Lent and borrowed"],
  [["shopping"], "To buy"],
  [["coverage"], "Insurance coverage"],
  [["review"], "To name"],
  [["backup"], "Backups"],
];

export async function getWeekly(v: Caller, canEmail: boolean): Promise<WeeklyDigestSetting> {
  const [row] = await v.db.select().from(personSetting).where(and(eq(personSetting.householdId, v.householdId), eq(personSetting.userId, v.userId)));
  return { day: row?.weeklyDay ?? null, email: row?.weeklyEmail ?? false, canEmail, lastSentOn: row?.lastWeeklyOn ?? null };
}

export async function setWeekly(v: Caller, input: WeeklyDigestInput, canEmail: boolean) {
  const values = { weeklyDay: input.day, weeklyEmail: Boolean(input.email) };
  await v.db
    .insert(personSetting)
    .values({ householdId: v.householdId, userId: v.userId, ...values })
    .onConflictDoUpdate({ target: [personSetting.householdId, personSetting.userId], set: values });
  return getWeekly(v, canEmail);
}

export interface WeeklyDigest {
  title: string;
  /** For channels and email: sections, then the link. */
  body: string;
  /** For a push notification. */
  short: string;
}

/** This person's week, or null when there's nothing to say. */
export async function weeklyDigest(v: Caller, appUrl: string): Promise<WeeklyDigest | null> {
  const [items, loans] = await Promise.all([needsAttention(v), listLoans(v)]);
  const lent = loans.filter((l) => l.direction === "lent");
  if (!items.length && !lent.length) return null;
  const sections: string[] = [];
  for (const [kinds, heading] of GROUPS) {
    const these = items.filter((a) => kinds.includes(a.kind));
    if (these.length) sections.push(`${heading}\n${these.map((a) => `• ${a.title} — ${a.detail}${a.severity === "urgent" ? " (!)" : ""}`).join("\n")}`);
  }
  const listed = new Set(items.filter((a) => a.kind === "loan").map((a) => a.id));
  const quiet = lent.filter((l) => !listed.has(l.id));
  if (quiet.length) sections.push(`Lent out\n${quiet.map((l) => `• ${l.itemName} — with ${l.person} since ${l.since}`).join("\n")}`);
  const urgent = items.filter((a) => a.severity === "urgent").length;
  const count = items.length;
  return {
    title: count ? `Your week in Ferret: ${count} ${count === 1 ? "thing" : "things"} to look at${urgent ? ` (${urgent} urgent)` : ""}` : "Your week in Ferret",
    body: `${sections.join("\n\n")}\n\n${appUrl}/#/`,
    short: count ? items.slice(0, 4).map((a) => a.title).join(" · ") : `${lent.length} ${lent.length === 1 ? "thing" : "things"} lent out`,
  };
}

/** From the hourly reminder tick: everyone whose day it is, once. */
export async function sendWeeklyDigests(
  deps: Deps & {
    files: FileStore;
    appUrl: string;
    mailUrl?: string;
    now: Date;
    /** Today for this household (null: not yet time there). Default: today where it is. */
    dayFor?: (householdId: string) => Promise<string | null>;
  },
) {
  const { db, push, notifier, files } = deps;
  const zoneOf = zoneCache(db);
  const dayFor = deps.dayFor ?? (async (householdId: string) => today(deps.now, await zoneOf(householdId)));
  const due = await db
    .select({ s: personSetting, email: user.email })
    .from(personSetting)
    .innerJoin(user, eq(user.id, personSetting.userId))
    .where(isNotNull(personSetting.weeklyDay));
  let sent = 0;
  for (const { s, email } of due) {
    // Their day where the household is.
    const on = await dayFor(s.householdId);
    if (!on || localParts(deps.now, await zoneOf(s.householdId)).weekday !== s.weeklyDay || s.lastWeeklyOn === on) continue;
    const mark = () =>
      db.update(personSetting).set({ lastWeeklyOn: on }).where(and(eq(personSetting.householdId, s.householdId), eq(personSetting.userId, s.userId)));
    if (!(await membership(db, s.householdId, s.userId))) {
      await mark();
      continue;
    }
    const digest = await weeklyDigest({ deps, db, householdId: s.householdId, userId: s.userId, timeZone: await zoneOf(s.householdId), via: "web" }, deps.appUrl);
    if (digest) {
      if (push) {
        for (const sub of await db.select().from(pushSubscription).where(and(eq(pushSubscription.householdId, s.householdId), eq(pushSubscription.userId, s.userId)))) {
          await push.send(sub, { title: digest.title, body: digest.short, url: `${deps.appUrl}/#/`, tag: "ferret-weekly" }).catch(() => "failed");
        }
      }
      if (notifier) {
        for (const channel of await db.select().from(notificationChannel).where(and(eq(notificationChannel.householdId, s.householdId), eq(notificationChannel.userId, s.userId)))) {
          await deliver(db, files, notifier, channel, { title: digest.title, body: digest.body });
        }
        if (s.weeklyEmail && deps.mailUrl) {
          await notifier.send(mailTo(deps.mailUrl, email), { title: digest.title, body: digest.body }).catch((err) => console.warn(`Weekly summary email failed: ${String(err)}`));
        }
      }
      sent++;
    }
    await mark();
  }
  return sent;
}

export const dayName = (d: number) => DAYS[d]!;
