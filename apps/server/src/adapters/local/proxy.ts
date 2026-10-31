/**
 * Who a request comes from. Better Auth (its rate limiter, the sign-in guard,
 * the sign-in log) reads the client's address from X-Forwarded-For, which a
 * client can write itself — so it's only believed from a reverse proxy we
 * trust (TRUSTED_PROXIES), and replaced by the connection's own address
 * otherwise. Either way exactly one address goes on.
 */
import { BlockList, isIP } from "node:net";
import { PROXY_MARK } from "../../lib/sso";

/** TRUSTED_PROXIES ("10.0.0.5, 192.168.1.0/24, ::1") as a BlockList to check peers against. */
export function proxyList(spec: string) {
  const list = new BlockList();
  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [address, bits] = entry.split("/") as [string, string | undefined];
    const family = isIP(address);
    if (!family) throw new Error(`TRUSTED_PROXIES: ${entry} isn't an IP address or range`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(bits), type);
  }
  return list;
}

/** "::ffff:10.0.0.5" → "10.0.0.5", "::1" stays. */
const plain = (address: string) => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");

/** Whether the connection itself (not anything it claims) is from one of these addresses. */
export function fromTrusted(peer: string | undefined, trusted: BlockList) {
  if (!peer) return false;
  const from = plain(peer);
  const family = isIP(from);
  return Boolean(family) && trusted.check(from, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The client's address: the last one in X-Forwarded-For (the one our proxy added) when the connection is from a
 * trusted proxy, else the connection's own.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | null, trusted: BlockList) {
  if (!peer) return undefined;
  const from = plain(peer);
  const family = isIP(from);
  if (forwardedFor && family && trusted.check(from, family === 4 ? "ipv4" : "ipv6")) {
    const last = forwardedFor.split(",").map((s) => plain(s.trim())).filter(Boolean).at(-1);
    if (last && isIP(last)) return last;
  }
  return from;
}

/** The request with X-Forwarded-For set to just the client's address (see clientAddress). */
export function withClientAddress(req: Request, peer: string | undefined, trusted: BlockList) {
  const address = clientAddress(peer, req.headers.get("x-forwarded-for"), trusted);
  if (!address && !req.headers.has("x-forwarded-for")) return req;
  const headers = new Headers(req.headers);
  if (address) headers.set("x-forwarded-for", address);
  else headers.delete("x-forwarded-for");
  return new Request(req, { headers });
}

/**
 * The request marked as from the sign-in proxy (lib/sso.ts PROXY_MARK) when the connection is from one of `proxies`;
 * a mark the client sent itself is always taken off. `proxies` null: trusted-header sign-in is off.
 */
export function markAuthProxy(req: Request, peer: string | undefined, proxies: BlockList | null) {
  const fromProxy = Boolean(proxies && fromTrusted(peer, proxies));
  if (!fromProxy && !req.headers.has(PROXY_MARK)) return req;
  const headers = new Headers(req.headers);
  if (fromProxy) headers.set(PROXY_MARK, "1");
  else headers.delete(PROXY_MARK);
  return new Request(req, { headers });
}
