/** How-to videos on maintenance tasks (lib/videos.ts): pasted YouTube links, and YouTube search with a key. */
import { type MaintenanceTask, type TaskVideo, youtubeId } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { isoSeconds } from "../src/adapters/local/youtube";
import { activity, member } from "../src/db/schema";
import type { VideoInfo, Videos } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const CLEAN = "dQw4w9WgXcQ";
const FILTER = "aBcDeFgHiJk";

class FakeYouTube implements Videos {
  described: string[] = [];
  searched: string[] = [];
  search?: (q: string) => Promise<VideoInfo[]>;
  constructor(withKey: boolean) {
    if (withKey)
      this.search = async (q) => {
        this.searched.push(q);
        return [{ videoId: CLEAN, title: "How to clean a GE ice maker", channel: "Appliance Help", seconds: 312 }];
      };
  }
  async describe(videoId: string) {
    this.described.push(videoId);
    if (videoId === "PrivateVid1") return null;
    return { videoId, title: videoId === CLEAN ? "How to clean a GE ice maker" : "Ice maker filter swap", channel: "Appliance Help", seconds: null };
  }
}

describe("YouTube links", () => {
  it("finds the video id in the usual link shapes", () => {
    expect(youtubeId(`https://www.youtube.com/watch?v=${CLEAN}&t=42s`)).toBe(CLEAN);
    expect(youtubeId(`https://youtu.be/${CLEAN}?si=abc`)).toBe(CLEAN);
    expect(youtubeId(`youtube.com/shorts/${CLEAN}`)).toBe(CLEAN);
    expect(youtubeId(`https://m.youtube.com/watch?v=${CLEAN}`)).toBe(CLEAN);
    expect(youtubeId(`https://www.youtube-nocookie.com/embed/${CLEAN}`)).toBe(CLEAN);
    expect(youtubeId(CLEAN)).toBe(CLEAN);
    expect(youtubeId(`https://example.com/watch?v=${CLEAN}`)).toBeNull();
    expect(youtubeId("https://www.youtube.com/@FerretProject")).toBeNull();
    expect(youtubeId("not a link")).toBeNull();
  });

  it("reads YouTube's lengths", () => {
    expect(isoSeconds("PT5M12S")).toBe(312);
    expect(isoSeconds("PT1H2M3S")).toBe(3723);
    expect(isoSeconds("P0D")).toBe(0);
    expect(isoSeconds("nonsense")).toBeNull();
  });
});

describe("how-to videos on tasks", () => {
  it("are added from a pasted link, shown on the task, once each, and removed", async () => {
    const yt = new FakeYouTube(false);
    const { user, db } = await setup({ videos: yt });
    const ann = await user("ann");
    const task = await json<MaintenanceTask>(send(ann, "POST", "/api/v1/maintenance", { title: "Clean the ice maker", intervalCount: 6, intervalUnit: "month" }));
    expect(task.videos).toEqual([]);

    const added = await send(ann, "POST", `/api/v1/maintenance/${task.id}/videos`, { url: `https://youtu.be/${CLEAN}` });
    expect(added.status).toBe(201);
    const video = await json<TaskVideo>(added);
    expect(video).toMatchObject({ videoId: CLEAN, title: "How to clean a GE ice maker", channel: "Appliance Help" });
    // The same video again is the one already there.
    expect((await json<TaskVideo>(send(ann, "POST", `/api/v1/maintenance/${task.id}/videos`, { url: `https://www.youtube.com/watch?v=${CLEAN}` }))).id).toBe(video.id);
    await send(ann, "POST", `/api/v1/maintenance/${task.id}/videos`, { url: FILTER });
    const listed = await json<{ data: MaintenanceTask[] }>(ann.as("/api/v1/maintenance"));
    expect(listed.data[0]!.videos.map((v) => v.videoId)).toEqual([CLEAN, FILTER]);

    // Not YouTube, or no such public video: refused.
    expect((await send(ann, "POST", `/api/v1/maintenance/${task.id}/videos`, { url: "https://example.com/video" })).status).toBe(400);
    expect((await send(ann, "POST", `/api/v1/maintenance/${task.id}/videos`, { url: "https://youtu.be/PrivateVid1" })).status).toBe(400);

    expect((await send(ann, "DELETE", `/api/v1/maintenance/${task.id}/videos/${video.id}`)).status).toBe(200);
    expect((await json<MaintenanceTask>(ann.as(`/api/v1/maintenance/${task.id}`))).videos.map((v) => v.videoId)).toEqual([FILTER]);
    expect((await send(ann, "DELETE", `/api/v1/maintenance/${task.id}/videos/${video.id}`)).status).toBe(404);

    // History says so.
    const history = await db.select({ summary: activity.summary }).from(activity);
    expect(JSON.stringify(history)).toContain("Added a how-to video to Clean the ice maker: How to clean a GE ice maker");
  });

  it("are added without a title when YouTube can't be reached, and with none when the server has no YouTube", async () => {
    const down: Videos = { describe: async () => Promise.reject(new Error("offline")) };
    const { user } = await setup({ videos: down });
    const ann = await user("ann");
    const task = await json<MaintenanceTask>(send(ann, "POST", "/api/v1/maintenance", { title: "Change the filter" }));
    expect(await json(send(ann, "POST", `/api/v1/maintenance/${task.id}/videos`, { url: CLEAN }))).toMatchObject({ videoId: CLEAN, title: null });
  });

  it("can be searched for only with a YouTube key, by writers, and the same words aren't asked twice", async () => {
    const without = await setup({ videos: new FakeYouTube(false) });
    const amy = await without.user("amy");
    expect(await json(amy.as("/api/v1/maintenance/videos/search?q=ice%20maker"))).toEqual({ available: false, results: [] });
    expect((await json<{ features: { videoSearch: boolean } }>(amy.as("/api/v1/me"))).features.videoSearch).toBe(false);

    const yt = new FakeYouTube(true);
    const { user, db } = await setup({ videos: yt });
    const ann = await user("ann");
    const bob = await user("bob");
    expect((await json<{ features: { videoSearch: boolean } }>(ann.as("/api/v1/me"))).features.videoSearch).toBe(true);
    const found = await json<{ available: boolean; results: VideoInfo[] }>(ann.as("/api/v1/maintenance/videos/search?q=GE%20ice%20maker%20clean"));
    expect(found).toEqual({ available: true, results: [{ videoId: CLEAN, title: "How to clean a GE ice maker", channel: "Appliance Help", seconds: 312 }] });
    await ann.as("/api/v1/maintenance/videos/search?q=ge%20ice%20maker%20%20CLEAN");
    expect(yt.searched).toEqual(["GE ice maker clean"]);

    // Viewers can't (it spends the server's daily allowance).
    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "viewer", createdAt: new Date() });
    expect((await bob.as("/api/v1/maintenance/videos/search?q=other", { headers: { "X-Household-Id": ann.householdId } })).status).toBe(403);
    expect(yt.searched).toHaveLength(1);
  });
});
