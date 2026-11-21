/** Free disk space (lib/disk-space.ts) and new versions of Ferret (lib/updates.ts): Settings → Server, the server check, the admin's bell. */
import type { AttentionItem, DiskSpaceEntry, UpdateStatus } from "@ferret/shared";
import type { ServerCheckResult } from "../src/lib/server-check";
import { describe, expect, it } from "vitest";
import { GitHubReleases } from "../src/adapters/local/github-releases";
import { lowAt } from "../src/lib/disk-space";
import { isNewer } from "../src/lib/updates";
import type { DiskSpace, Releases } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const bell = async (u: User) => (await json<{ data: AttentionItem[] }>(u.as("/api/v1/attention"))).data.filter((a) => a.kind === "service");
const GB = 1024 ** 3;

describe("disk space", () => {
  it("warns the server admin when a disk is nearly full — in Settings, the server check and the bell", async () => {
    let free = 400 * GB;
    const disk: DiskSpace = {
      usage: async () => [
        { holds: ["database", "files"], freeBytes: free, totalBytes: 500 * GB },
        { holds: ["backups"], freeBytes: 2000 * GB, totalBytes: 4000 * GB },
      ],
    };
    const { user } = await setup({ disk });
    const ann = await user("ann"); // the first account: the server admin
    const bob = await user("bob");
    expect((await json<{ data: DiskSpaceEntry[] }>(ann.as("/api/v1/server/disk"))).data.map((d) => d.low)).toEqual([false, false]);
    expect(await bell(ann)).toEqual([]);

    free = 8 * GB;
    expect((await json<{ data: DiskSpaceEntry[] }>(ann.as("/api/v1/server/disk"))).data[0]).toMatchObject({ low: true, critical: false });
    expect(await bell(ann)).toMatchObject([{ id: "service:disk:database+files", severity: "soon", title: "The disk is nearly full", detail: expect.stringContaining("8.0 GB free of 500.0 GB on the disk with the database, photos and documents") }]);
    free = 3 * GB;
    expect((await bell(ann))[0]?.severity).toBe("urgent");
    const check = await json<ServerCheckResult>(send(ann, "POST", "/api/v1/server/check"));
    expect(check.findings.find((f) => f.kind === "disk.low")).toMatchObject({ level: "problem", examples: ["database, files: 3.0 GB free of 500.0 GB"] });
    // Only the server admin hears of it.
    expect(await bell(bob)).toEqual([]);
    expect((await bob.as("/api/v1/server/disk")).status).toBe(403);
  });

  it("is nothing where the server has no disk of its own", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await json(ann.as("/api/v1/server/disk"))).toEqual({ data: [] });
  });

  it("warns at 10% of a disk, between 1 and 10 GB", () => {
    expect(lowAt(5 * GB)).toBe(GB);
    expect(lowAt(50 * GB)).toBe(5 * GB);
    expect(lowAt(4000 * GB)).toBe(10 * GB);
  });
});

describe("new versions", () => {
  class FakeReleases implements Releases {
    asked = 0;
    constructor(readonly current: string, private readonly version = "2026.11.25") {}
    async latest() {
      this.asked++;
      return { version: this.version, name: `Ferret ${this.version}`, notes: "- Fuel economy for vehicles", url: `https://github.com/ferret-project/ferret/releases/tag/${this.version}`, publishedAt: "2026-11-21T15:00:00Z" };
    }
  }

  it("asks GitHub only once switched on, then tells the server admin about a newer release", async () => {
    const releases = new FakeReleases("2026.11.24");
    const { user, jobs } = await setup({ releases });
    const ann = await user("ann");
    expect(await json<UpdateStatus>(ann.as("/api/v1/server/updates"))).toMatchObject({ available: true, enabled: false, latest: null, newer: false });
    await jobs.drain();
    expect(releases.asked).toBe(0);
    expect(await json<UpdateStatus>(send(ann, "PUT", "/api/v1/server/updates", { enabled: true }))).toMatchObject({ enabled: true });
    await jobs.drain();
    expect(releases.asked).toBe(1);
    expect(await json<UpdateStatus>(ann.as("/api/v1/server/updates"))).toMatchObject({ current: "2026.11.24", newer: true, latest: { version: "2026.11.25", notes: "- Fuel economy for vehicles" } });
    expect(await bell(ann)).toMatchObject([{ id: "service:update:2026.11.25", title: "Ferret 2026.11.25 is out" }]);
    const bob = await user("bob");
    expect(await bell(bob)).toEqual([]);
    // Switched off: forgotten, and quiet.
    await send(ann, "PUT", "/api/v1/server/updates", { enabled: false });
    expect(await bell(ann)).toEqual([]);
    expect(await json<UpdateStatus>(ann.as("/api/v1/server/updates"))).toMatchObject({ latest: null, newer: false });
  });

  it("says nothing when this is the newest, and can't be switched on where Ferret is updated for you", async () => {
    const { user, jobs } = await setup({ releases: new FakeReleases("2026.11.25-3-gabc1234") });
    const ann = await user("ann");
    await send(ann, "PUT", "/api/v1/server/updates", { enabled: true });
    await jobs.drain();
    expect(await json<UpdateStatus>(ann.as("/api/v1/server/updates"))).toMatchObject({ newer: false, latest: { version: "2026.11.25" } });
    expect(await bell(ann)).toEqual([]);

    const hosted = await setup();
    const sam = await hosted.user("sam");
    expect(await json<UpdateStatus>(sam.as("/api/v1/server/updates"))).toMatchObject({ available: false, enabled: false });
    expect((await send(sam, "PUT", "/api/v1/server/updates", { enabled: true })).status).toBe(409);
  });

  it("compares Ferret's versions, and reads GitHub's newest release", async () => {
    expect(isNewer("2026.11.25", "2026.11.24")).toBe(true);
    expect(isNewer("2026.12.0", "2026.11.24")).toBe(true);
    expect(isNewer("2026.11.24", "2026.11.24-5-gabc")).toBe(false);
    expect(isNewer("2026.11.9", "2026.11.10")).toBe(false);
    expect(isNewer("2026.11.25", "dev")).toBe(false);

    const gh = new GitHubReleases("2026.11.24", async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/repos/ferret-project/ferret/releases/latest");
      expect(new Headers(init?.headers).get("User-Agent")).toBe("Ferret");
      return new Response(JSON.stringify({ tag_name: "2026.11.25", name: "Ferret 2026.11.25", body: "- Something new", html_url: "https://github.com/ferret-project/ferret/releases/tag/2026.11.25", published_at: "2026-11-21T15:00:00Z" }));
    });
    expect(await gh.latest()).toEqual({ version: "2026.11.25", name: "Ferret 2026.11.25", notes: "- Something new", url: "https://github.com/ferret-project/ferret/releases/tag/2026.11.25", publishedAt: "2026-11-21T15:00:00Z" });
    expect(await new GitHubReleases("dev", async () => new Response("", { status: 404 })).latest()).toBeNull();
  });
});
