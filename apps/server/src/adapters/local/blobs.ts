import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { BlobObject, Blobs } from "../../ports";

/** Photos and documents as plain files in a folder (e.g. a NAS dataset) (the Blobs port). */
export class FsBlobs implements Blobs {
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid blob key");
    return full;
  }

  async put(key: string, data: ReadableStream<Uint8Array> | Uint8Array, contentType: string) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
    // Both written beside their real names, then renamed, the file itself last: a crash leaves stray .partial files,
    // never a half-written file (or one without its content type) under the real name.
    const part = `.${randomUUID()}.partial`;
    await writeFile(file + part, bytes);
    await writeFile(`${file}.meta.json${part}`, JSON.stringify({ contentType }));
    await rename(`${file}.meta.json${part}`, `${file}.meta.json`);
    await rename(file + part, file);
  }

  async get(key: string): Promise<BlobObject | null> {
    const file = this.resolve(key);
    // Only a file that isn't there is "not found": a permission problem or a broken disk is an error, not a miss.
    const info = await stat(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    });
    if (!info) return null;
    // The content type is a hint (files are sniffed on the way in): an unreadable one falls back.
    let contentType = "application/octet-stream";
    try {
      contentType = (JSON.parse(await readFile(`${file}.meta.json`, "utf8")) as { contentType?: string }).contentType ?? contentType;
    } catch {}
    return {
      body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      size: info.size,
      contentType,
    };
  }

  async delete(key: string) {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }
}
