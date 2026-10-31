/**
 * "Email me a link to sign in again": makes a one-time unlock link for the
 * account (if there is one — the request never says) and sends it by email
 * (MAIL_URL, through Apprise) and to the person's push devices and Apprise
 * channels. A job, so the sign-in screen answers at once either way.
 */
import { eq } from "drizzle-orm";
import { notificationChannel, pushSubscription, user } from "../db/schema";
import type { FileStore } from "../lib/files";
import { deliver, mailTo } from "../lib/notifications";
import { createUnlock } from "../lib/sign-in-guard";
import type { Deps, JobHandler } from "../ports";

export const UNLOCK_JOB = "security.unlock";

export function sendUnlockLink(deps: Deps & { files: FileStore; appUrl: string; mailUrl?: string }): JobHandler {
  return async (payload) => {
    const { email, ipAddress } = payload as { email: string; ipAddress: string | null };
    const { db, push, notifier, files } = deps;
    const [account] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, email));
    if (!account) return;
    const token = await createUnlock(db, email);
    if (!token) return; // one went out in the last few minutes

    const url = `${deps.appUrl}/#/unlock/${token}`;
    const title = "Sign in to Ferret again";
    const body =
      `Someone${ipAddress ? ` at ${ipAddress}` : ""} asked to clear the wrong-password count on your Ferret account, ` +
      `so you can sign in again straight away. Open this link (it works once, for 30 minutes):\n\n${url}\n\n` +
      "If that wasn't you, ignore this — and consider turning on two-step sign-in in Settings → Security.";

    if (notifier && deps.mailUrl) await notifier.send(mailTo(deps.mailUrl, account.email), { title, body });
    if (push) {
      for (const sub of await db.select().from(pushSubscription).where(eq(pushSubscription.userId, account.id))) {
        await push.send(sub, { title, body: "Tap to clear the wrong-password count and sign in again.", url, tag: "ferret-unlock" });
      }
    }
    if (notifier) {
      for (const channel of await db.select().from(notificationChannel).where(eq(notificationChannel.userId, account.id))) {
        await deliver(db, files, notifier, channel, { title, body });
      }
    }
  };
}
