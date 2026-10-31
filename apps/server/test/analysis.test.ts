import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { SharpImages } from "../src/adapters/local/images";
import { attachment, job } from "../src/db/schema";
import { previewKey, toAnalysis } from "../src/jobs/analyze";
import { FakeAi, FakeDocuments, pdf, photo, setup } from "./helpers";

const drillReply = {
  description: "A yellow DeWalt cordless drill.",
  text: "DEWALT\nModel: DCD771C2\nS/N: 2024 18 4417 AB",
  name: "Cordless drill",
  brand: "DEWALT",
  model: "DCD771C2",
  serialNumber: "2024 18 4417 AB",
  barcode: null,
  purchaseDate: null,
  purchasePrice: null,
};

const receiptReply = {
  description: "Home Depot receipt for a DeWalt drill kit.",
  text: "",
  name: "Drill kit",
  brand: "DEWALT",
  model: "DCD771C2",
  serialNumber: null,
  barcode: null,
  purchaseDate: "2026-03-14",
  purchasePrice: 129,
};
const receiptMarkdown = "THE HOME DEPOT\n\nDEWALT 20V DRILL KIT\n\nDCD771C2 129.00\n\nTOTAL 138.35";

describe("photo analysis", () => {
  it("analyses uploads in the background and stores suggestions", async () => {
    const ai = new FakeAi([drillReply]);
    const { jobs, user } = await setup({ ai });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });

    const uploaded = await pat.upload(itemId, await photo(), "drill.jpg");
    expect(uploaded.analysisStatus).toBe("pending"); // the upload doesn't wait for the model
    expect(ai.calls).toHaveLength(0);

    await jobs.drain();
    expect(ai.calls).toEqual([{ prompt: expect.stringContaining("household inventory"), image: "image/jpeg" }]);
    const [a] = await pat.attachments(itemId);
    expect(a).toMatchObject({
      analysisStatus: "done",
      analysis: {
        description: "A yellow DeWalt cordless drill.",
        text: expect.stringContaining("DCD771C2"),
        suggestions: { name: "Cordless drill", brand: "DEWALT", model: "DCD771C2", serialNumber: "2024 18 4417 AB" },
      },
    });
  });

  it("uses the browser's own thumbnail and vision copy, so the server resizes nothing", async () => {
    const ai = new FakeAi([drillReply]);
    const { jobs, user, files, db } = await setup({ ai });
    const resize = vi.spyOn(SharpImages.prototype, "resize");
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    const thumbnail = new Uint8Array(await sharp({ create: { width: 600, height: 450, channels: 3, background: "#ffd400" } }).jpeg().toBuffer());
    const preview = new Uint8Array(await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#ffd400" } }).jpeg().toBuffer());
    const form = new FormData();
    form.set("file", new File([await photo()], "drill.jpg"));
    form.set("kind", "photo");
    form.set("thumbnail", new File([thumbnail], "thumbnail.jpg"));
    form.set("preview", new File([preview], "preview.jpg"));
    const res = await pat.as(`/api/v1/items/${itemId}/attachments`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    // The thumbnail is the browser's (JPEG: Safari can't write WebP), served as what it is.
    const thumb = await pat.as(`/api/v1/attachments/${id}/thumbnail`);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(thumbnail);

    // The model looks at the browser's copy; once analysed, it's removed.
    await jobs.drain();
    expect(ai.calls).toEqual([{ prompt: expect.stringContaining("household inventory"), image: "image/jpeg" }]);
    expect(resize).not.toHaveBeenCalled();
    const [row] = await db.select().from(attachment).where(eq(attachment.id, id));
    expect(await files.get(row!.householdId, previewKey(row!.blobKey))).toBeNull();
    resize.mockRestore();
  });

  it("makes its own copies when the browser's aren't small images", async () => {
    const ai = new FakeAi([drillReply]);
    const { jobs, user } = await setup({ ai });
    const resize = vi.spyOn(SharpImages.prototype, "resize");
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    const form = new FormData();
    form.set("file", new File([await photo()], "drill.jpg"));
    form.set("thumbnail", new File([new TextEncoder().encode("<svg onload=alert(1)>")], "thumbnail.svg"));
    form.set("preview", new File([new Uint8Array(3_000_000)], "preview.jpg"));
    const res = await pat.as(`/api/v1/items/${itemId}/attachments`, { method: "POST", body: form });
    const { id } = (await res.json()) as { id: string };
    expect((await pat.as(`/api/v1/attachments/${id}/thumbnail`)).headers.get("content-type")).toBe("image/webp");
    await jobs.drain();
    expect(resize).toHaveBeenCalledTimes(2); // the thumbnail, and the vision copy
    resize.mockRestore();
  });

  it("retries when the model is busy, then succeeds", async () => {
    const ai = new FakeAi([new Error("503 busy"), drillReply]);
    const { db, jobs, user } = await setup({ ai });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    await pat.upload(itemId, await photo(), "drill.jpg");

    await jobs.drain();
    const [waiting] = await db.select().from(job);
    expect(waiting).toMatchObject({ status: "pending", attempts: 1, lastError: "503 busy" });
    expect(waiting!.runAt.getTime()).toBeGreaterThan(Date.now()); // backed off, not hammering the model server
    expect((await pat.attachments(itemId))[0]!.analysisStatus).toBe("pending");

    await db.update(job).set({ runAt: new Date() }).where(eq(job.id, waiting!.id)); // time passes…
    await jobs.drain();
    expect((await pat.attachments(itemId))[0]!.analysisStatus).toBe("done");
    expect(await db.select().from(job)).toHaveLength(0); // finished jobs are cleaned up
  });

  it("gives up after the last attempt", async () => {
    const ai = new FakeAi([new Error("connection refused")]);
    const { db, jobs, user } = await setup({ ai, maxAttempts: 3, baseDelayMs: 0 });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    await pat.upload(itemId, await photo(), "drill.jpg");
    await jobs.drain();
    expect(ai.calls).toHaveLength(3);
    expect((await pat.attachments(itemId))[0]!.analysisStatus).toBe("failed");
    expect(await db.select().from(job)).toMatchObject([{ status: "failed", attempts: 3 }]);
  });

  it("marks undecodable images failed without bothering the model", async () => {
    const ai = new FakeAi([drillReply]);
    const { jobs, user } = await setup({ ai });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    await pat.upload(itemId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), "odd.png");
    await jobs.drain();
    expect(ai.calls).toHaveLength(0);
    expect((await pat.attachments(itemId))[0]!.analysisStatus).toBe("failed");
  });

  it("skips PDFs without docling, and everything when nothing is configured", async () => {
    const withAi = await setup({ ai: new FakeAi([drillReply]) });
    const pat = await withAi.user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    expect((await pat.upload(itemId, pdf(), "r.pdf", "document")).analysisStatus).toBeNull();

    const without = await setup();
    const sam = await without.user("sam");
    const { id: samItem } = await sam.addItem({ name: "Drill" });
    const plain = await sam.upload(samItem, await photo(), "drill.jpg");
    expect(plain.analysisStatus).toBeNull();
    expect((await sam.as(`/api/v1/attachments/${plain.id}/analyze`, { method: "POST" })).status).toBe(409);
  });

  it("can dismiss suggestions and re-run analysis", async () => {
    const ai = new FakeAi([drillReply]);
    const { jobs, user } = await setup({ ai });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    const { id } = await pat.upload(itemId, await photo(), "drill.jpg");
    await jobs.drain();

    expect((await pat.as(`/api/v1/attachments/${id}/dismiss-suggestions`, { method: "POST" })).status).toBe(204);
    expect((await pat.attachments(itemId))[0]!.suggestionsDismissedAt).not.toBeNull();

    const again = await pat.as(`/api/v1/attachments/${id}/analyze`, { method: "POST" });
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ analysisStatus: "pending", suggestionsDismissedAt: null });
    await jobs.drain();
    expect(ai.calls).toHaveLength(2);
  });
});

