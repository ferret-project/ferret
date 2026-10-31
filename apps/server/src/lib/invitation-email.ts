/**
 * Invitations by email. An invitation is still a link (`#/invite/:id`, bound to the invited address); when Ferret can
 * send email, inviting someone (or Send again — Better Auth's invite-member with `resend`, which keeps the id and
 * gives it another two weeks) also emails them that link, from a job. `invitation_email` keeps when it last went
 * out, or why it failed, for Settings → Household. Without email the app says plainly that Ferret doesn't send it.
 *
 * Someone could invite strangers just to send them email, so a household sends at most INVITES_A_DAY a day, and
 * one invitation at most once every RESEND_AFTER_MS.
 */
import { and, count, eq, gt } from "drizzle-orm";
import { invitation, invitationEmail, organization, user } from "../db/schema";
import type { Db, Deps, JobHandler } from "../ports";
import { householdTimeZone } from "./household-time";
import { mailTo } from "./notifications";

export const INVITE_EMAIL_JOB = "auth.invite-email";
export const INVITES_A_DAY = 20;
export const RESEND_AFTER_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Better Auth's sendInvitationEmail (auth.ts): note it's on its way and queue the job. */
export async function queueInvitationEmail(db: Db, jobs: NonNullable<Deps["jobs"]>, invite: { id: string; organizationId: string }, now = Date.now()) {
  const queuedAt = new Date(now);
  await db
    .insert(invitationEmail)
    .values({ invitationId: invite.id, householdId: invite.organizationId, queuedAt })
    .onConflictDoUpdate({ target: invitationEmail.invitationId, set: { queuedAt, error: null } });
  await jobs.enqueue(INVITE_EMAIL_JOB, { invitationId: invite.id });
}

/** The job: email the invitation's link, if it's still waiting and the household hasn't sent too many. */
export function sendInvitationJob(deps: Pick<Deps, "db" | "notifier"> & { appUrl: string; mailUrl?: string; now?: () => number }): JobHandler {
  return async (payload) => {
    const { invitationId } = payload as { invitationId: string };
    const { db, notifier, mailUrl } = deps;
    if (!notifier || !mailUrl) return;
    const now = deps.now?.() ?? Date.now();
    const [row] = await db
      .select({
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        householdId: invitation.organizationId,
        householdName: organization.name,
        inviterName: user.name,
        sentAt: invitationEmail.sentAt,
      })
      .from(invitation)
      .innerJoin(organization, eq(organization.id, invitation.organizationId))
      .innerJoin(user, eq(user.id, invitation.inviterId))
      .leftJoin(invitationEmail, eq(invitationEmail.invitationId, invitation.id))
      .where(eq(invitation.id, invitationId));
    if (!row || row.status !== "pending" || row.expiresAt.getTime() < now) return;
    if (row.sentAt && now - row.sentAt.getTime() < RESEND_AFTER_MS) return;
    const [today] = await db
      .select({ n: count() })
      .from(invitationEmail)
      .where(and(eq(invitationEmail.householdId, row.householdId), gt(invitationEmail.sentAt, new Date(now - DAY_MS))));
    if ((today?.n ?? 0) >= INVITES_A_DAY) {
      await failed(db, invitationId, `This household has emailed ${INVITES_A_DAY} invitations today — copy the link and send it yourself, or try tomorrow`);
      return;
    }
    const link = `${deps.appUrl}/#/invite/${encodeURIComponent(invitationId)}`;
    // The day it stops working where the household is (as Settings → Household shows it), not in UTC.
    const timeZone = await householdTimeZone(db, row.householdId);
    const until = row.expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone });
    try {
      await notifier.send(mailTo(mailUrl, row.email), {
        title: `${row.inviterName} invited you to ${row.householdName} on Ferret`,
        body:
          `${row.inviterName} invited you to join "${row.householdName}" on Ferret, where they keep track of the things ` +
          `in their home. Open this link to join — it works until ${until}, and only for ${row.email}:\n\n${link}\n\n` +
          "New to Ferret? You'll make an account with this email address first. If you weren't expecting this, ignore it.",
      });
    } catch (err) {
      await failed(db, invitationId, "The email couldn't be sent — copy the link and send it yourself, or try Send again later");
      throw err;
    }
    await db.update(invitationEmail).set({ sentAt: new Date(now), error: null }).where(eq(invitationEmail.invitationId, invitationId));
  };
}

const failed = (db: Db, invitationId: string, error: string) =>
  db.update(invitationEmail).set({ error }).where(eq(invitationEmail.invitationId, invitationId));

/** The household's pending invitations' emails: when each went out (or why not). */
export async function invitationEmails(db: Db, householdId: string) {
  const rows = await db
    .select({ id: invitationEmail.invitationId, queuedAt: invitationEmail.queuedAt, sentAt: invitationEmail.sentAt, error: invitationEmail.error })
    .from(invitationEmail)
    .innerJoin(invitation, eq(invitation.id, invitationEmail.invitationId))
    .where(and(eq(invitationEmail.householdId, householdId), eq(invitation.status, "pending")));
  return rows.map((r) => ({
    id: r.id,
    queuedAt: r.queuedAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    error: r.error,
  }));
}
