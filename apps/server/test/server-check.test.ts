/** Server check: what's wrong with the live server — missing files, rows pointing at deleted things, backups. */
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { attachment, job, location } from "../src/db/schema";
import { purgeFailedJobs } from "../src/jobs/purge";
import { setup } from "./helpers";

type Check = { files: { total: number; missing: number; unreadable: number }; findings: { kind: string; count: number; examples: string[] }[] };
const pdf = () => new TextEncoder().encode("%PDF-1.7 receipt") as Uint8Array<ArrayBuffer>;

describe("server check", () => {
  it("finds missing files and things in deleted rooms, for the server admin only", async () => {
    const { user, db, deps } = await setup();
    const ann = await user("ann"); // the first account: server admin
    const bob = await user("bob");
    const fine = await ann.addItem({ name: "Blender" });
    await ann.upload(fine.id, pdf(), "blender.pdf", "document");
    const lost = await ann.addItem({ name: "Drill" });
    const up = await ann.upload(lost.id, pdf(), "drill.pdf", "document");

    const clean = (await (await ann.as("/api/v1/server/check", { method: "POST" })).json()) as Check;
    expect(clean.findings.filter((f) => !f.kind.startsWith("backups"))).toEqual([]);
    expect(clean.files).toMatchObject({ total: 2, missing: 0, unreadable: 0 });

    // A file gone from the store, and a room deleted with something still in it (as by a bug — the app won't).
    const [row] = await db.select({ key: attachment.blobKey }).from(attachment).where(eq(attachment.id, up.id));
    await deps.blobs.delete(row!.key);
    const home = (await (await ann.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Home" }) })).json()) as { id: string };
    const shed = (await (await ann.as("/api/v1/locations", { method: "POST", body: JSON.stringify({ name: "Shed", propertyId: home.id }) })).json()) as { id: string };
    await ann.addItem({ name: "Mower", locationId: shed.id });
    await db.update(location).set({ deletedAt: new Date() }).where(and(eq(location.id, shed.id)));

    const res = (await (await ann.as("/api/v1/server/check", { method: "POST" })).json()) as Check;
    const kinds = Object.fromEntries(res.findings.map((f) => [f.kind, f]));
    expect(kinds["files.missing"]).toMatchObject({ count: 1, examples: [expect.stringContaining("Drill › drill.pdf")] });
    expect(kinds["items.room"]).toMatchObject({ count: 1, examples: [expect.stringContaining("Mower › Shed (deleted)")] });

    expect((await bob.as("/api/v1/server/check", { method: "POST" })).status).toBe(403);
  });
});

describe("failed jobs", () => {
  it("are reported for a week and purged after 30 days", async () => {
    const { user, db } = await setup();
    const ann = await user("ann");
    const day = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
    await db.insert(job).values([
      { type: "maintenance.remind", payload: "{}", status: "failed", attempts: 6, runAt: at(1) },
      { type: "maintenance.remind", payload: "{}", status: "failed", attempts: 6, runAt: at(8) },
      { type: "maintenance.remind", payload: "{}", status: "failed", attempts: 6, runAt: at(40) },
    ]);
    const res = (await (await ann.as("/api/v1/server/check", { method: "POST" })).json()) as Check;
    expect(res.findings.find((f) => f.kind === "jobs.failed")).toMatchObject({ examples: ["maintenance.remind: 1"] });
    expect(await purgeFailedJobs(db)).toBe(1);
    expect((await db.select().from(job).where(eq(job.status, "failed"))).length).toBe(2);
  });
});
