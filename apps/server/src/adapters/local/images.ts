import sharp from "sharp";
import type { Images } from "../../ports";

/** Resizing with sharp (libvips) — the Images port. */
export class SharpImages implements Images {
  async resize(data: Uint8Array, maxSize: number, format: "webp" | "jpeg") {
    try {
      const out = await sharp(data, { failOn: "error", limitInputPixels: 100_000_000 })
        .rotate() // apply EXIF orientation; metadata is dropped by default
        .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
        .toFormat(format, { quality: format === "webp" ? 75 : 85 })
        .toBuffer();
      return new Uint8Array(out);
    } catch {
      return null; // undecodable (e.g. HEVC-encoded HEIC) — callers fall back to the original
    }
  }
}
