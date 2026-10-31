# Download everything

**Household & settings → Household → Download everything** gives you all of a household's data and files in one ZIP that
opens without Ferret — to keep a copy of your own, to hand to someone, or to move elsewhere. Only the household's
**owner and admins** can download it.

## What's in it

| | |
|---|---|
| `ferret.json` | Everything: properties and places, items with their warranties, claims, files, tags, custom fields and links, maintenance and its history, service providers, categories |
| `items.csv` | The [insurance list](./insurance-report), for a spreadsheet |
| `files/` | Every photo and document, in a folder per item, as uploaded |
| `README.txt` | What's what |

Things in [Recently deleted](./recently-deleted) are left out, and so are secrets (API keys, notification addresses).

::: warning Keep it safe
In Ferret, photos and documents are encrypted. In the download **they aren't** — anyone who gets the file can open
everything in it.
:::

The download is made as it goes, straight from your data; nothing is kept on the server. With lots of photos it's
large and takes a while.

This is different from the server's [backups](../hosting/backups): a backup is the whole server, encrypted, for Ferret
to restore; this download is one household's data, for people.

## Deleting a household

**Settings → Household → Delete this household** (its owner only) deletes the household and everything in it — things,
photos, documents, places, history — for good, and everyone in it loses access. Type its name to confirm. If it's the
only household you're in, your account is deleted with it in the same step (your password confirms it). On a server
that sells plans, the household's plan ends then too. Download everything first if you might want any of it.
