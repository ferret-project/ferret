/** The server admin: the first account, until handed over (Settings → Server or the CLI); never by an API key. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { user as users } from "../src/db/schema";
import { serverAdmin, setServerAdmin } from "../src/lib/server-admin";
import { setup } from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const put = (email: string) => ({ method: "PUT", body: JSON.stringify({ email }) });

describe("server admin", () => {
  it("is the first account, and can be handed to another confirmed account", async () => {
    const { db, user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    expect(await json(ann.as("/api/v1/server/admin"))).toMatchObject({ name: "ann", email: "ann@example.com" });
    expect((await bob.as("/api/v1/server/admin")).status).toBe(403);
    expect((await bob.as("/api/v1/server/admin", put("bob@example.com"))).status).toBe(403);

    expect((await ann.as("/api/v1/server/admin", put("nobody@example.com"))).status).toBe(404);
    await user("cy");
    await db.update(users).set({ emailVerified: false }).where(eq(users.email, "cy@example.com"));
    expect((await ann.as("/api/v1/server/admin", put("cy@example.com"))).status).toBe(409);

    expect(await json(ann.as("/api/v1/server/admin", put("Bob@Example.com")))).toMatchObject({ name: "bob" });
    expect((await ann.as("/api/v1/backup")).status).toBe(403);
    expect(await json<{ serverAdmin: boolean }>(bob.as("/api/v1/me"))).toMatchObject({ serverAdmin: true });
    expect(await json<{ serverAdmin: boolean }>(ann.as("/api/v1/me"))).toMatchObject({ serverAdmin: false });

    // If that account goes, it's the oldest one again.
    await db.delete(users).where(eq(users.email, "bob@example.com"));
    expect(await serverAdmin(db)).toMatchObject({ name: "ann" });
    await expect(setServerAdmin(db, "ann@example.com")).resolves.toMatchObject({ name: "ann" });
  });

  it("isn't reachable with an API key, even the admin's", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const key = await json<{ key: string }>(ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "script" }) }));
    const res = await ann.as("/api/v1/server/admin", { headers: { Cookie: "", Authorization: `Bearer ${key.key}` } });
    expect(res.status).toBe(403);
  });
});
