/** A PDF's thumbnail is its first page — drawn in a job, for new uploads and (once) for older ones. */
import { describe, expect, it } from "vitest";
import { PdfJsPages } from "../src/adapters/local/pdf";
import { PDF_BACKFILL_JOB, PDF_THUMB_JOB, pdfThumbnail, pdfThumbnailBackfill } from "../src/jobs/pdf-thumbnail";
import { pdf, realPdf, setup } from "./helpers";

type Doc = { id: string; filename: string; hasThumbnail: boolean };

describe("PDF thumbnails", () => {
  it("draw the first page of a new PDF; a damaged one keeps its icon", async () => {
    const { user, jobs } = await setup({ pdfPages: new PdfJsPages() });
    const ann = await user("ann");
    const drill = await ann.addItem({ name: "Drill" });
    const receipt = await ann.upload(drill.id, realPdf(), "receipt.pdf", "document");
    const broken = await ann.upload(drill.id, pdf("not really a pdf"), "broken.pdf", "document");
    await jobs.drain();

    const docs = (await (await ann.as(`/api/v1/items/${drill.id}/attachments`)).json()) as { data: Doc[] };
    const by = (id: string) => docs.data.find((d) => d.id === id)!;
    expect(by(receipt.id).hasThumbnail).toBe(true);
    expect(by(broken.id).hasThumbnail).toBe(false);
    const thumb = await ann.as(`/api/v1/attachments/${receipt.id}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
  });

  it("are made for PDFs from before, once", async () => {
    // Uploaded while thumbnails were off…
    const before = await setup();
    const ann = await before.user("ann");
    const drill = await ann.addItem({ name: "Drill" });
    const receipt = await ann.upload(drill.id, realPdf(), "receipt.pdf", "document");
    await before.jobs.drain();
    const list = async () => ((await (await ann.as(`/api/v1/items/${drill.id}/attachments`)).json()) as { data: Doc[] }).data;
    expect((await list()).find((d) => d.id === receipt.id)!.hasThumbnail).toBe(false);
    // …then the catch-up runs (as at startup, with them on).
    before.jobs.register({ [PDF_THUMB_JOB]: pdfThumbnail({ db: before.db, files: before.files, pdfPages: new PdfJsPages(), images: before.deps.images }), [PDF_BACKFILL_JOB]: pdfThumbnailBackfill({ db: before.db, jobs: before.jobs }) });
    await before.jobs.enqueue(PDF_BACKFILL_JOB, {});
    await before.jobs.drain();
    expect((await list()).find((d) => d.id === receipt.id)!.hasThumbnail).toBe(true);
  });
});
