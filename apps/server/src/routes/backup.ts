/** /api/v1/backup — the server's backups (Settings → Server, the server admin only): lib/backup.ts. */
import type { BackupSnapshot } from "@ferret/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, requireServerAdmin, requireUser } from "../lib/context";
import { BACKUP_JOB, backupStatus, checkSnapshot, listSnapshots, readManifest } from "../lib/backup";

export const backup = new Hono<AppEnv>();
backup.use(requireUser, requireServerAdmin);

const backups = (c: { var: AppEnv["Variables"] }) => {
  const b = c.var.deps.backups;
  if (!b) throw new HTTPException(409, { message: "Backups are off: set BACKUP_DIR" });
  return b;
};

backup.get("/", async (c) => {
  const { BACKUP_HOUR, BACKUP_KEEP } = c.var.config;
  return c.json(await backupStatus(c.var.db, { where: c.var.deps.backups?.target.where ?? null, hour: BACKUP_HOUR, keep: BACKUP_KEEP, elsewhere: c.var.deps.backupElsewhere }));
});

/** Starts a backup now (in the background); GET shows when it's done. */
backup.post("/", async (c) => {
  backups(c);
  await c.var.deps.jobs!.enqueue(BACKUP_JOB, {});
  return c.json({ queued: true }, 202);
});

/** The snapshots kept in the backup folder, newest first. */
backup.get("/snapshots", async (c) => {
  const { target } = backups(c);
  const data: BackupSnapshot[] = [];
  for (const name of await listSnapshots(target)) {
    const m = await readManifest(target, name);
    data.push({ name, createdAt: m.createdAt, items: m.counts.items, files: m.files.length, filesBytes: m.files.reduce((n, f) => n + f.size, 0) });
  }
  return c.json({ data });
});

/** Opens one snapshot the way a restore would; says what it found, or what's wrong. */
backup.post("/snapshots/:name/check", async (c) => {
  const b = backups(c);
  const name = c.req.param("name");
  if (!/^ferret-\d{8}T\d{6}Z$/.test(name) || !(await listSnapshots(b.target)).includes(name)) throw new HTTPException(404, { message: "No such backup" });
  try {
    const { summary } = await checkSnapshot({ ...b, filesKey: c.var.config.FILES_KEY }, name);
    return c.json({ ok: true, summary });
  } catch (err) {
    return c.json({ ok: false, summary: err instanceof Error ? err.message : String(err) });
  }
});
