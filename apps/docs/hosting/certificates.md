# Certificates

Ferret's server connects to your other services: Home Assistant, the AI models, docling, Qdrant, Apprise, your
sign-in provider. If one of them has a certificate from your own certificate authority, or a self-signed one, or asks
*Ferret* to show a certificate (mutual TLS), tell Ferret in **Settings → Server → Access → Certificates**. Only the
[server admin](./server-admin) sees it.

## Trusting a certificate

**Trust a certificate…** takes a certificate in PEM form (a `.pem` or `.crt` file, or pasted
`-----BEGIN CERTIFICATE-----…`):

- **Your certificate authority** (step-ca, Smallstep, a Traefik or Caddy local CA, your router's…): add its *root*
  certificate once, and every service with a certificate from it is trusted.
- **A service's self-signed certificate**: add that certificate itself.

A file with several certificates (a chain) adds each one. Never add a private key — Ferret refuses one.

Ferret trusts these for its own connections from then on, with no restart. **Downloads from the internet** ("Add from a
web address", product photos) never use them: they trust only the usual public authorities, so a certificate you add
can't vouch for a site on the internet.

### From the command line

Setting Ferret up without a browser at hand (a script, a fresh server, single sign-on that won't work until its
certificate is trusted)? The same list is on the [command line](./server-admin#the-command-line):

```sh
docker compose exec ferret node dist/cli.js certificates list
docker compose exec -T ferret node dist/cli.js certificates trust - "Home CA" < home-ca.pem
docker compose exec ferret node dist/cli.js certificates remove "Home CA"     # or its id, from list
```

`trust` takes a file inside the container, or `-` to read it from what's piped in (as above). A running Ferret uses the
change within a minute — no restart. Client certificates are added in Settings only.

## Client certificates (mutual TLS)

Some services only answer clients that show a certificate of their own — an mTLS rule in Traefik, nginx or Caddy in
front of Home Assistant, Ollama or ntfy. **Add a client certificate…** takes:

- the certificate and its private key as a **PKCS#12 file** (`.p12` or `.pfx`) and its password. To make one from
  separate files: `openssl pkcs12 -export -inkey client.key -in client.pem -out ferret.p12`.
- **Show it to**: the hosts it's for — `ha.example.lan`, an address like `10.0.0.12`, or `*.example.lan` for everything
  under one name. Ferret presents it to those and nobody else.

The file and its password are kept in Ferret's database sealed with a key made from your `FILES_KEY`, are in your
backups like everything else, and are never shown again — to replace one, add the new one and remove the old.

## When they run out

Each certificate shows when it expires. Thirty days before, the bell tells the server admin; on the day, it turns
urgent. Add the replacement, then remove the old one.

## Good to know

- `NODE_EXTRA_CA_CERTS` (a file of extra authorities, read when Ferret starts) still works too, and adds to the same
  list.
- The certificates here are for Ferret's own connections. For **your devices** reaching Ferret — trusting Ferret's
  certificate, or showing one to a proxy in front of it — see [Client certificates (mutual TLS)](./client-certificates) and [Choosing a way in](./reaching-ferret).
- Apprise sends the messages to ntfy, Gotify and the rest itself, so a self-signed ntfy needs trusting in the
  `apprise` container (or add `?verify=no` to that channel's URL). Ferret's certificates cover Ferret's connection to
  Apprise.
- A hosted Ferret has no Certificates section: its server connects only to the services it comes with.
