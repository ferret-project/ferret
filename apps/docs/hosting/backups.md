# Backups and restoring

## Nightly backups

Once a night (from `BACKUP_HOUR`, default 3:00) Ferret copies everything to a backup folder:

- the **database**, as a consistent copy taken while Ferret keeps running, **encrypted** with a key made from
  `FILES_KEY`;
- every **photo and document** — already encrypted — each copied once.

Then it **checks the copy the way a restore would**: reads it back from the folder, decrypts it, has SQLite check it,
makes sure every file is there, and decrypts a few files with the keys inside the copy. The newest `BACKUP_KEEP` (14)
copies are kept, with the files they need.

Status is in **Settings → Server** — last backup, what the check found, the copies kept (each with a **Check**
button), and **Back up now** — for the [server admin](./server-admin), whose bell also says if backups fail.

## Setting it up

The backup folder should be on **another machine** — a share on your NAS — mounted into the container:

```bash
# .env
BACKUP_DIR=/backups
FERRET_BACKUPS=/mnt/nas/ferret-backups   # on the host
```

`compose.yaml` mounts `FERRET_BACKUPS` at `/backups`. Ferret runs as **uid 1000** in the container, which must be able
to write there. For an NFS share, map all users to one owner (TrueNAS: *Mapall User*) and allow only the Ferret
host.

If the share isn't mounted when Ferret starts, backups fail (they don't quietly fill the local disk) and the bell says
so.

::: danger You need FILES_KEY to restore
A backup can only be opened with the `FILES_KEY` it was made with. Keep it in your password manager — not only on the
server.
:::

## Restoring

Restoring replaces every household's data, so it's done on the server, with commands — not from the app. In the folder
with `compose.yaml` and the same `.env`:

```bash
# See what's there, and check one
docker compose run --rm ferret node dist/cli.js backup list
docker compose run --rm ferret node dist/cli.js backup check            # the newest, or name one

# Rebuild a data folder from the newest copy (or name one at the end)
mkdir restored
docker compose run --rm -v ./restored:/restore ferret node dist/cli.js backup restore /restore
```

Then stop Ferret (`docker compose stop ferret`), move the old data folder aside, put `restored` in its place, and start
it again (`docker compose up -d ferret`). Ferret updates the restored database to its own version on start, and search
indexes rebuild themselves.

## Download everything

Households can also download their own data and files, decrypted, as a ZIP — see
[Download everything](../guide/download-everything). That's a copy for people; backups are for restoring Ferret.
