/**
 * Downloads for "add a photo or document from a web address", for Node. The
 * guard against being pointed at the LAN (SSRF):
 *
 * - http/https only, on ports 80 and 443 only; no credentials in the URL.
 * - Every address the name resolves to is checked when the connection is made
 *   (a custom `lookup`), so a name can't resolve to something public when
 *   checked and to 192.168.x when connecting (DNS rebinding). IP-literal URLs
 *   skip DNS, so they're checked up front too.
 * - Redirects are followed by hand (at most 5), each hop checked the same way.
 * - No cookies or auth sent; a size cap and an overall timeout.
 * - Only the file types asked for: a declared Content-Type outside the list
 *   (HTML, JavaScript, SVG, JSON…) is refused before any of the body is read,
 *   and the first bytes must carry a real file signature, or it stops there.
 *   Nothing downloaded is ever run or rendered here.
 */
import { lookup as dnsLookup } from "node:dns";
import type { IncomingMessage } from "node:http";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { DownloadError, type Downloader } from "../../ports";

/** Everything that isn't the public internet. */
const internal = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT (and Tailscale)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  internal.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible ::a.b.c.d
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4: an IPv4 address inside
  ["2001::", 32], // Teredo: likewise
  ["fc00::", 7], // unique local (and Tailscale's fd7a:115c:a1e0::/48)
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  internal.addSubnet(net, prefix, "ipv6");
}

/** True for an address on the public internet. IPv4-mapped IPv6 is judged as the IPv4 it holds. */
export function isPublicAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (!family) return false;
  return !internal.check(address, family === 4 ? "ipv4" : "ipv6");
}

const MAX_REDIRECTS = 5;
/** Declared types that don't say what the file is; the signature check decides. */
const BINARY_TYPES = ["application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download"];
/** Enough of the start of a file to recognise it by its signature. */
const HEAD_BYTES = 64;
const TIMEOUT_MS = 30_000;

export class SafeDownloader implements Downloader {
  constructor(
    private readonly opts: {
      /** Which resolved addresses may be connected to (tests loosen it; production: public only). */
      allowAddress?: (ip: string) => boolean;
      /** Which ports may be used. */
      ports?: number[];
    } = {},
  ) {}

  private allowed = (ip: string) => (this.opts.allowAddress ?? isPublicAddress)(ip);

  async get(url: string, { maxBytes, contentTypes, accepts }: Parameters<Downloader["get"]>[1]) {
    const deadline = Date.now() + TIMEOUT_MS;
    let current = this.check(url);
    for (let hop = 0; ; hop++) {
      const res = await this.request(current, deadline);
      const location = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new DownloadError("Too many redirects");
        current = this.check(new URL(location, current).href);
        continue;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new DownloadError(`The site answered ${res.statusCode ?? "nothing"} — is the address right, and public?`);
      }
      // Generic binary types say nothing, so they're let through to the signature check.
      const type = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (type && !contentTypes.includes(type) && !BINARY_TYPES.includes(type)) {
        res.destroy();
        throw new DownloadError(
          type.startsWith("text/html") ? "That's a web page, not the file itself — use the link to the photo or PDF" : `That's ${type}, not a photo or PDF`,
        );
      }
      const declared = Number(res.headers["content-length"]);
      if (declared > maxBytes) {
        res.destroy();
        throw new DownloadError(`It's bigger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      const bytes = await readAll(res, maxBytes, deadline, accepts);
      return { bytes, filename: filenameOf(res, current), finalUrl: current.href };
    }
  }

  /** Scheme, port, credentials, and (for IP literals) the address itself. */
  private check(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new DownloadError("That isn't a web address");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new DownloadError("Only http and https addresses can be downloaded");
    if (url.username || url.password) throw new DownloadError("Addresses with a username or password can't be downloaded");
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!(this.opts.ports ?? [80, 443]).includes(port)) throw new DownloadError("Only the standard web ports (80 and 443) can be used");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !this.allowed(host)) throw new DownloadError("That address is on a private network — Ferret only downloads from the internet");
    return url;
  }

  private request(url: URL, deadline: number) {
    const safeLookup: LookupFunction = (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = addresses as { address: string; family: number }[];
        // Any internal answer is refused, not skipped: a name that points inside isn't one to trust.
        if (!list.length || list.some((a) => !this.allowed(a.address))) {
          return callback(new DownloadError("That address is on a private network — Ferret only downloads from the internet"), "", 0);
        }
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    };
    const client = url.protocol === "https:" ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = client.get(url, {
        lookup: safeLookup,
        headers: { "User-Agent": "Ferret/1.0 (self-hosted home inventory)", Accept: "image/*, application/pdf;q=0.9, */*;q=0.1" },
        timeout: Math.max(1, deadline - Date.now()),
      });
      req.on("response", resolve);
      req.on("timeout", () => req.destroy(new DownloadError("The site took too long to answer")));
      req.on("error", (err) =>
        reject(err instanceof DownloadError ? err : new DownloadError(`Couldn't reach ${url.hostname} (${(err as NodeJS.ErrnoException).code ?? err.message})`)),
      );
    });
  }
}

function readAll(res: IncomingMessage, maxBytes: number, deadline: number, accepts: (head: Uint8Array) => boolean) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let checked = false;
    const notAFile = () => new DownloadError("That isn't a photo or a PDF — it may be a web page rather than the file itself");
    const timer = setTimeout(() => res.destroy(new DownloadError("The download took too long")), Math.max(1, deadline - Date.now()));
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return res.destroy(new DownloadError(`It's bigger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
      chunks.push(chunk);
      // Look at the first bytes as soon as there are enough, and stop there if they aren't a wanted file.
      if (!checked && size >= HEAD_BYTES) {
        checked = true;
        if (!accepts(new Uint8Array(Buffer.concat(chunks)))) res.destroy(notAFile());
      }
    });
    res.on("end", () => {
      clearTimeout(timer);
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (!checked && !accepts(bytes)) return reject(notAFile());
      resolve(bytes);
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof DownloadError ? err : new DownloadError("The download broke off"));
    });
  });
}

/** From Content-Disposition, else the last part of the path. */
function filenameOf(res: IncomingMessage, url: URL) {
  const disposition = res.headers["content-disposition"] ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)?.[1];
  const fromHeader = star ? safeDecode(star.trim()) : plain?.trim();
  const fromPath = safeDecode(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  return fromHeader || fromPath || null;
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
