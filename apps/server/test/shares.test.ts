/** Share links: a read-only report (or a tag's things) for someone without an account — expiring, logged, revocable. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { shareLink } from "../src/db/schema";
import { config, photo, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("share links", () => {
  it("shows the report without an account, with its files, logged — until it's turned off or runs out", async () => {
    const { app, db, user } = await setup();
    const anon = (url: string) => app.request(url, { headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "Insurer browser" } });
    const ann = await user("ann");
    const home = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Home" }));
    const cabin = await json<{ id: string }>(send(ann, "POST", "/api/v1/properties", { name: "Cabin" }));
    const den = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: home.id, name: "Den" }));
    const lodge = await json<{ id: string }>(send(ann, "POST", "/api/v1/locations", { propertyId: cabin.id, name: "Lodge" }));
    const tv = await ann.addItem({ name: "TV", locationId: den.id, valueCents: 90000, notes: "Spare key taped behind it", tags: ["electronics"] });
    const canoe = await ann.addItem({ name: "Canoe", locationId: lodge.id, valueCents: 50000 });
    const tvPhoto = await ann.upload(tv.id, await photo(), "tv.jpg");
    const canoePhoto = await ann.upload(canoe.id, await photo(), "canoe.jpg");

    const made = await send(ann, "POST", "/api/v1/shares", { kind: "report", propertyId: home.id, label: "State Farm claim", days: 30 });
    expect(made.status).toBe(201);
    const link = await json<{ id: string; url: string; title: string; active: boolean }>(made);
    expect(link).toMatchObject({ title: "Insurance report — Home", active: true });
    expect(link.url).toMatch(new RegExp(`^${config.PUBLIC_URL}/s/[\\w-]{40,}$`));
    const token = link.url.split("/s/")[1]!;

    // The short link opens the app's page for it.
    const short = await app.request(`/s/${token}`);
    expect(short.status).toBe(302);
    expect(short.headers.get("location")).toBe(`/#/s/${token}`);

    const view = await json<{ household: string; label: string; sharedBy: string; rows: { name: string; notes: string | null }[]; files: Record<string, { id: string }[]>; properties: { name: string }[] }>(
      anon(`/api/v1/shared/${token}`),
    );
    expect(view).toMatchObject({ household: "ann home", label: "State Farm claim", sharedBy: "ann", properties: [{ name: "Home" }] });
    expect(view.rows.map((r) => [r.name, r.notes])).toEqual([["TV", null]]); // the cabin isn't shared; notes never are
    expect(view.files[tv.id]!.map((f) => f.id)).toEqual([tvPhoto.id]);
    expect((await anon(`/api/v1/shared/${token}/files/${tvPhoto.id}/thumbnail`)).status).toBe(200);
    expect((await anon(`/api/v1/shared/${token}/files/${tvPhoto.id}`)).headers.get("content-type")).toMatch(/^image\//);
    expect((await anon(`/api/v1/shared/${token}/files/${canoePhoto.id}`)).status).toBe(404); // not in what's shared
    expect(await (await anon(`/api/v1/shared/${token}/items.csv`)).text()).toContain("TV,Home › Den");

    const views = await json<{ data: { ipAddress: string; userAgent: string }[] }>(ann.as(`/api/v1/shares/${link.id}/views`));
    expect(views.data).toEqual([{ at: expect.any(String), ipAddress: "203.0.113.9", userAgent: "Insurer browser" }]);
    expect(await json(ann.as("/api/v1/shares"))).toMatchObject({ data: [{ id: link.id, views: 1, url: link.url }] });

    // A tag's things, without files.
    const tagged = await json<{ url: string }>(send(ann, "POST", "/api/v1/shares", { kind: "tag", tag: "Electronics", days: 7, includeFiles: false }));
    const tagToken = tagged.url.split("/s/")[1]!;
    expect((await json<{ rows: { name: string }[]; files: object }>(anon(`/api/v1/shared/${tagToken}`))).rows.map((r) => r.name)).toEqual(["TV"]);
    expect((await anon(`/api/v1/shared/${tagToken}/files/${tvPhoto.id}`)).status).toBe(404);

    // Off, or out of time: gone. Someone else's: not theirs to turn off.
    const bob = await user("bob");
    expect((await send(bob, "POST", `/api/v1/shares/${link.id}/revoke`)).status).toBe(404);
    expect((await send(ann, "POST", `/api/v1/shares/${link.id}/revoke`)).status).toBe(204);
    expect((await anon(`/api/v1/shared/${token}`)).status).toBe(410);
    await db.update(shareLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLink.tag, "Electronics"));
    expect((await anon(`/api/v1/shared/${tagToken}`)).status).toBe(410);
    expect((await anon("/api/v1/shared/not-a-real-token-at-all-0000")).status).toBe(404);
  });

  it("is for owners and admins with a real sign-in", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const key = await json<{ key: string }>(send(ann, "POST", "/api/v1/api-keys", { name: "script" }));
    const res = await ann.as("/api/v1/shares", { method: "POST", body: JSON.stringify({ kind: "report", days: 7 }), headers: { Cookie: "", Authorization: `Bearer ${key.key}` } });
    expect(res.status).toBe(403);
  });
});