describe("document analysis (docling)", () => {
  it("transcribes a PDF with docling, then reads suggestions from the text", async () => {
    const ai = new FakeAi([receiptReply]);
    const documents = new FakeDocuments([receiptMarkdown]);
    const { jobs, user } = await setup({ ai, documents });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });

    expect((await pat.upload(itemId, pdf(), "receipt.pdf", "document")).analysisStatus).toBe("pending");
    await jobs.drain();

    expect(documents.calls).toEqual(["receipt.pdf"]);
    // Text-only: the model gets docling's Markdown, fenced off as data — no image.
    expect(ai.calls).toEqual([{ prompt: expect.stringContaining(`<document>\n${receiptMarkdown}\n</document>`), image: undefined }]);
    const [a] = await pat.attachments(itemId);
    expect(a).toMatchObject({
      analysisStatus: "done",
      analysis: {
        description: "Home Depot receipt for a DeWalt drill kit.",
        text: receiptMarkdown, // docling's transcription is what's stored
        suggestions: { name: "Drill kit", purchaseDate: "2026-03-14", purchasePriceCents: 12900 },
      },
    });
  });

  it("uses docling's text and the vision model's suggestions for document photos", async () => {
    const ai = new FakeAi([{ ...receiptReply, text: "THE HOME DEPOT" }]);
    const documents = new FakeDocuments([receiptMarkdown]);
    const { jobs, user } = await setup({ ai, documents });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    await pat.upload(itemId, await photo(), "receipt.jpg", "document");
    await jobs.drain();

    expect(ai.calls).toEqual([{ prompt: expect.stringContaining("photographed document"), image: "image/jpeg" }]);
    const [a] = await pat.attachments(itemId);
    expect(a).toMatchObject({ analysis: { text: receiptMarkdown, suggestions: { purchasePriceCents: 12900 } } });
  });

  it("stores docling's text even without a model, and retries when docling fails", async () => {
    const documents = new FakeDocuments([new Error("docling returned 503"), "# Owner's manual\n\nKeep dry."]);
    const { db, jobs, user } = await setup({ documents });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Mixer" });
    await pat.upload(itemId, pdf("manual"), "manual.pdf", "document");

    await jobs.drain();
    expect(await db.select().from(job)).toMatchObject([{ type: "document.analyze", status: "pending", attempts: 1 }]);
    await db.update(job).set({ runAt: new Date() });
    await jobs.drain();
    const [a] = await pat.attachments(itemId);
    expect(a).toMatchObject({ analysisStatus: "done", analysis: { text: "# Owner's manual\n\nKeep dry.", suggestions: {} } });
  });
});

