/** Freeing space: an attachment's original removed, its small copy kept (lib/attachments.ts removeOriginals). */
import type { Attachment, PlanReport } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { removeOriginals } from "../src/lib/attachments";
import { pdf, photo, setup } from "./helpers";

describe("removing originals", () => {
  it("keeps the thumbnail, serves it in the original's place, and stops counting the original", async () => {
    const env = await setup({ entitlements: { plan: async () => ({ name: "Plus", limits: { items: null, fileBytes: null, members: null, ai: true, aiActions: null, barcodeLookups: null, apiKeys: true, shareLinks: true, calendarFeeds: true } }) } });
    const pat = await env.user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    const shot = await pat.upload(itemId, await photo(), "drill.jpg");
    const receipt = await pat.upload(itemId, pdf(), "receipt.pdf", "document"); // no thumbnail on this server
    const report = async () => (await (await pat.as("/api/v1/plan")).json()) as PlanReport;
    const before = (await report()).fileBytes.used;

    const freed = await removeOriginals({ db: env.db, files: env.files }, pat.householdId, [shot.id, receipt.id, "someone-elses"]);
    const [p, d] = (await pat.attachments(itemId)) as unknown as Attachment[];
    expect(freed).toBe(p!.size);
    expect(p).toMatchObject({ id: shot.id, originalRemoved: true, hasThumbnail: true });
    expect(d).toMatchObject({ id: receipt.id, originalRemoved: false }); // nothing small to keep: left alone
    expect((await report()).fileBytes.used).toBe(before - p!.size);

    const content = await pat.as(`/api/v1/attachments/${shot.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/webp");
    expect(content.headers.get("x-ferret-small-copy")).toBe("1");
    expect((await pat.as(`/api/v1/attachments/${shot.id}/analyze`, { method: "POST" })).status).toBe(409);

    // Another household's attachment isn't touched.
    const sam = await env.user("sam");
    expect(await removeOriginals({ db: env.db, files: env.files }, sam.householdId, [receipt.id])).toBe(0);
  });
});
