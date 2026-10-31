# Single sign-on

Already sign in to your other self-hosted apps through Authelia, Pocket ID, Authentik or Keycloak? Ferret can use it too
— either as a **Sign in with …** button (OpenID Connect), or by trusting the headers your forward-auth proxy adds. Both
are for a Ferret you run yourself, and both are off until you set them up. Passwords, passkeys and emailed links keep
working alongside.

Ferret's own rules still apply: with `ALLOW_SIGNUP=false`, someone signing in for the first time needs an invitation
(sent to the email address their provider has), or they're told Ferret is invite-only. People who already have a Ferret
account are matched by email the first time — after that by the provider's own id for them, so changing their email at
the provider doesn't lose their account.

## OpenID Connect

1. At your provider, add a client (an "application") for Ferret:
   - **Redirect URI**: `https://ferret.example.lan/api/auth/callback/oidc` (your `PUBLIC_URL`, then `/api/auth/callback/oidc`)
   - **Scopes**: `openid email profile`
   - PKCE on (S256); a confidential client with a secret.
2. In Ferret's `.env`:

   ```ini
   OIDC_ISSUER=https://auth.example.lan
   OIDC_CLIENT_ID=ferret
   OIDC_CLIENT_SECRET=…
   OIDC_NAME=Authelia            # the button says "Sign in with Authelia"
   ```

3. Restart Ferret. The sign-in screen has **Sign in with Authelia**; it comes back to the page you were opening.

Only addresses the provider has **confirmed** are trusted (its `email_verified`). If the provider is down when Ferret
starts, Ferret starts anyway and tries the provider again at the next sign-in.

**Authelia** — the client in `configuration.yml`:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: 'ferret'
        client_name: 'Ferret'
        client_secret: '$pbkdf2-sha512$…'   # authelia crypto hash generate pbkdf2 --variant sha512
        redirect_uris: ['https://ferret.example.lan/api/auth/callback/oidc']
        scopes: ['openid', 'email', 'profile']
        authorization_policy: 'two_factor'
        require_pkce: true
        pkce_challenge_method: 'S256'
        token_endpoint_auth_method: 'client_secret_basic'
```

**Pocket ID** — **OIDC Clients → Add**, callback URL as above, PKCE on; copy the client ID and secret, and set
`OIDC_ISSUER` to Pocket ID's address. Then, **before anyone signs in**, turn on **Application Configuration → Emails
Verified**: Pocket ID otherwise tells Ferret every email is unconfirmed, and Ferret won't sign in someone it can't match
to an address ("Your sign-in provider hasn't confirmed your email address"). If someone tried before you turned it on,
their first try afterwards fails once more; the next one works.

Ferret sends its secret the way the OIDC standard and these providers expect (`client_secret_basic`). If yours wants it in
the form instead, set `OIDC_CLIENT_AUTH=post`.

## Trusted headers (forward auth)

If every request to Ferret already goes through a proxy that has signed the person in (Authelia or Authentik with
Traefik, Caddy or nginx forward auth), Ferret can take the proxy's word for who it is:

```ini
TRUSTED_HEADER_AUTH=true
TRUSTED_HEADER_PROXIES=10.0.0.2         # the proxy's address — only requests from it are believed
TRUSTED_HEADER_USER=Remote-User         # the defaults; change them if your proxy uses other names
TRUSTED_HEADER_EMAIL=Remote-Email
TRUSTED_HEADER_NAME=Remote-Name
```

Opening Ferret then signs you in by itself. Someone is known by their user name at the proxy, and matched to an existing
Ferret account by email the first time.

::: warning Only from your proxy
The headers are believed only on connections **from `TRUSTED_HEADER_PROXIES`** — never from anywhere else, whatever a
request says. Your proxy must also **replace** these headers on what it passes on, so a visitor can't send their own (with
Traefik's forward auth, list them in `authResponseHeaders`; Caddy and nginx set them from the auth response). Never put
Ferret's port where people can reach it without going through the proxy.
:::

## Good to know

- Two-step sign-in is your provider's job with single sign-on: Ferret's own code is asked for with a password, not after
  the provider.
- Sign-ins show in **Settings → Security** as *with single sign-on* or *through the sign-in proxy*.
- Signing out of Ferret ends Ferret's session; with trusted headers, opening Ferret in a new visit signs you in again
  (sign out at the proxy to stop that).
