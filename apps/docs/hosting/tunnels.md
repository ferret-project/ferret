# Through a tunnel or access proxy

A [VPN](./away-from-home) keeps Ferret off the internet altogether, and it's still the simplest way
([choosing a way in](./reaching-ferret) compares them). If you'd rather
reach Ferret by a public name, put an **access proxy** in front of it — Cloudflare Tunnel with Cloudflare Access,
Pangolin, or your own Traefik with client certificates — so strangers are stopped before they reach Ferret. Ferret's
own sign-in still decides who someone is and what they can see; the proxy only decides who gets to knock.

Ferret needs nothing special for this. What it needs from you is below.

## Tell Ferret which proxies are yours

Ferret slows down wrong passwords per address, and logs where each sign-in came from (and tells you about new
places). For that it needs each visitor's real address, which proxies pass on in `X-Forwarded-For`. Ferret reads it
from the right, skipping every hop you've listed in `TRUSTED_PROXIES`, so list **every** proxy between the internet and
Ferret:

| How it's reached | `TRUSTED_PROXIES` |
| --- | --- |
| Cloudflare Tunnel straight to Ferret | the `cloudflared` container's address (e.g. its Docker network, `172.18.0.0/16`) |
| Cloudflare Tunnel → Traefik → Ferret | Traefik's address **and** `cloudflared`'s |
| Cloudflare's proxy (orange cloud), no tunnel | [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) (and your own proxy's, if there is one) — they change now and then |

A proxy you leave out isn't believed: every visitor then looks like that proxy, and they share one set of sign-in
limits. Never list a range anyone on the internet can connect from — then anyone could claim any address.

## Let through what can't sign in to the proxy

An access proxy asks every visitor to sign in to *it* first. Most of Ferret is fine with that, but a few things are
opened by apps or people who can't:

| Path | Who opens it | Without a bypass |
| --- | --- | --- |
| `/calendar/` | your phone's Calendar app, subscribing to [the reminders feed](../guide/reminders) | the calendar stops updating |
| `/s/`, `/api/v1/shared/` | an insurer or anyone else you send a [share link](../guide/sharing) | they see the proxy's sign-in page |
| `/b/`, `/api/v1/borrowed/` | a borrower opening their [lending reminder](../guide/lending) | the same |
| `/healthz` | an uptime monitor, if you have one | it reports Ferret down |
| `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/api/auth/oauth2/register`, `/api/auth/oauth2/token`, `/api/auth/oauth2/revoke` | [claude.ai's connectors and other apps that sign in](../guide/claude#claude-ai-and-other-apps-that-sign-in), from their servers | the app can't connect |

Each of these is safe to open up: the calendar feed and the share and borrower links carry their own secret in the
address, `/healthz` says only "ok", and the app paths answer only an app holding a token you allowed (the
`.well-known` documents just say where to sign in). In **Cloudflare Access**, add an application for each path (e.g.
`ferret.example.com/calendar`) with a **Bypass** policy for *Everyone* — the most specific application wins, so the
rest of Ferret stays behind the main one.

::: warning Share and borrower links show the app itself
The page someone sees for a share link is Ferret's app (`/`, with `/assets/`), and Access can't let through `/` without
letting through everything. So outsiders opening a share link still meet the proxy's sign-in — fine if you only share
with people you can add to it (Access's one-time PIN by email works for anyone), otherwise keep those links for people
on your network or VPN.
:::

Push notifications and Apprise messages go *out* from Ferret, so the proxy doesn't affect them. Emailed links (confirm
your email, reset a password) are opened in a browser, which signs in to the proxy first — fine.

**The installed app on your phone** signs in to the proxy like a browser and keeps it for as long as the proxy
allows — give Ferret's application a long session (Cloudflare Access: *Session duration*, e.g. 1 month). There's more
to it, and a few things that can't work: [The phone app behind a proxy](./phone-app).

## Scripts and Claude: service tokens

Scripts and [Claude](../guide/claude) use an API key (`Authorization: Bearer ferret_…`), and they can't sign in to a
proxy. With Cloudflare Access, make a **service token** (Access → Service credentials) and add a policy to Ferret's
application with the action **Service Auth** that includes it. Then send its two headers alongside the API key —
Access checks them and passes the request on; Ferret checks the key as always:

```sh
curl https://ferret.example.com/api/v1/items \
  -H "CF-Access-Client-Id: ….access" -H "CF-Access-Client-Secret: …" \
  -H "Authorization: Bearer ferret_…"
```

Claude Code:

```sh
claude mcp add --transport http ferret https://ferret.example.com/mcp \
  --header "CF-Access-Client-Id: ….access" --header "CF-Access-Client-Secret: …" \
  --header "Authorization: Bearer ferret_…"
```

A service token only gets a request past the proxy — it can't act in Ferret without a key, and a key keeps its own
limits (one household, maybe read-only). Service tokens are for scripts and Claude only; the installed app
[can't use one](./phone-app#what-can-t-work-service-tokens).

Organisations made since October 2026 check service tokens **strictly** by default: Access then hands back no cookie,
so every request must carry both headers (scripts and Claude Code do), and a request without them is refused with
`401`/`403` rather than sent to a sign-in page.

## One sign-in instead of two

Behind an access proxy people sign in twice: to the proxy, then to Ferret. To make it once, let the proxy's sign-in be
Ferret's too, with [OpenID Connect](./single-sign-on#openid-connect):

- **Cloudflare Access**: Access → Applications → *SaaS application* → OIDC. Redirect URL
  `https://ferret.example.com/api/auth/callback/oidc`, scopes `openid email profile`, PKCE on. Then in Ferret's `.env`,
  `OIDC_ISSUER` is the **Issuer** Cloudflare shows (`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`),
  with its client ID and secret, and `OIDC_NAME=Cloudflare`. Try it once with a new account: Ferret only trusts
  addresses the provider says it has confirmed, and says so if it hasn't.
- **Authelia, Authentik, Pocket ID** behind Traefik: the same page has their settings, and the
  [trusted-headers](./single-sign-on#trusted-headers-forward-auth) way works too.

Don't point trusted-header sign-in at a header like `Cf-Access-Authenticated-User-Email`: anything on a bypassed path
reaches Ferret without Access having set it, so Ferret couldn't tell whose it is. OpenID Connect proves it.

## Client certificates (mutual TLS)

Instead of a sign-in page, a proxy can ask every device for a **client certificate** — Cloudflare Access's *mTLS* rule
(paid Zero Trust plans), or your own Traefik or Caddy. Making them, putting them on phones, and which paths still work:
[Client certificates (mutual TLS)](./client-certificates).

## Certificates from your own authority

If Ferret's certificate comes from your own certificate authority (a `step-ca`, Traefik with a local CA…), each device
needs that authority trusted — iPhone: install it, then turn it on in Settings → General → About → *Certificate Trust
Settings*. For Ferret's own connections to your other services (Home Assistant, Ollama, your sign-in provider) see
[Certificates](./certificates).
