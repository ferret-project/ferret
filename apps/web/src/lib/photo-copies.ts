/**
 * A photo's smaller copies, made here before it's uploaded: its thumbnail and the copy the vision model looks at. The
 * server makes them otherwise (lib/attachments.ts on the server) — but the phone has the photo decoded
 * anyway, and that saves the server the work. Anything that fails here just leaves it to the server.
 */

/** Longest sides, as the server makes them (THUMBNAIL_PX, VISION_PX). */
const THUMBNAIL_PX = 600;
const PREVIEW_PX = 1600;

export interface PhotoCopies {
  thumbnail?: Blob;
  preview?: Blob;
}

export async function photoCopies(file: Blob): Promise<PhotoCopies> {
  if (file.type && !file.type.startsWith("image/")) return {};
  let bitmap: ImageBitmap;
  try {
    // Upright: createImageBitmap applies the photo's EXIF orientation. Canvas output carries no metadata (no GPS).
    bitmap = await createImageBitmap(file);
  } catch {
    return {}; // a format this browser can't decode
  }
  try {
    return {
      // WebP where the browser can write it (Safari can't: JPEG then).
      thumbnail: await shrink(bitmap, THUMBNAIL_PX, ["image/webp", "image/jpeg"], 0.8),
      preview: await shrink(bitmap, PREVIEW_PX, ["image/jpeg"], 0.85),
    };
  } catch {
    return {};
  } finally {
    bitmap.close();
  }
}

async function shrink(bitmap: ImageBitmap, longest: number, types: string[], quality: number) {
  const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const offscreen = typeof OffscreenCanvas !== "undefined";
  const canvas = offscreen ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return undefined;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  for (const type of types) {
    const blob =
      canvas instanceof HTMLCanvasElement
        ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
        : await canvas.convertToBlob({ type, quality });
    // A browser that can't write the type quietly writes PNG instead: try the next one.
    if (blob?.type === type) return blob;
  }
  return undefined;
}
