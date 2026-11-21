/**
 * Free space on the disks Ferret writes to: the database's folder, the uploaded files' and BACKUP_DIR. Folders on the
 * same disk (the same device) are one entry.
 */
import { stat, statfs } from "node:fs/promises";
import type { DiskSpace } from "../../ports";

type Hold = "database" | "files" | "backups";

export class LocalDiskSpace implements DiskSpace {
  constructor(private readonly folders: { holds: Hold; path: string }[]) {}

  async usage() {
    const disks = new Map<string, { holds: Hold[]; freeBytes: number; totalBytes: number }>();
    for (const f of this.folders) {
      // A folder that isn't there (yet) or can't be read says nothing about free space.
      const [s, fs] = await Promise.all([stat(f.path), statfs(f.path)]).catch(() => [null, null] as const);
      if (!s || !fs) continue;
      const key = String(s.dev);
      const had = disks.get(key);
      if (had) {
        if (!had.holds.includes(f.holds)) had.holds.push(f.holds);
        continue;
      }
      // bavail: what an ordinary user (Ferret) may still write — not the blocks kept for root.
      disks.set(key, { holds: [f.holds], freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize });
    }
    return [...disks.values()];
  }
}
