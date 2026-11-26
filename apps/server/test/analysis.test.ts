import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { SharpImages } from "../src/adapters/local/images";
import { attachment, job } from "../src/db/schema";
import { joinPages, lineName, previewKey, printedSubtotal, readEveryLine, receiptParts, toAnalysis } from "../src/jobs/analyze";
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

  it("a crop takes its photo's reading along; a crop of a photo not read yet is read itself", async () => {
    const ai = new FakeAi([drillReply, drillReply]);
    const { jobs, user } = await setup({ ai });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    const crop = async (from: string) => {
      const form = new FormData();
      form.set("file", new File([await photo()], "drill (cropped).jpg"));
      form.set("kind", "photo");
      form.set("croppedFrom", from);
      const up = await pat.as(`/api/v1/items/${itemId}/attachments`, { method: "POST", body: form });
      expect(up.status).toBe(201);
      return (await up.json()) as { id: string; analysisStatus: string | null; analysis: { suggestions?: { serialNumber?: string } } | null };
    };

    // Read: the crop has the same reading at once, and the model isn't asked again.
    const read = await pat.upload(itemId, await photo(), "drill.jpg");
    await jobs.drain();
    const copied = await crop(read.id);
    expect(copied).toMatchObject({ analysisStatus: "done", analysis: { suggestions: { serialNumber: "2024 18 4417 AB" } } });
    await jobs.drain();
    expect(ai.calls).toHaveLength(1);

    // Still being read, and removed straight after cropping: the crop is read itself, so nothing is lost.
    const reading = await pat.upload(itemId, await photo(), "label.jpg");
    const second = await crop(reading.id);
    expect(second.analysisStatus).toBe("pending");
    expect((await pat.as(`/api/v1/attachments/${reading.id}`, { method: "DELETE" })).status).toBe(204);
    await jobs.drain();
    expect((await pat.attachments(itemId)).find((a) => a.id === second.id)).toMatchObject({ analysisStatus: "done", analysis: { suggestions: { serialNumber: "2024 18 4417 AB" } } });
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

describe("analyzing many things at once (bulk analyze)", () => {
  it("queues only what hasn't been read: never asked or failed, not read, not only a small copy", async () => {
    const ai = new FakeAi([drillReply, drillReply, drillReply, drillReply, drillReply]);
    const { db, jobs, user } = await setup({ ai });
    const pat = await user("pat");
    const drill = await pat.addItem({ name: "Drill" });
    const empty = await pat.addItem({ name: "Nothing attached" });
    const read = await pat.upload(drill.id, await photo(), "read.jpg");
    const never = await pat.upload(drill.id, await photo(), "never.jpg");
    const failed = await pat.upload(drill.id, await photo(), "failed.jpg");
    const small = await pat.upload(drill.id, await photo(), "small.jpg");
    await jobs.drain();
    expect(ai.calls).toHaveLength(4);
    await db.update(attachment).set({ analysisStatus: null }).where(eq(attachment.id, never.id));
    await db.update(attachment).set({ analysisStatus: "failed" }).where(eq(attachment.id, failed.id));
    await db.update(attachment).set({ analysisStatus: null, originalRemovedAt: new Date() }).where(eq(attachment.id, small.id));

    const res = await pat.as("/api/v1/items/bulk", { method: "POST", body: JSON.stringify({ action: "analyze", ids: [drill.id, empty.id, "made-up"] }) });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { done: number; queued: number; failed: { id: string }[] };
    expect(out).toMatchObject({ done: 2, queued: 2 });
    expect(out.failed.map((f) => f.id)).toEqual(["made-up"]);
    const status = Object.fromEntries((await pat.attachments(drill.id)).map((a) => [a.id, a.analysisStatus]));
    expect(status).toEqual({ [read.id]: "done", [never.id]: "pending", [failed.id]: "pending", [small.id]: null });

    await jobs.drain();
    expect(ai.calls).toHaveLength(6);
    // Read now: asking again queues nothing.
    const again = await pat.as("/api/v1/items/bulk", { method: "POST", body: JSON.stringify({ action: "analyze", ids: [drill.id] }) });
    expect(await again.json()).toMatchObject({ done: 1, queued: 0 });
  });

  it("queues nothing where analysis isn't set up", async () => {
    const env = await setup();
    const sam = await env.user("sam");
    const drill = await sam.addItem({ name: "Drill" });
    await sam.upload(drill.id, await photo(), "drill.jpg");
    const res = await sam.as("/api/v1/items/bulk", { method: "POST", body: JSON.stringify({ action: "analyze", ids: [drill.id] }) });
    expect(await res.json()).toMatchObject({ done: 1, queued: 0, failed: [] });
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

  it("reads a scanned PDF's first page with the vision model when docling finds no text in it", async () => {
    const ai = new FakeAi([{ ...receiptReply, description: "JET 5-year warranty card.", text: "5 YEAR WARRANTY", warrantyMonths: 60 }]);
    const documents = new FakeDocuments(["<!-- image -->\n\nScreenshot"]);
    const page = { firstPage: async () => new Uint8Array(await photo()) };
    const { jobs, user } = await setup({ ai, documents, pdfPages: page });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Dust collector" });
    await pat.upload(itemId, pdf(), "warranty.pdf", "document");
    await jobs.drain();

    expect(ai.calls).toEqual([{ prompt: expect.stringContaining("photographed document"), image: "image/jpeg" }]);
    const [a] = await pat.attachments(itemId);
    // Its text is what the vision model read, not docling's placeholder.
    expect(a).toMatchObject({ analysisStatus: "done", analysis: { description: "JET 5-year warranty card.", text: "5 YEAR WARRANTY", suggestions: { warrantyMonths: 60 } } });
  });

  it("asks the vision model about a thin page too, and keeps whichever read more of it", async () => {
    const thin = "<!-- image -->\nDate Ordered:\nNovember 03, 2026\nOrder Total:\n$3,614.32\n## Delivery";
    const page = { firstPage: async () => new Uint8Array(await photo()) };
    const fuller = "Order WN75772557\nJet JCDC-3 3HP 230-Volt Cyclone Dust Collector Kit $2,855.72\nHome Depot Protection Plan 4-Year $508.00";
    const ai = new FakeAi([{ ...receiptReply, text: fuller }, { ...receiptReply, text: "Order" }]);
    const { jobs, user } = await setup({ ai, documents: new FakeDocuments([thin, thin]), pdfPages: page });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Dust collector" });
    await pat.upload(itemId, pdf(), "order.pdf", "document");
    await jobs.drain();
    expect((await pat.attachments(itemId))[0]).toMatchObject({ analysis: { text: fuller } });
    // The vision model read less than docling did: docling's text stays.
    const { id: other } = await pat.addItem({ name: "Mixer" });
    await pat.upload(other, pdf("two"), "other.pdf", "document");
    await jobs.drain();
    expect((await pat.attachments(other))[0]).toMatchObject({ analysis: { text: thin } });
  });

  it("reads PDFs with the vision model when there's no docling but pages can be drawn", async () => {
    const ai = new FakeAi([receiptReply]);
    const { jobs, user } = await setup({ ai, pdfPages: { firstPage: async () => new Uint8Array(await photo()) } });
    const pat = await user("pat");
    const { id: itemId } = await pat.addItem({ name: "Drill" });
    expect((await pat.upload(itemId, pdf(), "receipt.pdf", "document")).analysisStatus).toBe("pending");
    await jobs.drain();
    expect(ai.calls).toEqual([{ prompt: expect.stringContaining("photographed document"), image: "image/jpeg" }]);
    expect((await pat.attachments(itemId))[0]).toMatchObject({ analysis: { suggestions: { purchasePriceCents: 12900 } } });
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

    expect(toAnalysis({ description: "Best Buy receipt.", returnDays: 15, returnBy: "2026-03-19" }).suggestions).toEqual({ returnDays: 15, returnBy: "2026-03-19" });
    expect(toAnalysis({ description: "x", returnDays: 0, returnBy: "within 15 days" }).suggestions).toEqual({});

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
    // A category only if it's one of the household's; receipt lines only when there are several products.
    const lookup = new Map([["tools › power tools", "cat-1"], ["power tools", "cat-1"]]);
    expect(toAnalysis({ description: "x", category: "Power Tools" }, { lookup }).suggestions).toEqual({ categoryId: "cat-1" });
    expect(toAnalysis({ description: "x", category: "Kitchen" }, { lookup }).suggestions).toEqual({});
    const order = toAnalysis({
      description: "Costco receipt.",
      lines: [
        { name: "Stand mixer", brand: "KitchenAid", model: null, quantity: 1, price: 299.99 },
        { name: "Air fryer", brand: null, model: "AF101", quantity: 2, price: 89.5 },
        { name: "x", quantity: 1, price: 3 }, // too short: dropped
      ],
    });
    expect(order.suggestions.lines).toEqual([
      { name: "Stand mixer", brand: "KitchenAid", quantity: 1, priceCents: 29999 },
      { name: "Air fryer", model: "AF101", quantity: 2, priceCents: 8950 },
    ]);
    expect(toAnalysis({ description: "x", lines: [{ name: "Stand mixer", quantity: 1, price: 299.99 }] }).suggestions).toEqual({});

    // The model puts the dearest product at the top and leaves it out of the lines (mistral-small, 5 runs of 5):
    // it goes back in first, or "Add the things on this receipt" would lose it.
    const slip = toAnalysis({
      description: "A till receipt.",
      name: "Blender",
      brand: "Vitamix",
      model: "E310",
      purchaseDate: "2026-11-14",
      purchasePrice: 349.95,
      lines: [
        { name: "Dutch oven", brand: "Lodge", model: null, quantity: 1, price: 79.9 },
        { name: "Kitchen scale", brand: "OXO", model: null, quantity: 1, price: 49.99 },
      ],
      sure: ["name", "purchaseDate", "purchasePrice"],
    });
    expect(slip.suggestions.lines).toEqual([
      { name: "Blender", brand: "Vitamix", model: "E310", quantity: 1, priceCents: 34995 },
      { name: "Dutch oven", brand: "Lodge", quantity: 1, priceCents: 7990 },
      { name: "Kitchen scale", brand: "OXO", quantity: 1, priceCents: 4999 },
    ]);
    // Already one of the lines (here by price): not added twice. One product at the top + one line = two things.
    expect(toAnalysis({ description: "x", name: "Blender", purchasePrice: 349.95, lines: [{ name: "Vitamix blender", quantity: 1, price: 349.95 }, { name: "Dutch oven", quantity: 1, price: 79.9 }] }).suggestions.lines).toHaveLength(2);
    expect(toAnalysis({ description: "x", name: "Blender", purchasePrice: 349.95, lines: [{ name: "Dutch oven", quantity: 1, price: 79.9 }] }).suggestions.lines?.map((l) => l.name)).toEqual(["Blender", "Dutch oven"]);
    // Others name the document itself, at its total (qwen3-vl): no "Receipt" line.
    const kitchen = [
      { name: "Vitamix Blender", quantity: 1, price: 349.95 },
      { name: "Oxo Good Grips Peeler", quantity: 2, price: 9.99 },
    ];
    expect(toAnalysis({ description: "x", name: "Receipt", purchasePrice: 395.12, lines: kitchen }).suggestions.lines).toHaveLength(2);
    expect(toAnalysis({ description: "x", name: "Sales receipt", lines: kitchen }).suggestions.lines).toHaveLength(2);
    // A price that's exactly the lines' sum is the subtotal, whatever it's called.
    expect(toAnalysis({ description: "x", name: "Kitchen shopping", purchasePrice: 369.93, lines: kitchen }).suggestions.lines).toHaveLength(2);

    expect(manual.suggestions.maintenance).toEqual([
      { title: "Replace the air filter", intervalCount: 3, intervalUnit: "month" },
      { title: "Have it serviced", intervalCount: 1, intervalUnit: "year" },
    ]);
  });
});

describe("every product on a long receipt", () => {
  const row = (name: string, sku: string, price: string, total: string) => `${name}\nSKU: ${sku}\n1 $${price}\nTAX(1%)\n$0.10 $${total}`;

  it("cuts its text into parts after a row's last amount, keeping every line", () => {
    const text = Array.from({ length: 40 }, (_, i) => row(`PLA Basic ${i}`, `A00-${i}`, "14.99", "9.74")).join("\n");
    const parts = receiptParts(text, 600);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts.slice(0, -1)) expect(part).toMatch(/\$9\.74$/);
    expect(parts.join("\n")).toBe(text);
  });

  it("joins pages without the column names each one starts with", () => {
    const heading = "Items Qty Price\nSubTotal";
    const pages = [`INVOICE\n${heading}\n${row("PLA Basic", "A00-Y4", "14.99", "9.74")}`, `${heading}\nVariant: Gold\n${row("PLA Basic", "A00-G3", "14.99", "9.74")}`];
    const text = joinPages(pages);
    expect(text.match(/Items Qty Price/g)).toHaveLength(1);
    // The variant cut off by the page break follows its product's row straight away.
    expect(text).toContain("$0.10 $9.74\nVariant: Gold");
  });

  it("tidies names of codes, packaging and a variant that repeats the name", () => {
    expect(lineName("ABS-GF, Orange (41300) / Filament with spool / 1 kg")).toBe("ABS-GF, Orange");
    expect(lineName("Maker's Supply Flush Cutter, Flush Cutter")).toBe("Maker's Supply Flush Cutter");
    expect(lineName("Gift, PETG Matte, Lime")).toBe("PETG Matte, Lime");
    expect(lineName("Stand mixer")).toBe("Stand mixer");
  });

  it("prices each at its line's total after discounts, shared out; a gift at nothing; tells same-named ones apart", () => {
    const a = toAnalysis({
      description: "x",
      lines: [
        { name: "PLA Silk+, Gold", model: "A06-Y1", quantity: 1, price: 18.99, total: 12.34 },
        { name: "Acrylic Kit", model: "B-ZE016", quantity: 2, price: 89, total: 124.58 },
        { name: "Mini SUV", model: "B-ZK012", quantity: 2, price: 49.99, total: 0 },
        { name: "Focusing Lens", model: "SLA099", fits: "R1", quantity: 1, price: 30.99, total: 30.99 },
        { name: "Focusing Lens", model: "SLA100", fits: "R1", quantity: 1, price: 31.99, total: 31.99 },
        { name: "PLA Basic, Blue", model: "A00-B9", quantity: 1, price: 17.99, total: 11.69 },
        { name: "PLA Basic, Blue", model: "A00-B9", quantity: 1, price: 17.99, total: 0 },
      ],
      parts: [{ name: "Flush cutter", partNumber: "B-QA018", packSize: null }],
    }).suggestions;
    expect(a.lines?.map((l) => [l.name, l.priceCents])).toEqual([
      ["PLA Silk+, Gold", 1234],
      ["Acrylic Kit", 6229],
      ["Mini SUV", 0],
      ["Focusing Lens, SLA099", 3099],
      ["Focusing Lens, SLA100", 3199],
      // One bought, the same one free: one model, nothing to tell apart.
      ["PLA Basic, Blue", 1169],
      ["PLA Basic, Blue", 0],
    ]);
    expect(a.lines?.[3]?.fits).toBe("R1");
    // A receipt's products aren't a manual's spare parts.
    expect(a.parts).toBeUndefined();
  });

  it("finds the subtotal a receipt prints, in its own style", () => {
    expect(printedSubtotal("SUBTOTAL 536.35\nTAX 29.94\n**** TOTAL 566.29")).toBe(536.35);
    expect(printedSubtotal("Items Subtotal $1073.68\nShipping $0.00")).toBe(1073.68);
    expect(printedSubtotal("Subtotal (9 Items) $6,469.91")).toBe(6469.91);
    expect(printedSubtotal("Zwischensumme\nSub-total: 1.234,56 EUR")).toBe(1234.56);
    expect(printedSubtotal("Order Total 9.99")).toBeNull();
  });

  it("doesn't take a summing-up name with no price for a product", () => {
    const lines = [{ name: "Rotary Attachment", quantity: 1, price: 275.99 }, { name: "Focusing Lens", quantity: 1, price: 30.99 }];
    expect(toAnalysis({ description: "x", name: "3D printing supplies", lines }).suggestions.lines).toHaveLength(2);
  });

  it("reads again in parts of other sizes while the products don't add up to the subtotal, and keeps the closest", async () => {
    const text = Array.from({ length: 12 }, (_, i) => row(`PLA ${i}`, `A00-${i}`, "14.99", "9.74")).join("\n");
    const all = Array.from({ length: 12 }, (_, i) => ({ name: `PLA ${i}`, model: `A00-${i}`, quantity: 1, price: 14.99, total: 9.74 }));
    // Each part lists the products whose rows are in it — except that the first read leaves out its last part's.
    let reads = 0;
    const efforts: (string | undefined)[] = [];
    const model = {
      async json(req: { prompt: string; effort?: string }) {
        const [, part, parts] = /part (\d+) of (\d+)/.exec(req.prompt)!.map(Number);
        if (part === 1) {
          reads++;
          efforts.push(req.effort);
        }
        const document = req.prompt.slice(req.prompt.indexOf("<document>"), req.prompt.indexOf("</document>"));
        const mine = all.filter((l) => document.includes(`SKU: ${l.model}\n`));
        return { lines: reads === 1 && part === parts ? [] : mine };
      },
    };
    const lines = await readEveryLine(model, text, "USD", undefined, 116.88);
    expect(lines).toHaveLength(12);
    expect(lines.reduce((s, l) => s + (l.priceCents ?? 0), 0)).toBe(11688);
    expect(reads).toBe(2);
    // The second read thinks harder.
    expect(efforts).toEqual([undefined, "medium"]);
  });
});
