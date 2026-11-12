/** File types are sniffed from their first bytes, never taken from the uploader. */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sniffContentType } from "../src/lib/sniff";

/** An ISO-BMFF "ftyp" box: size, "ftyp", major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[]) {
  const text = `ftyp${major}\0\0\0\0${compatible.join("")}`;
  const size = 4 + text.length;
  return new Uint8Array([0, 0, 0, size, ...Array.from(text, (c) => c.charCodeAt(0)), 0, 0, 0, 8]);
}

describe("sniffing AVIF", () => {
  it("knows AVIF by its major brand, or by a compatible brand after a generic mif1", () => {
    expect(sniffContentType(ftyp("avif", ["mif1", "miaf"]))).toBe("image/avif");
    expect(sniffContentType(ftyp("avis", ["msf1"]))).toBe("image/avif");
    expect(sniffContentType(ftyp("mif1", ["mif1", "avif", "miaf"]))).toBe("image/avif");
  });

  it("still tells HEIC and HEIF apart from it", () => {
    expect(sniffContentType(ftyp("heic", ["mif1", "heic"]))).toBe("image/heic");
    expect(sniffContentType(ftyp("mif1", ["mif1", "heic"]))).toBe("image/heif");
  });

  it("reads a real AVIF that sharp made, and the server can make a thumbnail of it", async () => {
    const avif = new Uint8Array(await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c33" } }).avif().toBuffer());
    expect(sniffContentType(avif)).toBe("image/avif");
    const { SharpImages } = await import("../src/adapters/local/images");
    const thumb = await new SharpImages().resize(avif, 20, "webp");
    expect(thumb && sniffContentType(thumb)).toBe("image/webp");
  });
});
