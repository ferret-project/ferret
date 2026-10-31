/**
 * Map pictures from Apple Maps Web Snapshots: a signed URL (ES256 over the
 * path and query, base64url, as the last parameter), fetched by the server.
 * Web Crypto and fetch only, so it runs on any runtime as it is.
 * https://developer.apple.com/documentation/snapshots
 */
import type { MapImages } from "../../ports";

const ORIGIN = "https://snapshot.apple-mapkit.com";
/** Web Crypto key type, without depending on DOM or Node typings (as in lib/files.ts). */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
/** Ferret's brown, for the pin. */
const PIN = { point: "center", color: "8b4a2d", markerStyle: "balloon" };

export class AppleMapSnapshots implements MapImages {
  private readonly key: Promise<Key>;

  constructor(
    private readonly teamId: string,
    private readonly keyId: string,
    /** The .p8 file's contents (PEM, with real or "\n" line breaks), or just its base64 body. */
    privateKey: string,
  ) {
    const body = privateKey.replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    this.key = crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }

  /** The signed path for an address's picture (exported for tests: the parameters, their order, the signature). */
  async signedPath(address: string, scheme: "light" | "dark") {
    const params = [
      ["center", address],
      ["z", "15"],
      ["size", "600x260"],
      ["scale", "2"],
      ["colorScheme", scheme],
      ["annotations", JSON.stringify([PIN])],
      ["teamId", this.teamId],
      ["keyId", this.keyId],
    ];
    // Each value encoded on its own; the signature covers exactly this string, so nothing may change after.
    const path = `/api/v1/snapshot?${params.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&")}`;
    const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await this.key, new TextEncoder().encode(path));
    return `${path}&signature=${base64url(new Uint8Array(raw))}`;
  }

  async snapshot(address: string, { scheme }: { scheme: "light" | "dark" }) {
    const res = await fetch(ORIGIN + (await this.signedPath(address, scheme)), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Apple Maps answered ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").startsWith("image/")) throw new Error("Apple Maps didn't send a picture");
    return new Uint8Array(await res.arrayBuffer());
  }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
