# VPN: WireGuard, Tailscale or WARP

Ferret is meant to stay off the public internet. To use it away from home, connect your phone to your home network
with a VPN — then Ferret works exactly as it does on the Wi-Fi, the installed app included. (Rather reach it by a public
name? See [Choosing a way in](./reaching-ferret).)

## WireGuard (or Tailscale)

Any VPN into your home network works. If you already run **WireGuard** (on your router, or a small server at home),
you're most of the way there:

- **Reach the server**: the phone's tunnel must route your home network (e.g. `AllowedIPs = 10.0.0.0/24`), or
  everything (`0.0.0.0/0`).
- **Find it by name**: set the tunnel's `DNS =` to your home DNS server, so the name in `PUBLIC_URL` (*ferret.example.lan*)
  resolves while you're away.
- **Trust its certificate**: if Ferret's certificate comes from your own certificate authority, the phone needs that CA
  installed and trusted (iPhone: Settings → General → About → Certificate Trust Settings) — the same as at home.
- **On demand**: in the WireGuard app on iPhone, edit the tunnel → *On-Demand* → turn it on for cellular and for Wi-Fi
  *except* your home network's name. The tunnel then comes up by itself whenever you leave, and the installed Ferret
  app just works.

[Tailscale](https://tailscale.com/) is the easier choice if you don't have a VPN yet: no port to open on your router,
and a *subnet router* (or Tailscale on the Ferret server itself) does the same job. If WireGuard already works for you,
there's no need to switch.

## Cloudflare WARP

If you already use Cloudflare for a tunnel, its **WARP** app (Cloudflare One Agent; free for up to 50 people) can do a
VPN's job without opening a port:

- **Ferret stays private**: in Zero Trust, add your home network's range to the tunnel as a *private network* (Networks
  → Tunnels → your tunnel → CIDR routes), and let WARP send that range through it (Split Tunnels). Phones with WARP
  reach Ferret's home address; nobody else can.
- **Or keep Ferret's public name** behind [Access](./tunnels) and add a rule to its policy that requires a device
  running WARP in your organisation — the phone is checked, not the app, so there's no sign-in page for the installed
  app to meet.
- **Find it by name**: with a private network, add a Local Domain Fallback entry for your home domain pointing at your
  home DNS server, so the name in `PUBLIC_URL` resolves.

Check once that the installed Ferret app works with WARP switched on, away from your Wi-Fi.

## What works without the VPN

Reminders still arrive: push notifications go through Apple's (or Google's) push service, and Apprise messages are sent
from your server. Opening Ferret from one needs the VPN. The calendar feed is fetched by your calendar app, so it
catches up whenever the phone is home or on the VPN.

## Share links and borrowers' links

[Share links](../guide/sharing) and the link in a [lending reminder](../guide/lending) are opened by people outside your
household — an insurer, a neighbour — who won't be on your network. To let them in without making all of Ferret
public, expose only these paths (e.g. with a tunnel or a reverse-proxy rule): `/s/`, `/b/`,
`/api/v1/shared/`, `/api/v1/borrowed/`, and the app itself (`/`, `/assets/`) that shows them. Everything else still
needs a sign-in. (With an access proxy in front, see [what to let through](./tunnels#let-through-what-can-t-sign-in-to-the-proxy).) Until then, they work for anyone on your network or VPN.

## Apps that sign in (claude.ai, ChatGPT)

[claude.ai's connectors and other apps that sign in](../guide/claude#claude-ai-and-other-apps-that-sign-in) reach your
Ferret from their own servers. Only these paths need to be reachable from the internet (with `PUBLIC_URL` set to that
`https://` address): `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
(both with anything after them), and `/api/auth/oauth2/register`, `/api/auth/oauth2/token` and
`/api/auth/oauth2/revoke`. Signing in and the **Connect an app** screen open in your own browser at that same address,
so it has to work there too — at home, on the VPN, or through your access proxy. (With an access proxy in front, let those paths through it — see
[what to let through](./tunnels#let-through-what-can-t-sign-in-to-the-proxy).)
