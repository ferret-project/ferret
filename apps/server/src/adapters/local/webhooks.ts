/**
 * Webhook deliveries for Node (the WebhookSender port). A household's own address — often on the server's network
 * (n8n, Home Assistant) when whoever runs the server set it up (`allowLocal`); otherwise public addresses only, every
 * address the name resolves to checked when connecting (as the downloader does), so a name can't point inside.
 * Redirects are never followed, nothing is sent but the body and the headers given, and the answer is only read for
 * its status (the first bytes, then dropped).
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { WebhookError, type WebhookSender } from "../../ports";
import { isPublicAddress } from "./download";

const TIMEOUT_MS = 15_000;
/** How much of an answer is read before it's dropped (only its status matters). */
const MAX_ANSWER = 64 * 1024;

const PRIVATE = "That address is on a private network — only whoever runs this Ferret can send webhooks there";

export class NodeWebhookSender implements WebhookSender {
  constructor(
    private readonly opts: {
      /** Which resolved addresses are public (tests loosen it). */
      isPublic?: (ip: string) => boolean;
    } = {},
  ) {}

  async post(raw: string, body: string, headers: Record<string, string>, { allowLocal }: { allowLocal: boolean }) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new WebhookError("That isn't a web address");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebhookError("Only http and https addresses can be used");
    const isPublic = this.opts.isPublic ?? isPublicAddress;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowLocal && isIP(host) && !isPublic(host)) throw new WebhookError(PRIVATE);
    const lookup: LookupFunction = (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = addresses as { address: string; family: number }[];
        if (!list.length || (!allowLocal && list.some((a) => !isPublic(a.address)))) return callback(new WebhookError(PRIVATE), "", 0);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    };
    const client = url.protocol === "https:" ? https : http;
    return new Promise<{ status: number }>((resolve, reject) => {
      const req = client.request(url, {
        method: "POST",
        lookup,
        timeout: TIMEOUT_MS,
        headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "Ferret-Webhooks/1" },
      });
      req.on("response", (res) => {
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > MAX_ANSWER) res.destroy();
        });
        res.on("close", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("timeout", () => req.destroy(new WebhookError(`${url.host} took too long to answer`)));
      req.on("error", (err) =>
        reject(err instanceof WebhookError ? err : new WebhookError(`Couldn't reach ${url.host} (${(err as NodeJS.ErrnoException).code ?? err.message})`)),
      );
      req.end(body);
    });
  }
}
