# Upgrading

```bash
docker compose pull ferret
docker compose up -d ferret
```

Ferret updates its database on start, so there's nothing else to run. Your data folder, `.env` and backups are left as
they are.

Before a big upgrade, take a backup first: **Settings → Server → Back up now**.

Releases are numbered like Home Assistant's — year, month, then a count within the month: `2026.10.0`, `2026.10.1`,
then `2026.11.0`. Each is an image tag (`ghcr.io/ferret-project/ferret:2026.10.0`) and a release on GitHub listing what
changed; **Settings → Server**'s error details say which one is running.

To go back to an older version, set `FERRET_TAG` in `.env` to that version and restore the backup taken before the
upgrade — a database that a newer Ferret has updated may not work with an older one.
