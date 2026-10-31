/**
 * Tells someone their password keeps being got wrong (lib/sign-in-guard.ts
 * raises it at 5, 20 and 100 failures): on every device they get push on and
 * every Apprise channel they added, in any household.
 */
import { eq } from "drizzle-orm";
import { notificationChannel, pushSubscription, user } from "../db/schema";
import type { FileStore } from "../lib/files";
import { deliver, mailTo, notifyPerson } from "../lib/notifications";
import { describeDevice } from "../lib/security";
import type { FailureAlert } from "../lib/sign-in-guard";
import type { Deps, JobHandler } from "../ports";

export const SECURITY_ALERT_JOB = "security.alert";

export function securityAlert(deps: Deps & { files: FileStore; appUrl: string }): JobHandler {
  return async (payload) => {
    const { userId, failures, ipAddress } = payload as FailureAlert;
    const { db, push, notifier, files } = deps;
    const url = `${deps.appUrl}/#/settings/security`;
    const title = "Someone is trying your Ferret password";
    const body =
      `${failures} wrong passwords for your account since you last signed in${ipAddress ? `, the latest from ${ipAddress}` : ""}. ` +
      "If that wasn't you, turn on two-step sign-in in Settings → Security.";

    if (push) {
      for (const sub of await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))) {
        if ((await push.send(sub, { title, body, url, tag: "ferret-security" })) === "gone") {
          await db.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
        }
      }
    }
    if (notifier) {
      for (const channel of await db.select().from(notificationChannel).where(eq(notificationChannel.userId, userId))) {
        await deliver(db, files, notifier, channel, { title, body: `${body}\n\n${url}` });
      }
    }
  };
}

export const PASSWORD_CHANGED_JOB = "security.password-changed";

/** "Your Ferret password was changed" — by email (MAIL_URL), push and Apprise, after a reset. */
export function passwordChanged(deps: Deps & { files: FileStore; appUrl: string; mailUrl?: string }): JobHandler {
  return async (payload) => {
    const { userId, email } = payload as { userId: string; email: string };
    const { db, push, notifier, files } = deps;
    const url = `${deps.appUrl}/#/settings/security`;
    const title = "Your Ferret password was changed";
    const body =
      "Your password was just reset with an emailed link, and every session was signed out. " +
      "If that wasn't you, reset it again now and turn on two-step sign-in in Settings → Security.";
    if (notifier && deps.mailUrl) await notifier.send(mailTo(deps.mailUrl, email), { title, body: `${body}\n\n${url}` });
    if (push) {
      for (const sub of await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId))) {
        await push.send(sub, { title, body, url, tag: "ferret-security" });
      }
    }
    if (notifier) {
      for (const channel of await db.select().from(notificationChannel).where(eq(notificationChannel.userId, userId))) {
        await deliver(db, files, notifier, channel, { title, body: `${body}\n\n${url}` });
      }
    }
  };
}

export const NEW_PLACE_JOB = "security.new-place";

/** "New sign-in to Ferret": from a network this account hasn't used before — push, Apprise and email. */
export function newPlaceAlert(deps: Deps & { files: FileStore; appUrl: string; mailUrl?: string }): JobHandler {
  return async (payload) => {
    const { userId, ipAddress, userAgent, at } = payload as { userId: string; ipAddress: string | null; userAgent: string | null; at: string };
    const [who] = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    if (!who) return;
    const when = new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    await notifyPerson(
      deps,
      userId,
      {
        title: "New sign-in to Ferret",
        body:
          `Your account was just signed in to from somewhere new: ${describeDevice(userAgent)}${ipAddress ? ` at ${ipAddress}` : ""}, ${when}. ` +
          "If that was you, there's nothing to do. If not, change your password and sign out everywhere else in Settings → Security.",
        url: `${deps.appUrl}/#/settings/security`,
        tag: "ferret-security",
      },
      { email: who.email },
    );
  };
}

export const PASSKEY_ADDED_JOB = "security.passkey-added";

/** "A passkey was added to your Ferret account" — a new way in should never go unnoticed (push, Apprise, email). */
export function passkeyAddedAlert(deps: Deps & { files: FileStore; appUrl: string; mailUrl?: string }): JobHandler {
  return async (payload) => {
    const { userId, userAgent } = payload as { userId: string; userAgent: string | null };
    const [who] = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    if (!who) return;
    await notifyPerson(
      deps,
      userId,
      {
        title: "A passkey was added to your Ferret account",
        body:
          `A passkey was just added from ${describeDevice(userAgent)}. It can sign in to your account without a password. ` +
          "If that wasn't you, remove it and sign out everywhere else in Settings → Security.",
        url: `${deps.appUrl}/#/settings/security`,
        tag: "ferret-security",
      },
      { email: who.email },
    );
  };
}
