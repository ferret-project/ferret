# Install

Ferret runs as one Docker container: the web app, the API, the MCP server for Claude, background jobs, and these docs.
Its data — a SQLite database and the uploaded files, encrypted — lives in one folder.

## What you need

- A machine with **Docker** and Docker Compose.
- An address people reach it at, ideally **HTTPS** behind a reverse proxy (Traefik, Caddy, nginx). Installing on an
  iPhone, the camera and push notifications all need HTTPS.

## Steps

1. Get `compose.yaml` and `.env.example` from [the repository](https://github.com/ferret-project/ferret) into a folder,
   and copy `.env.example` to `.env`:

   ```bash
   curl -O https://raw.githubusercontent.com/ferret-project/ferret/main/compose.yaml
   curl -o .env https://raw.githubusercontent.com/ferret-project/ferret/main/.env.example
   ```

2. Fill in the three required settings:

   ```bash
   AUTH_SECRET=   # openssl rand -base64 32
   FILES_KEY=     # openssl rand -base64 32
   PUBLIC_URL=https://ferret.example.lan
   ```

   ::: danger FILES_KEY
   Every uploaded photo and document is encrypted with a key sealed by `FILES_KEY`. **Lose it and they're
   unreadable** — backups too. Save it in your password manager now.
   :::

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open `PUBLIC_URL` and **sign up**: the first account is yours, and it's the [server admin](./server-admin).
5. Turn on what you want from [Settings](./configuration): [backups](./backups) first, then
   [email](./email) (needed for anyone else to join) and the [AI features](./ai).

## Behind a reverse proxy

Point the proxy at port **8787**. If the proxy runs on another machine, set `TRUSTED_PROXIES` to its address —
otherwise every visitor looks like the proxy, and they all share one set of sign-in limits.

## Sign-ups

`ALLOW_SIGNUP=true` (the default) lets anyone who can reach Ferret make an account — though everyone after the first must
confirm their email, so that needs [email](./email). Once your household is in, set `ALLOW_SIGNUP=false`: invited
people can still join from their invitation link.
