/**
 * Barcode decoding: the browser's own BarcodeDetector where it exists (Chrome,
 * Android), otherwise zxing compiled to WASM (iPhone Safari has no
 * BarcodeDetector). The WASM is bundled with the app — no CDN — and only loaded
 * the first time someone scans.
 */
type Detector = { detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]> };

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"];

let detector: Promise<Detector> | undefined;

export function getDetector() {
  detector ??= (async () => {
    const Native = (globalThis as { BarcodeDetector?: { new (o: object): Detector; getSupportedFormats(): Promise<string[]> } })
      .BarcodeDetector;
    if (Native) {
      const supported = await Native.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes("ean_13")) return new Native({ formats });
    }
    const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
      import("barcode-detector/ponyfill"),
      import("zxing-wasm/reader/zxing_reader.wasm?url"),
    ]);
    prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
      fireImmediately: true,
    });
    return new BarcodeDetector({ formats: FORMATS as never });
  })();
  return detector;
}

/** The first barcode in an image or video frame, or null. */
export async function readBarcode(source: ImageBitmapSource): Promise<string | null> {
  const found = await (await getDetector()).detect(source);
  return found[0]?.rawValue.trim() || null;
}
