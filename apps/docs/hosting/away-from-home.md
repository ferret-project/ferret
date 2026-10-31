# Away from home

Ferret is meant to stay off the public internet. To use it away from home, connect your phone to your home network
with a VPN — then Ferret works exactly as it does on the Wi-Fi.

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

## What works without the VPN

Reminders still arrive: push notifications go through Apple's (or Google's) push service, and Apprise messages are sent
from your server. Opening Ferret from one needs the VPN. The calendar feed is fetched by your calendar app, so it
catches up whenever the phone is home or on the VPN.

## Share links and borrowers' links

[Share links](../guide/sharing) and the link in a [lending reminder](../guide/lending) are opened by people outside your
household — an insurer, a neighbour — who won't be on your network. To let them in without making all of Ferret
public, expose only these paths (e.g. with a tunnel or a reverse-proxy rule): `/s/`, `/b/`,
`/api/v1/shared/`, `/api/v1/borrowed/`, and the app itself (`/`, `/assets/`) that shows them. Everything else still
needs a sign-in. Until then, they work for anyone on your network or VPN.
