/**
 * Free space on the disks Ferret writes to (deps.disk: the database's, the uploaded files' and BACKUP_DIR's): shown in
 * Settings → Server, a finding in the server check, and the server admin's bell when one is nearly full — a full disk
 * stops uploads, the database and backups, usually without anyone noticing until something fails.
 */
import type { DiskSpaceEntry } from "@ferret/shared";
import type { Deps } from "../ports";

const GB = 1024 ** 3;

/** Under this much free space a disk is low: 10% of it, at least 1 GB and at most 10 GB. */
export function lowAt(totalBytes: number) {
  return Math.min(10 * GB, Math.max(GB, totalBytes * 0.1));
}

/** Each disk, with whether it's low (or critical: under half of that). Empty where there's no disk to look at. */
export async function diskSpace(deps: Pick<Deps, "disk">): Promise<DiskSpaceEntry[]> {
  if (!deps.disk) return [];
  const disks = await deps.disk.usage().catch(() => []);
  return disks.map((d) => ({ ...d, low: d.freeBytes < lowAt(d.totalBytes), critical: d.freeBytes < lowAt(d.totalBytes) / 2 }));
}

/** "4.2 GB" — for the bell and the server check (the web app has its own). */
export function bytesText(n: number) {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}
