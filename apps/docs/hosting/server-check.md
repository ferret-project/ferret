# Server check

**Settings → Server → Server check → Check now** (the [server admin](./server-admin) only) looks over the running
server and says what's out of order. It only reads; it changes nothing. [Backups](./backups) check their own copies
every night — this checks the live server.

## What it looks at

| It checks | What a finding means | What to do |
| --- | --- | --- |
| **Every file the database lists is in the file store** (originals and thumbnails) | A photo or document can't be opened; a thumbnail missing only means no picture in lists | Files usually go missing when the data folder was moved or restored without its `files` folder. Restore that folder from a backup ([Backups and restoring](./backups)); otherwise delete the file from its thing's page and add it again |
| **A sample of files decrypts** with its household's key | A file is damaged, or was written with a different `FILES_KEY` | Make sure `FILES_KEY` is the one this data was made with (keep it in a password manager). If only one file is affected, restore it from a backup or upload it again |
| **Nothing points at something deleted** — a thing in a deleted room or box, a place inside a deleted place, a category gone | Those things don't show where you'd expect | Open the thing and choose its room, box or category again. Report it on GitHub too — Ferret shouldn't let this happen |
| **Households have members** | Nobody can open a household | Usually left from deleting accounts; it can be ignored |
| **Work finished** — background jobs, imports sorted with AI, downloads from a web address, room scans | Something was interrupted (a restart, an AI model that was off) | Failed jobs (from the last week; older ones are cleared after 30 days) are in the **service error log** on the same page — if the cause is fixed, they need nothing. Stuck ones are tried again at the next start; otherwise do the step again |
| **Disks have room** — the database's, the files' and the backups' | One has less than 10% free (at least 1 GB, at most 10 GB) | Free some space: old backups (`BACKUP_KEEP`), other things on that disk. Or move Ferret's data folder or `BACKUP_DIR` to a bigger disk |
| **Backups are recent** | The last backup failed, or the last good one is over two days old | See **Backups** above it on the page and [Backups and restoring](./backups) |
| **AI prompts with your own instructions** (a note, not a problem) | Some prompts have extra instructions added in [AI prompts](./ai#ai-prompts) | Nothing, if AI answers look right. If they look odd, reset those prompts and try again |

On a large server it looks for at most 20,000 files in one go and says if it stopped there.
