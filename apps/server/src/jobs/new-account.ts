/**
 * A new account was made: one line in the admins' Discord channel (ADMIN_WEBHOOK_URL), with the totals. Never who it
 * was — names and emails don't go to Discord; the admin looks them up on the server.
 */
import { count, eq } from "drizzle-orm";
import { user } from "../db/schema";
import { postToWebhook } from "../lib/service-errors";
import type { Db, JobHandler } from "../ports";

export const NEW_ACCOUNT_JOB = "account.created";

export function newAccountAlert(deps: { db: Db; appUrl: string; adminWebhook?: string }): JobHandler {
  return async () => {
    if (!deps.adminWebhook) return;
    const [all] = await deps.db.select({ n: count() }).from(user);
    const [confirmed] = await deps.db.select({ n: count() }).from(user).where(eq(user.emailVerified, true));
    await postToWebhook(
      deps.adminWebhook,
      {
        title: "Someone signed up",
        body: `${new URL(deps.appUrl).host} has ${all!.n} account${all!.n === 1 ? "" : "s"} now (${confirmed!.n} with a confirmed email).`,
        url: deps.appUrl,
      },
      `${deps.appUrl}/icon-192.png`,
    );
  };
}
