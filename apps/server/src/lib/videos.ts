/**
 * How-to videos on maintenance tasks ("How to clean the ice maker") and on things themselves ("How to reset the ice
 * maker"): YouTube videos people add, by pasting a
 * link — any server; YouTube's oEmbed gives the title — or, on a server with `YOUTUBE_API_KEY`, by searching YouTube
 * from Ferret (`searchVideos`, kept a week for every household in `video_search`, so the same words cost nothing
 * again). The app plays them in YouTube's privacy-enhanced player. Only the words searched for and video ids leave the
 * server. A person picks every video; nothing is added by itself.
 */
import { type TaskVideo, type VideoHit, youtubeId } from "@ferret/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import { item, itemVideo, maintenanceTask, taskVideo, videoSearch } from "../db/schema";
import type { Deps } from "../ports";
import { type Caller, itemScope, logActivity, notFound } from "./inventory";
import { inList } from "./sql";

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Enough for any task or thing; more is a list nobody watches. */
const MAX_PER_OWNER = 10;

/** Whether this server can search YouTube (it has a key). */
export const canSearchVideos = (deps: Pick<Deps, "videos">) => Boolean(deps.videos?.search);

type VideoTable = typeof taskVideo | typeof itemVideo;
const ownerColumn = (table: VideoTable): SQLiteColumn => ("taskId" in table ? table.taskId : table.itemId);
const ownerOf = (row: typeof taskVideo.$inferSelect | typeof itemVideo.$inferSelect) => ("taskId" in row ? row.taskId : row.itemId);
const asVideo = (r: { id: string; videoId: string; title: string | null; channel: string | null; seconds: number | null }): TaskVideo => ({
  id: r.id,
  videoId: r.videoId,
  title: r.title,
  channel: r.channel,
  seconds: r.seconds,
});

async function videosIn(v: Pick<Caller, "db" | "householdId">, table: VideoTable, ownerIds: string[]): Promise<Map<string, TaskVideo[]>> {
  const out = new Map<string, TaskVideo[]>();
  const ids = [...new Set(ownerIds)];
  if (!ids.length) return out;
  const rows = await v.db
    .select()
    .from(table)
    .where(and(eq(table.householdId, v.householdId), inList(ownerColumn(table), ids)))
    .orderBy(asc(table.createdAt));
  for (const r of rows) {
    const list = out.get(ownerOf(r)) ?? [];
    list.push(asVideo(r));
    out.set(ownerOf(r), list);
  }
  return out;
}

/** The videos of these tasks, oldest first, by task id. */
export const videosOf = (v: Pick<Caller, "db" | "householdId">, taskIds: string[]) => videosIn(v, taskVideo, taskIds);
/** The videos of these things, oldest first, by item id. */
export const itemVideosOf = (v: Pick<Caller, "db" | "householdId">, itemIds: string[]) => videosIn(v, itemVideo, itemIds);

async function taskOf(v: Caller, taskId: string) {
  const [task] = await v.db
    .select({ id: maintenanceTask.id, title: maintenanceTask.title, itemId: maintenanceTask.itemId })
    .from(maintenanceTask)
    .where(and(eq(maintenanceTask.id, taskId), eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt)));
  if (!task) throw notFound("Maintenance task");
  return task;
}

async function itemOf(v: Caller, itemId: string) {
  const [found] = await v.db.select({ id: item.id, name: item.name }).from(item).where(and(eq(item.id, itemId), itemScope(v, { gone: "include" })));
  if (!found) throw notFound("Item");
  return found;
}

/**
 * What YouTube says about a pasted link: a video that isn't there (or can't be played elsewhere) is refused; if YouTube
 * can't be reached it's added anyway, without a title (the player still works).
 */
async function describe(v: Caller, url: string) {
  const videoId = youtubeId(url);
  if (!videoId) throw new HTTPException(400, { message: "That isn't a YouTube link" });
  if (!v.deps.videos) return { videoId, info: undefined };
  let info: Awaited<ReturnType<NonNullable<Deps["videos"]>["describe"]>> | undefined;
  try {
    info = await v.deps.videos.describe(videoId);
  } catch {
    info = undefined;
  }
  if (info === null) throw new HTTPException(400, { message: "YouTube has no public video at that link that can be played in other apps" });
  return { videoId, info };
}

