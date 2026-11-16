/**
 * How-to videos on maintenance tasks ("How to clean the ice maker"): YouTube videos people add to a task, by pasting a
 * link — any server; YouTube's oEmbed gives the title — or, on a server with `YOUTUBE_API_KEY`, by searching YouTube
 * from Ferret (`searchVideos`, kept a week for every household in `video_search`, so the same words cost nothing
 * again). The app plays them in YouTube's privacy-enhanced player. Only the words searched for and video ids leave the
 * server. A person picks every video; nothing is added by itself.
 */
import { type TaskVideo, type VideoHit, youtubeId } from "@ferret/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { maintenanceTask, taskVideo, videoSearch } from "../db/schema";
import type { Deps } from "../ports";
import { type Caller, logActivity, notFound } from "./inventory";
import { inList } from "./sql";

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Enough for any task; more is a list nobody watches. */
const MAX_PER_TASK = 10;

/** Whether this server can search YouTube (it has a key). */
export const canSearchVideos = (deps: Pick<Deps, "videos">) => Boolean(deps.videos?.search);

/** The videos of these tasks, oldest first, by task id. */
export async function videosOf(v: Pick<Caller, "db" | "householdId">, taskIds: string[]): Promise<Map<string, TaskVideo[]>> {
  const out = new Map<string, TaskVideo[]>();
  if (!taskIds.length) return out;
  const rows = await v.db
    .select()
    .from(taskVideo)
    .where(and(eq(taskVideo.householdId, v.householdId), inList(taskVideo.taskId, taskIds)))
    .orderBy(asc(taskVideo.createdAt));
  for (const r of rows) {
    const list = out.get(r.taskId) ?? [];
    list.push({ id: r.id, videoId: r.videoId, title: r.title, channel: r.channel, seconds: r.seconds });
    out.set(r.taskId, list);
  }
  return out;
}

async function taskOf(v: Caller, taskId: string) {
  const [task] = await v.db
    .select({ id: maintenanceTask.id, title: maintenanceTask.title, itemId: maintenanceTask.itemId })
    .from(maintenanceTask)
    .where(and(eq(maintenanceTask.id, taskId), eq(maintenanceTask.householdId, v.householdId), isNull(maintenanceTask.deletedAt)));
  if (!task) throw notFound("Maintenance task");
  return task;
}

/** Adds a video to a task from a YouTube link (or id). The same video twice is just the one. */
export async function addTaskVideo(v: Caller, taskId: string, url: string): Promise<TaskVideo> {
  const task = await taskOf(v, taskId);
  const videoId = youtubeId(url);
  if (!videoId) throw new HTTPException(400, { message: "That isn't a YouTube link" });
  const existing = (await videosOf(v, [task.id])).get(task.id) ?? [];
  const already = existing.find((x) => x.videoId === videoId);
  if (already) return already;
  if (existing.length >= MAX_PER_TASK) throw new HTTPException(400, { message: `A task can have up to ${MAX_PER_TASK} videos` });
  // What YouTube says about it: a video that isn't there (or can't be played elsewhere) is refused; if YouTube can't
  // be reached it's added anyway, without a title (the player still works).
  let info: Awaited<ReturnType<NonNullable<Deps["videos"]>["describe"]>> | undefined;
  if (v.deps.videos) {
    try {
      info = await v.deps.videos.describe(videoId);
    } catch {
      info = undefined;
    }
    if (info === null) throw new HTTPException(400, { message: "YouTube has no public video at that link that can be played in other apps" });
  }
  const [row] = await v.db
    .insert(taskVideo)
    .values({ householdId: v.householdId, taskId: task.id, videoId, title: info?.title ?? null, channel: info?.channel ?? null, seconds: info?.seconds ?? null, addedBy: v.userId })
    .onConflictDoNothing()
    .returning();
  if (!row) return ((await videosOf(v, [task.id])).get(task.id) ?? []).find((x) => x.videoId === videoId)!;
  await logActivity(v, "maintenance.update", task.id, `Added a how-to video to ${task.title}${info?.title ? `: ${info.title}` : ""}`, task.itemId);
  return { id: row.id, videoId: row.videoId, title: row.title, channel: row.channel, seconds: row.seconds };
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
