import { tn } from "./../lib/i18n";
import { t as translateText } from "./../lib/i18n";
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
        title: translateText("Someone signed up"),
        body: tn(all!.n, "{v0} has {count} account now ({v3} with a confirmed email).", "{v0} has {count} accounts now ({v3} with a confirmed email).", { v0: new URL(deps.appUrl).host, v3: confirmed!.n }),
        url: deps.appUrl,
      },
      `${deps.appUrl}/icon-192.png`,
    );
  };
}
