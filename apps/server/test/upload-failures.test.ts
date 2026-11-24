/** An upload that fails part-way leaves no files behind; a thumbnail that can't be made doesn't fail it. */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTableName } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { FsBlobs } from "../src/adapters/local/blobs";
import { setup } from "./helpers";

/** Every file under a folder, recursively. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
}

const photo = () => sharp({ create: { width: 40, height: 30, channels: 3, background: "#a0522d" } }).png().toBuffer().then((b) => new Uint8Array(b));

describe("uploads that go wrong", () => {
  it("keep the photo when its thumbnail can't be made", async () => {
    const { user, deps } = await setup();
    const ann = await user("ann");
    const lamp = await ann.addItem({ name: "Lamp" });
    vi.spyOn(deps.images, "resize").mockRejectedValueOnce(new Error("broken image library"));
    await ann.upload(lamp.id, await photo(), "lamp.png");
    const [got] = await ann.attachments(lamp.id);
    expect(got).toMatchObject({ filename: "lamp.png" });
    expect(got!.hasThumbnail).toBe(false);
  });

  it("leave no files behind when the row can't be saved", async () => {
    const { user, deps, db } = await setup();
    const ann = await user("ann");
    const lamp = await ann.addItem({ name: "Lamp" });
    const root = (deps.blobs as unknown as { root: string }).root;
    const before = filesIn(root).length;
    const insert = db.insert.bind(db);
    const spy = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
      const q = insert(table);
      if (getTableName(table) !== "attachment") return q;
      return { values: () => ({ returning: () => Promise.reject(new Error("disk full")) }) } as unknown as typeof q;
    }) as typeof db.insert);
    const form = new FormData();
    form.set("file", new File([await photo()], "lamp.png"));
    form.set("kind", "photo");
    const res = await ann.as(`/api/v1/items/${lamp.id}/attachments`, { method: "POST", body: form });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(filesIn(root).length).toBe(before);
  });
});

describe("FsBlobs.get", () => {
  it("falls back on an unreadable content type, but doesn't call a permission error 'not found'", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ferret-blobs-"));
    const blobs = new FsBlobs(root);
    await blobs.put("h/a", new Uint8Array([1]), "image/png");
    writeFileSync(path.join(root, "h/a.meta.json"), "{not json");
    expect((await blobs.get("h/a"))?.contentType).toBe("application/octet-stream");

    if (process.getuid?.() === 0) return; // root reads anything
    mkdirSync(path.join(root, "locked"));
    await blobs.put("locked/b", new Uint8Array([1]), "image/png");
    chmodSync(path.join(root, "locked"), 0o000);
    try {
      await expect(blobs.get("locked/b")).rejects.toThrow();
    } finally {
      chmodSync(path.join(root, "locked"), 0o755);
    }
  });
});
