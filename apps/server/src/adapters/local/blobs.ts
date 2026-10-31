import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    await writeFile(file, bytes);
    await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
  }

  async get(key: string): Promise<BlobObject | null> {
    const file = this.resolve(key);
    try {
      const info = await stat(file);
      const meta = JSON.parse(await readFile(`${file}.meta.json`, "utf8").catch(() => "{}")) as {
        contentType?: string;
      };
      return {
        body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
        size: info.size,
        contentType: meta.contentType ?? "application/octet-stream",
      };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }
}
