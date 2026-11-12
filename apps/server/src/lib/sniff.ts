/**
 * Detects a file's real type from its first bytes, so we never trust (or
 * serve back) whatever Content-Type the uploader claimed.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    // AVIF (stores' product photos often are): the major brand, or a compatible one after a generic "mif1".
    const boxEnd = Math.min(((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0, bytes.length, 64);
    const compatible = Array.from({ length: Math.max(0, Math.floor((boxEnd - 16) / 4)) }, (_, i) => ascii(16 + i * 4, 20 + i * 4));
    if (["avif", "avis"].includes(brand) || compatible.some((b) => b === "avif" || b === "avis")) return "image/avif";
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return null;
}
