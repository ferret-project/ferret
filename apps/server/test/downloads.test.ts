/** Add from a web address: recorded at once, downloaded by a job into the item, failures kept with why. */
import type { PendingDownload } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { job } from "../src/db/schema";
import { DOWNLOAD_JOB, downloadJob } from "../src/lib/downloads";
import { FakeDownloader, setup } from "./helpers";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("pixels!")]);
const pdf = new TextEncoder().encode("%PDF-1.7 the manual");
const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");

describe("add from a web address", () => {
  it("downloads photos and PDFs into the item in the background, and keeps failures with why", async () => {
    const downloader = new FakeDownloader();
    downloader.files.set("https://cdn.example/drill.png", png);
    downloader.files.set("https://maker.example/manuals/dcd771.pdf", pdf);
    downloader.files.set("https://maker.example/product-page", html);
    const { user, db, files, deps } = await setup({ downloader });
    const ann = await user("ann");
    const bob = await user("bob");
    const drill = await ann.addItem({ name: "Cordless drill" });
    const ask = (u: typeof ann, url: string, kind?: string) =>
      u.as(`/api/v1/items/${drill.id}/downloads`, { method: "POST", body: JSON.stringify({ url, ...(kind ? { kind } : {}) }) });

    for (const url of ["https://cdn.example/drill.png", "https://maker.example/manuals/dcd771.pdf", "https://maker.example/product-page", "http://192.168.1.1/x.png"]) {
      expect((await ask(ann, url)).status).toBe(202);
    }
    expect((await ask(ann, "javascript:alert(1)")).status).toBe(422);
    expect((await ask(bob, "https://cdn.example/drill.png")).status).toBe(404); // not bob's item

    const pending = (await (await ann.as(`/api/v1/items/${drill.id}/downloads`)).json()) as { data: PendingDownload[] };
    expect(pending.data.map((d) => d.status)).toEqual(["pending", "pending", "pending", "pending"]);

    const run = downloadJob({ ...deps, files, maxBytes: 1024 * 1024 });
    for (const j of await db.select().from(job).where(eq(job.type, DOWNLOAD_JOB))) await run(JSON.parse(j.payload), { lastAttempt: false });

    // The photo and the manual arrived as attachments, each of the right kind.
    const attachments = await ann.attachments(drill.id);
    expect(attachments.map((a) => [a.kind, a.filename, a.contentType]).sort()).toEqual([
      ["document", "dcd771.pdf", "application/pdf"],
      ["photo", "drill.png", "image/png"],
    ]);
    // The web page and the private address didn't, and say why.
    const left = (await (await ann.as(`/api/v1/items/${drill.id}/downloads`)).json()) as { data: PendingDownload[] };
    expect(left.data.map((d) => [d.url, d.status, d.error])).toEqual([
      ["https://maker.example/product-page", "failed", "That isn't a photo or a PDF — it may be a web page rather than the file itself"],
      ["http://192.168.1.1/x.png", "failed", "That address is on a private network — Ferret only downloads from the internet"],
    ]);
    expect((await ann.as(`/api/v1/downloads/${left.data[0]!.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await bob.as(`/api/v1/downloads/${left.data[1]!.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("says when the server can't download", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const lamp = await ann.addItem({ name: "Lamp" });
    const res = await ann.as(`/api/v1/items/${lamp.id}/downloads`, { method: "POST", body: JSON.stringify({ url: "https://x.example/a.png" }) });
    expect(res.status).toBe(409);
  });
});