describe("toAnalysis", () => {
  it("keeps what's well-formed and drops guesses that aren't", () => {
    const a = toAnalysis({
      description: " Receipt from a hardware store. ",
      text: "TOTAL 129.99",
      name: "Cordless drill",
      brand: "",
      model: null,
      serialNumber: "  ",
      barcode: "0 28877-58032 4",
      purchaseDate: "2026-03-04",
      purchasePrice: 129.99,
    });
    expect(a).toEqual({
      description: "Receipt from a hardware store.",
      text: "TOTAL 129.99",
      suggestions: { name: "Cordless drill", barcode: "028877580324", purchaseDate: "2026-03-04", purchasePriceCents: 12999 },
    });

    const junk = toAnalysis({ description: 42, purchaseDate: "March 4th", purchasePrice: -5, barcode: "12" });
    expect(junk).toEqual({ description: "", text: "", suggestions: {} });

    const manual = toAnalysis({
      description: "Furnace manual.",
      maintenance: [
        { task: "Replace the air filter", every: 3, unit: "month" },
        { task: "Inspect burners", every: 1, unit: "fortnight" }, // not a unit we know: dropped
        "check it sometimes",
        { task: "Have it serviced", every: 1, unit: "year" },
      ],
    });
    expect(manual.suggestions.maintenance).toEqual([
      { title: "Replace the air filter", intervalCount: 3, intervalUnit: "month" },
      { title: "Have it serviced", intervalCount: 1, intervalUnit: "year" },
    ]);
  });
});
