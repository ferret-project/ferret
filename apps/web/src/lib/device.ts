/**
 * Plain-words labels for sessions and sign-ins: "Safari on iPhone" from a user
 * agent, "Home network" from a private IP. Good enough to recognise your own
 * devices — not a full user-agent parser.
 */

export function describeDevice(userAgent: string | null): { label: string; icon: string } {
  if (!userAgent) return { label: "Unknown device", icon: "icon-[tabler--device-desktop-question]" };
  const ua = userAgent;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS/.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /^curl\//.test(ua)
            ? "curl"
            : null;
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? ua.slice(0, 40));
  const icon =
    os === "iPhone" || os === "Android"
      ? "icon-[tabler--device-mobile]"
      : os === "iPad"
        ? "icon-[tabler--device-tablet]"
        : "icon-[tabler--device-laptop]";
  return { label, icon };
}

/** Where an address is: your own network, Tailscale, or out on the internet (shown as the address). */
export function describeNetwork(address: string | null): string {
  const ip = address && shortIPv6(address);
  if (!ip || ip === "::") return "Unknown network";
  if (/^(127\.|::1$)/.test(ip)) return "This server";
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^fd7a:115c:a1e0:/i.test(ip)) return `Tailscale · ${ip}`;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip)) return `Home network · ${ip}`;
  return ip;
}

/**
 * Better Auth keeps IPv6 addresses written out in full and cut to their /64
 * network ("2001:0db8:0000:…:0000"); write them the short way ("2001:db8::").
 */
function shortIPv6(ip: string) {
  const groups = ip.split(":");
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{4}$/i.test(g))) return ip;
  const short = groups.map((g) => g.replace(/^0+(?=.)/, "").toLowerCase());
  // Collapse the longest run of zero groups to "::".
  let best = { at: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && short[j] === "0") j++;
    if (j - i > best.length) best = { at: i, length: j - i };
    i = j === i ? i + 1 : j;
  }
  if (best.length < 2) return short.join(":");
  return `${short.slice(0, best.at).join(":")}::${short.slice(best.at + best.length).join(":")}`;
}
