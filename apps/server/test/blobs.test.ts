/** The folder-backed Blobs port: files appear under their real names only once fully written. */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FsBlobs } from "../src/adapters/local/blobs";

describe("FsBlobs", () => {
  it("writes a file and its content type, leaving nothing half-written behind", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ferret-blobs-"));
    const blobs = new FsBlobs(root);
    await blobs.put("h1/a.jpg", new Uint8Array([1, 2, 3]), "image/jpeg");
    await blobs.put("h1/a.jpg", new Uint8Array([4, 5]), "image/png"); // replaced in place

    expect(readdirSync(path.join(root, "h1")).sort()).toEqual(["a.jpg", "a.jpg.meta.json"]);
    const got = await blobs.get("h1/a.jpg");
    expect(got?.contentType).toBe("image/png");
    expect(new Uint8Array(await new Response(got!.body).arrayBuffer())).toEqual(new Uint8Array([4, 5]));

    await blobs.delete("h1/a.jpg");
    expect(readdirSync(path.join(root, "h1"))).toEqual([]);
    expect(await blobs.get("h1/a.jpg")).toBeNull();
  });

  it("refuses keys outside its folder", async () => {
    const blobs = new FsBlobs(mkdtempSync(path.join(tmpdir(), "ferret-blobs-")));
    await expect(blobs.put("../x", new Uint8Array([1]), "text/plain")).rejects.toThrow("Invalid blob key");
  });
});
