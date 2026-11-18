/**
 * Tells someone their password keeps being got wrong (lib/sign-in-guard.ts
 * raises it at 5, 20 and 100 failures): on every device they get push on and
 * every Apprise channel they added, in any household.
 */
import { eq } from "drizzle-orm";
import { notificationChannel, oauthClient, organization, pushSubscription, user } from "../db/schema";
import { parseReference } from "../lib/oauth";
import type { FileStore } from "../lib/files";
import { deliver, notifyPerson, sendEmail } from "../lib/notifications";
import { describeDevice } from "../lib/security";
import { trFor } from "../lib/language";
import type { FailureAlert } from "../lib/sign-in-guard";
import type { Deps, JobHandler } from "../ports";

export const SECURITY_ALERT_JOB = "security.alert";

export function securityAlert(deps: Deps & { files: FileStore; appUrl: string }): JobHandler {
  return async (payload) => {
    const { userId, failures, ipAddress } = payload as FailureAlert;
    const { db, push, notifier, files } = deps;
    const url = `${deps.appUrl}/#/settings/security`;
    const tr = await trFor(deps, userId);
    const title = tr("Someone is trying your Ferret password");
    const body = ipAddress
      ? tr("{failures, plural, one {# wrong password} other {# wrong passwords}} for your account since you last signed in, the latest from {address}. If that wasn't you, turn on two-step sign-in in Settings → Security.", { failures, address: ipAddress })
      : tr("{failures, plural, one {# wrong password} other {# wrong passwords}} for your account since you last signed in. If that wasn't you, turn on two-step sign-in in Settings → Security.", { failures });

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
    const tr = await trFor(deps, userId);
    const title = tr("Your Ferret password was changed");
    const body = tr("Your password was just reset with an emailed link, and every session was signed out. If that wasn't you, reset it again now and turn on two-step sign-in in Settings → Security.");
    if (notifier && deps.mailUrl) {
      await sendEmail(
        notifier,
        deps.mailUrl,
        email,
        {
          subject: title,
          heading: tr("Your password was changed"),
          paragraphs: [tr("Your Ferret password was just reset with an emailed link, and every session was signed out.")],
          action: { label: tr("Review your sign-in security"), url },
          footnote: tr("If that wasn't you, reset it again now and turn on two-step sign-in in Settings → Security."),
          appUrl: deps.appUrl,
        },
        tr,
      );
    }
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
    const tr = await trFor(deps, userId);
    const when = new Date(at).toLocaleString(tr.locale, { dateStyle: "medium", timeStyle: "short" });
    const device = describeDevice(userAgent);
    await notifyPerson(
      deps,
      userId,
      {
        title: tr("New sign-in to Ferret"),
        body: ipAddress
          ? tr("Your account was just signed in to from somewhere new: {device} at {address}, {when}. If that was you, there's nothing to do. If not, change your password and sign out everywhere else in Settings → Security.", { device, address: ipAddress, when })
          : tr("Your account was just signed in to from somewhere new: {device}, {when}. If that was you, there's nothing to do. If not, change your password and sign out everywhere else in Settings → Security.", { device, when }),
        url: `${deps.appUrl}/#/settings/security`,
        tag: "ferret-security",
        action: tr("Review your sign-in security"),
      },
      { email: who.email, tr },
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
    const tr = await trFor(deps, userId);
    await notifyPerson(
      deps,
      userId,
      {
        title: tr("A passkey was added to your Ferret account"),
        body: tr("A passkey was just added from {device}. It can sign in to your account without a password. If that wasn't you, remove it and sign out everywhere else in Settings → Security.", { device: describeDevice(userAgent) }),
        url: `${deps.appUrl}/#/settings/security`,
        tag: "ferret-security",
        action: tr("Review your sign-in security"),
      },
      { email: who.email, tr },
    );
  };
}

export const APP_CONNECTED_JOB = "security.app-connected";

/** "An app was connected to your Ferret account" — an app that can read the inventory is a new way in (push, Apprise, email). */
export function appConnectedAlert(deps: Deps & { files: FileStore; appUrl: string; mailUrl?: string }): JobHandler {
  return async (payload) => {
    const { userId, clientId, reference } = payload as { userId: string; clientId: string; reference: string };
    const [who] = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    const [app] = await deps.db.select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, clientId));
    const target = parseReference(reference);
    if (!who || !app || !target) return;
    const [household] = await deps.db.select({ name: organization.name }).from(organization).where(eq(organization.id, target.householdId));
    const tr = await trFor(deps, userId);
    const names = { app: app.name?.trim() || tr("An app"), household: household?.name ?? tr("a household") };
    await notifyPerson(
      deps,
      userId,
      {
        title: tr("{app} was connected to your Ferret account", names),
        body: target.readOnly
          ? tr("{app} can now look things up in {household} with your account. If that wasn't you, disconnect it in Settings → Claude & API, change your password and sign out everywhere else in Settings → Security.", names)
          : tr("{app} can now look things up in and change {household} with your account. If that wasn't you, disconnect it in Settings → Claude & API, change your password and sign out everywhere else in Settings → Security.", names),
        url: `${deps.appUrl}/#/settings/api`,
        tag: "ferret-security",
        action: tr("Review connected apps"),
      },
      { email: who.email, tr },
    );
  };
}