/** Adds a video from a YouTube link (or id) to a task or a thing. The same video twice is just the one. */
async function addVideo(
  v: Caller,
  owner: { table: typeof taskVideo; id: string } | { table: typeof itemVideo; id: string },
  url: string,
  log: (title: string | null) => Promise<void>,
): Promise<TaskVideo> {
  const videoId = youtubeId(url);
  const existing = (await videosIn(v, owner.table, [owner.id])).get(owner.id) ?? [];
  const already = videoId && existing.find((x) => x.videoId === videoId);
  if (already) return already;
  if (existing.length >= MAX_PER_OWNER) throw new HTTPException(400, { message: `Up to ${MAX_PER_OWNER} videos each` });
  const { info } = await describe(v, url);
  const values = { householdId: v.householdId, videoId: videoId!, title: info?.title ?? null, channel: info?.channel ?? null, seconds: info?.seconds ?? null, addedBy: v.userId };
  const [row] =
    owner.table === taskVideo
      ? await v.db.insert(taskVideo).values({ ...values, taskId: owner.id }).onConflictDoNothing().returning()
      : await v.db.insert(itemVideo).values({ ...values, itemId: owner.id }).onConflictDoNothing().returning();
  if (!row) return ((await videosIn(v, owner.table, [owner.id])).get(owner.id) ?? []).find((x) => x.videoId === videoId)!;
  await log(info?.title ?? null);
  return asVideo(row);
}

export async function addTaskVideo(v: Caller, taskId: string, url: string): Promise<TaskVideo> {
  const task = await taskOf(v, taskId);
  return addVideo(v, { table: taskVideo, id: task.id }, url, (title) =>
    logActivity(v, "maintenance.update", task.id, `Added a how-to video to ${task.title}${title ? `: ${title}` : ""}`, task.itemId),
  );
}

export async function addItemVideo(v: Caller, itemId: string, url: string): Promise<TaskVideo> {
  const thing = await itemOf(v, itemId);
  return addVideo(v, { table: itemVideo, id: thing.id }, url, (title) =>
    logActivity(v, "item.update", thing.id, `Added a how-to video to ${thing.name}${title ? `: ${title}` : ""}`, thing.id),
  );
}

export async function removeTaskVideo(v: Caller, taskId: string, id: string) {
  const task = await taskOf(v, taskId);
  const [row] = await v.db
    .delete(taskVideo)
    .where(and(eq(taskVideo.id, id), eq(taskVideo.taskId, task.id), eq(taskVideo.householdId, v.householdId)))
    .returning({ title: taskVideo.title });
  if (!row) throw notFound("Video");
  await logActivity(v, "maintenance.update", task.id, `Removed a how-to video from ${task.title}${row.title ? `: ${row.title}` : ""}`, task.itemId);
  return { ok: true };
}

export async function removeItemVideo(v: Caller, itemId: string, id: string) {
  const thing = await itemOf(v, itemId);
  const [row] = await v.db
    .delete(itemVideo)
    .where(and(eq(itemVideo.id, id), eq(itemVideo.itemId, thing.id), eq(itemVideo.householdId, v.householdId)))
    .returning({ title: itemVideo.title });
  if (!row) throw notFound("Video");
  await logActivity(v, "item.update", thing.id, `Removed a how-to video from ${thing.name}${row.title ? `: ${row.title}` : ""}`, thing.id);
  return { ok: true };
}

/** YouTube's search for these words (a server with a key only); the same words within a week are answered from the last time. */
export async function searchVideos(v: Pick<Caller, "db" | "deps">, words: string): Promise<{ available: boolean; results: VideoHit[] }> {
  const search = v.deps.videos?.search;
  if (!search) return { available: false, results: [] };
  const query = words.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!query) return { available: true, results: [] };
  const key = query.toLowerCase();
  const [kept] = await v.db.select().from(videoSearch).where(and(eq(videoSearch.query, key), gt(videoSearch.checkedAt, new Date(Date.now() - FRESH_MS))));
  if (kept) return { available: true, results: kept.results };
  let results: VideoHit[];
  try {
    results = (await search(query)).map(({ videoId, title, channel, seconds }) => ({ videoId, title, channel, seconds }));
  } catch {
    throw new HTTPException(502, { message: "YouTube didn't answer — try again in a while, or paste a link" });
  }
  const values = { results, checkedAt: new Date() };
  await v.db.insert(videoSearch).values({ query: key, ...values }).onConflictDoUpdate({ target: videoSearch.query, set: values });
  return { available: true, results };
}
