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
server. A [key file](#a-key-file-for-files-key) is a second way back.
:::

## A key file for FILES_KEY

A key file holds the server's secrets — `FILES_KEY`, `AUTH_SECRET` and the push keys, whether you set them or
[Ferret made them](./configuration#secrets) — sealed with a passphrase you choose, so it can sit beside the backups, or
anywhere, and give them back if they're ever lost. It's made on the server, never in the app (on Unraid or TrueNAS, in
the container's console without `docker compose exec -it ferret`):

```bash
docker compose exec -it ferret node dist/cli.js key export /backups
```

It asks for the passphrase twice and writes `ferret-key-<fingerprint>.json`. Use a long one — a few unrelated words, 16
characters at the least — and keep it in your password manager: anyone with the file can try passphrases on their own
computer, as long as they like. Copy the file off the server.

Making one is never silent: the server admin is told (push, their other apps, email), and **Settings → Server → Access → Keys**
shows the newest key file — or that none has been made, or that the newest holds an older `FILES_KEY`. While `FILES_KEY`
is one Ferret made and there's no key file of it, the admin's bell says so. If you're told about a key file you didn't
make, someone can run commands on your server.

The fingerprint names `FILES_KEY` without giving it away. **Settings → Server** shows the running server's, and
`node dist/cli.js key fingerprint` prints the one in use — so you can check your saved copy is the right key.

To get the secrets back from the file (on any machine with Docker):

```bash
# Print them, to put in .env (or the Unraid template, or the TrueNAS app)
docker compose run --rm -v ./ferret-key-<fingerprint>.json:/key.json ferret node dist/cli.js key recover /key.json

# Or write them into a data folder, where Ferret picks them up (settings left empty)
docker compose run --rm -v ./ferret-key-<fingerprint>.json:/key.json ferret node dist/cli.js key recover /key.json /data
```

Ferret checks `FILES_KEY` when it starts: if it isn't the one its files were sealed with — a new key pasted after a
reinstall — it says which key it needs and stops, before anything is uploaded under the wrong key.

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

If Ferret made its secrets, the restore copies them (`secrets.json`) into `restored` too; backups never hold them. On a new
machine without the old data folder, write them into its data folder from a key file first (`key recover /key.json /data`).

Then stop Ferret (`docker compose stop ferret`), move the old data folder aside, put `restored` in its place, and start
it again (`docker compose up -d ferret`). Ferret updates the restored database to its own version on start, and search
indexes rebuild themselves.

## Download everything

Households can also download their own data and files, decrypted, as a ZIP — see
[Download everything](../guide/download-everything). That's a copy for people; backups are for restoring Ferret.
