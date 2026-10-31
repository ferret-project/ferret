/** Deleting for good: a household (its owner) and an account (its own) — nothing left behind (lib/deletion.ts). */
import type { AccountDeletionInfo } from "@ferret/shared";
import { count, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { apikey, attachment, member, organization, user } from "../src/db/schema";
import { photo, setup } from "./helpers";

type Env = Awaited<ReturnType<typeof setup>>;
const json = (data: object, method = "DELETE") => ({ method, body: JSON.stringify(data) });
const idOf = async (u: { as: (url: string) => Response | Promise<Response> }) => ((await (await u.as("/api/v1/me")).json()) as { user: { id: string } }).user.id;

async function full(env: Env, name: string) {
  const u = await env.user(name);
  const { id: itemId } = await u.addItem({ name: `${name}'s drill`, notes: "serial 12345" });
  const shot = await u.upload(itemId, await photo(), "drill.jpg");
  const key = await u.as("/api/v1/api-keys", json({ name: "script" }, "POST"));
  expect(key.status).toBe(201);
  return { ...u, itemId, shot };
}

const left = async (env: Env, householdId: string) => {
  const [files] = await env.db.select({ n: count() }).from(attachment).where(eq(attachment.householdId, householdId));
  const [search] = await env.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM item_search WHERE household_id = ${householdId}`);
  const [trigram] = await env.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM item_search_trigram WHERE household_id = ${householdId}`);
  const [home] = await env.db.select({ n: count() }).from(organization).where(eq(organization.id, householdId));
  return { attachments: files!.n, search: search!.n, trigram: trigram!.n, household: home!.n };
};

describe("deleting a household", () => {
  it("only its owner, typing its name; then nothing of it is left", async () => {
    const env = await setup();
    const ann = await full(env, "ann");
    const bob = await env.user("bob");
    await env.db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: await idOf(bob), role: "admin", createdAt: new Date() });
    const [row] = await env.db.select().from(attachment).where(eq(attachment.id, ann.shot.id));
    expect(await left(env, ann.householdId)).toMatchObject({ attachments: 1, household: 1 });
    expect((await left(env, ann.householdId)).search).toBeGreaterThan(0);

    const asBob = (init: RequestInit) => bob.as("/api/v1/household", { ...init, headers: { "X-Household-Id": ann.householdId } });
    expect((await asBob(json({ confirm: "ann home" }))).status).toBe(403); // an admin, not the owner
    expect((await ann.as("/api/v1/household", json({ confirm: "someone else's" }))).status).toBe(422);
    // Not around Ferret through Better Auth's own endpoint (it would leave files and search entries behind).
    const direct = await ann.as("/api/auth/organization/delete", json({ organizationId: ann.householdId }, "POST"));
    expect(direct.status).not.toBe(200);
    expect((await left(env, ann.householdId)).household).toBe(1);
    // Ann is the server admin while Bob has an account: her account stays, so the server keeps an admin.
    const done = await ann.as("/api/v1/household", json({ confirm: "ANN HOME " }));
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ accountDeleted: false });

    expect(await left(env, ann.householdId)).toEqual({ attachments: 0, search: 0, trigram: 0, household: 0 });
    expect(await env.files.get(ann.householdId, row!.blobKey).catch(() => null)).toBeNull();
    expect(await env.db.select().from(apikey)).toEqual([]); // the key bound to it
    // Bob is still here, with his own household.
    expect((await bob.as("/api/v1/items")).status).toBe(200);
  });

  it("takes your account too, in the same step, when it's the only household you're in", async () => {
    const env = await setup();
    await env.user("first"); // the server admin
    const ann = await full(env, "ann");
    const annId = await idOf(ann);
    expect(await (await ann.as("/api/v1/household/deletion")).json()).toEqual({ alsoAccount: true, needsPassword: true });
    expect((await ann.as("/api/v1/household", json({ confirm: "ann home" }))).status).toBe(403); // the password, then
    const res = await ann.as("/api/v1/household", json({ confirm: "ann home", password: "correct-horse-battery" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountDeleted: true });
    expect(await env.db.select().from(user).where(eq(user.id, annId))).toEqual([]);
    expect(await left(env, ann.householdId)).toEqual({ attachments: 0, search: 0, trigram: 0, household: 0 });
  });

  it("can be stopped by a beforeDelete hook", async () => {
    const env = await setup({
      extensions: {
        beforeDelete: {
          household: async () => {
            throw new Error("Couldn't end the subscription");
          },
        },
      },
    });
    const ann = await env.user("ann");
    expect((await ann.as("/api/v1/household", json({ confirm: "ann home", password: "correct-horse-battery" }))).status).toBe(500);
    expect((await left(env, ann.householdId)).household).toBe(1);
  });
});

describe("deleting your account", () => {
  it("takes the households only you are in, needs your password, and leaves nothing", async () => {
    const env = await setup();
    await env.user("first"); // the server admin
    const ann = await full(env, "ann");
    const annId = await idOf(ann);
    const info = (await (await ann.as("/api/v1/security/account")).json()) as AccountDeletionInfo;
    expect(info).toEqual({ blockers: [], households: [{ id: ann.householdId, name: "ann home" }], needsPassword: true, serverAdmin: false });

    expect((await ann.as("/api/v1/security/account", json({ confirm: "nope@example.com", password: "x" }))).status).toBe(422);
    expect((await ann.as("/api/v1/security/account", json({ confirm: "ann@example.com" }))).status).toBe(403); // no password
    expect((await ann.as("/api/v1/security/account", json({ confirm: "ann@example.com", password: "wrong-password-1" }))).status).toBe(403);
    expect((await ann.as("/api/v1/security/account", json({ confirm: "ann@example.com", password: "correct-horse-battery" }))).status).toBe(204);

    expect(await env.db.select().from(user).where(eq(user.id, annId))).toEqual([]);
    expect(await left(env, ann.householdId)).toEqual({ attachments: 0, search: 0, trigram: 0, household: 0 });
    expect(await env.db.select().from(apikey).where(eq(apikey.referenceId, annId))).toEqual([]);
    expect((await ann.as("/api/v1/me")).status).toBe(401); // signed out: the session went with it
  });

  it("not while others are in a household you own, nor as the server admin", async () => {
    const env = await setup();
    const first = await env.user("first"); // the server admin
    const ann = await env.user("ann");
    await env.db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: await idOf(first), role: "member", createdAt: new Date() });
    const blocked = await ann.as("/api/v1/security/account", json({ confirm: "ann@example.com", password: "correct-horse-battery" }));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { message: string } }).error.message).toContain("ann home");
    const admin = await first.as("/api/v1/security/account", json({ confirm: "first@example.com", password: "correct-horse-battery" }));
    expect(admin.status).toBe(409);
  });

  it("not with an API key", async () => {
    const env = await setup();
    const ann = await env.user("ann");
    const { key } = (await (await ann.as("/api/v1/api-keys", json({ name: "k" }, "POST"))).json()) as { key: string };
    const res = await env.app.request("/api/v1/security/account", { method: "DELETE", body: JSON.stringify({ confirm: "ann@example.com" }), headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
    expect(res.status).toBe(403);
  });
});
