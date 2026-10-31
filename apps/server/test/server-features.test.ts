/** What a server says about how it runs: backups made elsewhere (Deps.backupElsewhere) and its optional features. */
import type { AttentionItem, BackupStatus } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import type { BackupElsewhere } from "../src/ports";
import { FakeDownloader, setup } from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

describe("backups made elsewhere", () => {
  it("are shown on Settings → Server, and in the admin's bell when they fail or stop", async () => {
    let latest: Awaited<ReturnType<BackupElsewhere["latest"]>> = null;
    const backupElsewhere: BackupElsewhere = { where: "the home server, outside the host", latest: async () => latest };
    const env = await setup({ backupElsewhere });
    const admin = await env.user("ann"); // the first account
    const bob = await env.user("bob");
    const bell = async (u: typeof admin) => (await json<{ data: AttentionItem[] }>(u.as("/api/v1/attention"))).data.filter((a) => a.kind === "backup");

    expect((await json<BackupStatus>(admin.as("/api/v1/backup"))).elsewhere).toEqual({ where: "the home server, outside the host", at: null, ok: null, detail: null });
    expect(await bell(admin)).toEqual([expect.objectContaining({ title: "Backups have stopped" })]); // none reported yet

    latest = { at: new Date(), ok: true, detail: null };
    expect((await json<BackupStatus>(admin.as("/api/v1/backup"))).elsewhere).toMatchObject({ ok: true });
    expect(await bell(admin)).toEqual([]);

    latest = { at: new Date(), ok: false, detail: "/export: HTTP 401" };
    expect(await bell(admin)).toEqual([expect.objectContaining({ title: "Backup failed", detail: expect.stringContaining("HTTP 401") })]);
    expect(await bell(bob)).toEqual([]); // only the server admin

    latest = { at: new Date(Date.now() - 3 * 86_400_000), ok: true, detail: null };
    expect(await bell(admin)).toEqual([expect.objectContaining({ title: "Backups have stopped" })]);
  });

  it("aren't mentioned on a server that makes its own (or none)", async () => {
    const env = await setup();
    const ann = await env.user("ann");
    expect((await json<BackupStatus>(ann.as("/api/v1/backup"))).elsewhere).toBeNull();
  });
});

describe("a server's optional features", () => {
  it("say whether it can add from a web address or import from Home Assistant", async () => {
    const plain = await setup();
    const ann = await plain.user("ann");
    expect((await json<{ features: object }>(ann.as("/api/v1/me"))).features).toEqual({ fromWeb: false, homeAssistant: false, roomScan: false });
    const full = await setup({ downloader: new FakeDownloader() });
    const bob = await full.user("bob");
    expect((await json<{ features: object }>(bob.as("/api/v1/me"))).features).toEqual({ fromWeb: true, homeAssistant: false, roomScan: false });
  });
});
