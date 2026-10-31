/**
 * The household's own settings (Settings → Household): its time zone (lib/household-time.ts). Anyone in it can read
 * them; the owner and admins change them. And deleting it for good — its owner, signed in for real.
 */
import { type HouseholdSettings, type InvitationEmails, householdSettingsInput } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type HouseholdDeletionInfo, householdDeleteInput } from "@ferret/shared";
import type { Context } from "hono";
import { and, eq, ne } from "drizzle-orm";
import { member, organization } from "../db/schema";
import { type AppEnv, body, requireHousehold, requireSession, requireUser, requireWriter } from "../lib/context";
import { accountDeletionInfo, confirmIdentity, deleteAccount, deleteHouseholds } from "../lib/deletion";
import { emailEnabled } from "../lib/email-verification";
import { invitationEmails } from "../lib/invitation-email";
import { chosenTimeZone, serverTimeZone, setHouseholdTimeZone } from "../lib/household-time";

export const household = new Hono<AppEnv>();

household.use("/*", requireUser, requireHousehold);

const settings = async (c: { var: AppEnv["Variables"] }): Promise<HouseholdSettings> => ({
  timeZone: await chosenTimeZone(c.var.db, c.var.householdId),
  serverTimeZone: serverTimeZone(),
});

household.get("/settings", async (c) => c.json(await settings(c)));

household.put("/settings", requireWriter, async (c) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: "Only the household's owner and admins can change this" });
  const input = await body(c.req.raw, householdSettingsInput);
  await setHouseholdTimeZone(c.var.db, c.var.householdId, input.timeZone);
  return c.json(await settings(c));
});

/** Owners and admins (who invite people): whether invitations are emailed here, and when each pending one went out. */
household.get("/invitations", async (c) => {
  if (c.var.role !== "owner" && c.var.role !== "admin") throw new HTTPException(403, { message: "Only the household's owner and admins see invitations" });
  return c.json({ email: emailEnabled(c.var.deps, c.var.config), data: await invitationEmails(c.var.db, c.var.householdId) } satisfies InvitationEmails);
});

/** Whether deleting this household takes the owner's account too (the only household they're in). */
async function householdDeletion(c: Context<AppEnv>): Promise<HouseholdDeletionInfo & { needsPasswordCheck: boolean }> {
  const others = await c.var.db
    .select({ id: member.organizationId })
    .from(member)
    .where(and(eq(member.userId, c.var.user.id), ne(member.organizationId, c.var.householdId)))
    .limit(1);
  const account = await accountDeletionInfo(c);
  // Not the server admin while others have accounts: the server would be left without one.
  const alsoAccount = others.length === 0 && !account.serverAdmin;
  return { alsoAccount, needsPassword: alsoAccount && account.needsPassword, needsPasswordCheck: account.needsPassword };
}

household.get("/deletion", requireSession, async (c) => {
  const { alsoAccount, needsPassword } = await householdDeletion(c);
  return c.json({ alsoAccount, needsPassword } satisfies HouseholdDeletionInfo);
});

/**
 * Deletes the household for good: everything in it, its files and search entries; its people lose access. Only its
 * owner, signed in (not an API key), typing its name. When it's the only household they're in, their account goes
 * with it in the same step (confirmed like deleting an account). The beforeDelete hooks run first and may stop it.
 */
household.delete("/", requireSession, async (c) => {
  if (c.var.role !== "owner") throw new HTTPException(403, { message: "Only the household's owner can delete it" });
  const input = await body(c.req.raw, householdDeleteInput);
  const [home] = await c.var.db.select({ name: organization.name }).from(organization).where(eq(organization.id, c.var.householdId));
  if (!home || input.confirm.trim().toLowerCase() !== home.name.trim().toLowerCase()) {
    throw new HTTPException(422, { message: "Type the household's name exactly to delete it" });
  }
  const { alsoAccount, needsPasswordCheck } = await householdDeletion(c);
  if (alsoAccount) await confirmIdentity(c, needsPasswordCheck, input.password);
  await c.var.extensions?.beforeDelete?.household?.(c, c.var.householdId);
  if (alsoAccount) await c.var.extensions?.beforeDelete?.account?.(c, c.var.user.id);
  await deleteHouseholds({ deps: c.var.deps, files: c.var.files }, [c.var.householdId]);
  if (alsoAccount) await deleteAccount({ deps: c.var.deps, files: c.var.files }, c.var.user.id);
  return c.json({ accountDeleted: alsoAccount });
});
