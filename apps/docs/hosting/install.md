# Install

Ferret runs as one Docker container: the web app, the API, the MCP server for Claude, background jobs, and these docs.
Its data — a SQLite database and the uploaded files, encrypted — lives in one folder.

## What you need

- A machine with **Docker** and Docker Compose — x86-64 or 64-bit ARM (a Raspberry Pi 4 or 5 on a 64-bit OS, an
  Apple Silicon Mac, an ARM server). Ferret itself uses about 150 MB of memory when idle, a little more while it
  makes thumbnails; 1 GB for the whole machine is plenty. The AI features run on models elsewhere ([AI](./ai)).
- An address people reach it at, ideally **HTTPS** behind a reverse proxy ([Caddy, nginx or Traefik](./reverse-proxy)). Installing on an
  iPhone, the camera and push notifications all need HTTPS.

## Steps

1. Get `compose.yaml` and `.env.example` from [the repository](https://github.com/ferret-project/ferret) into a folder,
   and copy `.env.example` to `.env`:

   ```bash
   curl -O https://raw.githubusercontent.com/ferret-project/ferret/main/compose.yaml
   curl -o .env https://raw.githubusercontent.com/ferret-project/ferret/main/.env.example
   ```

2. Set `PUBLIC_URL` in `.env` — the address people reach Ferret at:

   ```bash
   PUBLIC_URL=https://ferret.example.lan
   ```

   Ferret makes its [secrets](./configuration#secrets) (`AUTH_SECRET`, `FILES_KEY`, the push keys) the first time it
   starts and keeps them in the data folder. You can set your own in `.env` instead.

   ::: danger FILES_KEY
   Every uploaded photo and document is encrypted with a key sealed by `FILES_KEY`. **Lose it and they're
   unreadable** — backups too. Once Ferret is running, make a [key file](./backups#a-key-file-for-files-key)
   (**Settings → Server → Access → Keys** shows how) and keep it, and its passphrase, off the server.
   :::

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open `PUBLIC_URL` and **sign up**: the first account is yours, and it's the [server admin](./server-admin).
5. Turn on what you want from [Settings](./configuration): [backups](./backups) first, then
   [email](./email) (needed for anyone else to join) and the [AI features](./ai).

## Where the image comes from

The same image is published in two places — use whichever you like:

| Registry | Image |
|---|---|
| GitHub | [`ghcr.io/ferret-project/ferret`](https://github.com/ferret-project/ferret/pkgs/container/ferret) |
| Docker Hub | [`ferretproject/ferret`](https://hub.docker.com/r/ferretproject/ferret) |

Both have the same tags, for x86-64 and 64-bit ARM: `latest` (the newest release), each release (`2026.11.2` — see
[Upgrading](./upgrading)), and for trying what's coming, `main` (the newest build, not yet released) and each build
(`sha-…`) — set `FERRET_TAG` in `.env` to one of those, and back to `latest` afterwards. `compose.yaml` uses GitHub's; for Docker Hub, change its `image:` line to
`ferretproject/ferret:${FERRET_TAG:-latest}`. Unraid, Portainer and other tools that ask for an image name take either.

## The data folder's owner

The container runs as user 1000 (group 1000), not as root, so the host folder mounted at `/data` (and at `/backups`)
must be writable by it:

```bash
sudo chown -R 1000:1000 ./data
```

Or run the container as the folder's owner instead: `user: "<uid>:<gid>"` in `compose.yaml`, `--user <uid>:<gid>` with
`docker run`. Changing the user later? Hand it everything already in the folder too (`chown -R`). If Ferret can't write
there, it says so in its log and stops.

## On Unraid

Ferret is in **Community Apps**: **Apps** → search for **Ferret** → **Install**. Set `PUBLIC_URL`; the secrets
(`AUTH_SECRET`, `FILES_KEY`) can stay empty — Ferret makes them. The template runs Ferret as `nobody:users` (99:100),
like Unraid's shares, with its data in `/mnt/user/appdata/ferret`. Backups, email, the push contact and the AI features
are under **Show more settings**.

The template itself is in `https://github.com/ferret-project/unraid-templates` — to use it without Community Apps, add
that address under **Docker** → **Template Repositories**, then **Add Container** → **Ferret**.

Ferret makes its secrets in `/mnt/user/appdata/ferret` the first time it starts, so appdata backups include them. Make a
[key file](./backups#a-key-file-for-files-key) from the container's console once it's running, and keep it off the
server.

## Behind a reverse proxy

Point the proxy at port **8787**, and set `TRUSTED_PROXIES` to the proxy's address — otherwise every visitor looks
like the proxy, and they all share one set of sign-in limits. Behind more than one (a tunnel, then Traefik), list them
all: [Tunnels and access proxies](./tunnels). Ready-made setups for Caddy, nginx and Traefik:
[Reverse proxy examples](./reverse-proxy).

## Sign-ups

`ALLOW_SIGNUP=true` (the default) lets anyone who can reach Ferret make an account — though everyone after the first must
confirm their email, so that needs [email](./email). Once your household is in, set `ALLOW_SIGNUP=false`: invited
people can still join from their invitation link.

## Support Ferret

Ferret is free and open source, and everything is in the app you run — nothing is held back for a paid version. If it's
useful to you, you can [buy the project a coffee](https://buymeacoffee.com/ferretproject). Starring
[the repository](https://github.com/ferret-project/ferret), telling a friend, and reporting what doesn't work help just as
much.
