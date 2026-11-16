/**
 * A household's Paperless-ngx for Node (the Paperless port): its REST API with the household's token, read only.
 *
 * Where it may connect: the public internet — or, set up by whoever runs this Ferret (`allowLocal`), the server's own
 * network too; every address a name resolves to is checked when connecting (as the downloader does), so a name can't
 * point inside. Redirects aren't followed (the token would go with them): an answer that redirects says where to, so
 * the address can be corrected. Answers are capped in size and time. Certificates trusted in Settings → Server apply
 * (Node's default authorities).
 */
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { type Paperless, type PaperlessDoc, PaperlessError, type PaperlessServer } from "../../ports";
import { isPublicAddress } from "./download";

const TIMEOUT_MS = 20_000;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;
/** Paperless's API version this was written against (documents' `created` is a date from 9 on). */
const API = "application/json; version=9";

const PRIVATE = "That address is on a private network — only whoever runs this Ferret can connect Ferret to one there";

type Answer = { status: number; headers: http.IncomingHttpHeaders; bytes: Uint8Array };

export class NodePaperless implements Paperless {
  constructor(private readonly opts: { isPublic?: (ip: string) => boolean } = {}) {}

  private get(server: PaperlessServer, path: string, accept: string, max: number): Promise<Answer> {
    let base: URL;
    try {
      base = new URL(server.url);
    } catch {
      throw new PaperlessError("That isn't a web address");
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new PaperlessError("Only http and https addresses can be used");
    const url = new URL(path.replace(/^\//, ""), base.href.endsWith("/") ? base.href : `${base.href}/`);
    const isPublic = this.opts.isPublic ?? isPublicAddress;
    const allowLocal = server.allowLocal;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowLocal && isIP(host) && !isPublic(host)) throw new PaperlessError(PRIVATE);
    const lookup: LookupFunction = (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = addresses as { address: string; family: number }[];
        if (!list.length || (!allowLocal && list.some((a) => !isPublic(a.address)))) return callback(new PaperlessError(PRIVATE), "", 0);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    };
    const client = url.protocol === "https:" ? https : http;
    return new Promise<Answer>((resolve, reject) => {
      const req = client.request(url, {
        method: "GET",
        lookup,
        timeout: TIMEOUT_MS,
        headers: { Authorization: `Token ${server.token}`, Accept: accept, "User-Agent": "Ferret/1.0 (self-hosted home inventory)" },
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let read = 0;
        res.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > max) {
            res.destroy();
            reject(new PaperlessError(`Paperless's answer was too big (over ${Math.round(max / 1024 / 1024)} MB)`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: new Uint8Array(Buffer.concat(chunks)) }));
        res.on("error", (err) => reject(new PaperlessError(`Paperless's answer broke off (${err.message})`)));
      });
      req.on("timeout", () => req.destroy(new PaperlessError(`${url.host} took too long to answer`)));
      req.on("error", (err) => reject(err instanceof PaperlessError ? err : new PaperlessError(`Couldn't reach ${url.host} (${unreachable(err)})`)));
      req.end();
    }).then((answer) => {
      if (answer.status >= 300 && answer.status < 400) {
        const to = answer.headers.location;
        throw new PaperlessError(`Paperless's address redirects${to ? ` to ${String(to).split("?")[0]}` : ""} — use that address instead`, answer.status);
      }
      if (answer.status === 401) throw new PaperlessError("Paperless refused the token — make a new one in Paperless (My profile → API auth token)", 401);
      if (answer.status === 403) throw new PaperlessError("The token's Paperless user isn't allowed to see that — give it view permission", 403);
      if (answer.status === 404) throw new PaperlessError("Paperless doesn't have that (is the address Paperless's own?)", 404);
      if (answer.status >= 400) throw new PaperlessError(`Paperless answered ${answer.status}`, answer.status);
      return answer;
    });
  }

  private async json<T>(server: PaperlessServer, path: string): Promise<T> {
    const answer = await this.get(server, path, API, MAX_JSON);
    try {
      return JSON.parse(new TextDecoder().decode(answer.bytes)) as T;
    } catch {
      throw new PaperlessError("That address didn't answer like Paperless-ngx (is it Paperless's own address?)");
    }
  }

  async whoAmI(server: PaperlessServer) {
    const settings = await this.json<{ user?: { username?: unknown } }>(server, "api/ui_settings/");
    if (typeof settings?.user?.username !== "string") throw new PaperlessError("That address didn't answer like Paperless-ngx (is it Paperless's own address?)");
    return { user: settings.user.username };
  }

  async findTag(server: PaperlessServer, name: string) {
    const page = await this.json<{ results?: { id: number; name: string }[] }>(server, `api/tags/?name__iexact=${encodeURIComponent(name)}&page_size=5`);
    const found = page.results?.find((t) => t.name.toLowerCase() === name.toLowerCase());
    return found ? { id: found.id, name: found.name } : null;
  }

  async documents(server: PaperlessServer, q: { tagId?: number; query?: string; page?: number; pageSize?: number }) {
    const params = new URLSearchParams({
      page: String(q.page ?? 1),
      page_size: String(q.pageSize ?? 50),
      fields: "id,title,correspondent,created,mime_type,content,tags",
    });
    if (q.tagId !== undefined) params.set("tags__id__all", String(q.tagId));
    if (q.query) params.set("query", q.query);
    else params.set("ordering", "-added");
    const page = await this.json<{ count?: number; next?: string | null; results?: Record<string, unknown>[] }>(server, `api/documents/?${params}`);
    if (!Array.isArray(page.results)) throw new PaperlessError("That address didn't answer like Paperless-ngx (is it Paperless's own address?)");
    return { count: page.count ?? page.results.length, more: Boolean(page.next), results: page.results.map(doc) };
  }

  async correspondents(server: PaperlessServer, ids: number[]) {
    const names = new Map<number, string>();
    if (!ids.length) return names;
    const page = await this.json<{ results?: { id: number; name: string }[] }>(server, `api/correspondents/?id__in=${ids.join(",")}&page_size=${ids.length}`);
    for (const c of page.results ?? []) names.set(c.id, c.name);
    return names;
  }

  async download(server: PaperlessServer, id: number, maxBytes: number) {
    const answer = await this.get(server, `api/documents/${id}/download/`, "*/*", maxBytes);
    const disposition = String(answer.headers["content-disposition"] ?? "");
    const star = /filename\*=utf-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
    let filename = plain ?? `paperless-${id}`;
    if (star) {
      try {
        filename = decodeURIComponent(star);
      } catch {
        // keep the plain one
      }
    }
    return { bytes: answer.bytes, filename, contentType: String(answer.headers["content-type"] ?? "").split(";")[0]!.trim() };
  }

  async thumbnail(server: PaperlessServer, id: number) {
    const answer = await this.get(server, `api/documents/${id}/thumb/`, "*/*", MAX_THUMB);
    return { bytes: answer.bytes, contentType: String(answer.headers["content-type"] ?? "image/webp").split(";")[0]!.trim() };
  }
}

function doc(r: Record<string, unknown>): PaperlessDoc {
  const created = typeof r.created === "string" ? r.created.slice(0, 10) : null;
  return {
    id: Number(r.id),
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : `Document ${String(r.id)}`,
    correspondent: typeof r.correspondent === "number" ? r.correspondent : null,
    created: created && /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : null,
    mimeType: typeof r.mime_type === "string" ? r.mime_type : null,
    content: typeof r.content === "string" ? r.content : "",
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is number => typeof t === "number") : [],
  };
}

/** A connection error in words: an untrusted certificate is the usual one with a home Paperless. */
function unreachable(err: Error) {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (/UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED/.test(code)) {
    return "its certificate isn't trusted — the server admin can add its certificate authority in Settings → Server → Certificates";
  }
  if (code === "CERT_HAS_EXPIRED") return "its certificate has expired";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "its certificate is for a different name";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "that name can't be found";
  if (code === "ECONNREFUSED") return "nothing is listening there";
  return code || err.message;
}
