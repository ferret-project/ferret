/**
 * /api/v1/security — your sessions and recent sign-ins, and deleting your account (a real sign-in only: not with an
 * API key).
 */
import { accountDeleteInput } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { accountDeletionInfo, confirmIdentity, deleteAccount } from "../lib/deletion";
import { type AppEnv, body, requireSession, requireUser } from "../lib/context";
import { listSessions, listSignIns, revokeOtherSessions, revokeSession } from "../lib/security";

export const security = new Hono<AppEnv>();
security.use(requireUser, requireSession);

// requireSession guarantees c.var.session.
const ids = (c: { var: AppEnv["Variables"] }) => ({ userId: c.var.user.id, currentId: c.var.session!.id });

security.get("/sessions", async (c) => {
  const { userId, currentId } = ids(c);
  return c.json({ data: await listSessions(c.var.db, userId, currentId) });
});

security.delete("/sessions/:id", async (c) => {
  const { userId, currentId } = ids(c);
  await revokeSession(c.var.db, userId, currentId, c.req.param("id"));
  return c.body(null, 204);
});

/** Signs out every other session. */
security.post("/sessions/revoke-others", async (c) => {
  const { userId, currentId } = ids(c);
  return c.json({ signedOut: await revokeOtherSessions(c.var.db, userId, currentId) });
});

security.get("/sign-ins", async (c) => c.json({ data: await listSignIns(c.var.db, c.var.user.id) }));

// ── Deleting your account ─────────────────────────────────────────────────────

/** What deleting your account would take with it, or what stops it. */
security.get("/account", async (c) => c.json(await accountDeletionInfo(c)));

/**
 * Deletes your account for good, with the households only you are in. Not while you own a household others are in,
 * nor while you're the server admin and others have accounts. Confirmed with your email typed, and your password (or a
 * sign-in in the last 15 minutes, for accounts without one).
 */
security.delete("/account", async (c) => {
  const input = await body(c.req.raw, accountDeleteInput);
  const me = c.var.user;
  if (input.confirm.trim().toLowerCase() !== me.email.toLowerCase()) throw new HTTPException(422, { message: "Type your email address exactly to delete your account" });
  const info = await accountDeletionInfo(c);
  if (info.serverAdmin) throw new HTTPException(409, { message: "You're the server admin: hand that over first (Settings → Server)" });
  if (info.blockers.length) {
    throw new HTTPException(409, { message: `Other people are in ${info.blockers.map((b) => b.name).join(", ")}: make one of them its owner, or delete it, first` });
  }
  await confirmIdentity(c, info.needsPassword, input.password);
  for (const h of info.households) await c.var.extensions?.beforeDelete?.household?.(c, h.id);
  await c.var.extensions?.beforeDelete?.account?.(c, me.id);
  await deleteAccount({ deps: c.var.deps, files: c.var.files }, me.id);
  return c.body(null, 204);
});
