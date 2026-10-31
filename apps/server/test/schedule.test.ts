import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FsBlobs } from "../src/adapters/local/blobs";
import { createApp } from "../src/app";
import { PURGE_JOB } from "../src/jobs/purge";
import { RECALL_SYNC_JOB } from "../src/jobs/recalls";
import { REMIND_JOB } from "../src/jobs/remind";
import { jobSchedule } from "../src/jobs/schedule";
import type { Deps, Jobs } from "../src/ports";
import { testDb } from "./db";
import { FakePush, config } from "./helpers";

/** A job queue that only remembers what was queued. */
const recorder = () => {
  const queued: string[] = [];
  const jobs: Jobs = { enqueue: async (type) => void queued.push(type) };
  return { jobs, queued };
};

async function scheduleWith(extra: Partial<Deps>) {
  const { db } = await testDb();
  const { jobs, queued } = recorder();
  const deps: Deps = { db, blobs: new FsBlobs(mkdtempSync(path.join(tmpdir(), "ferret-schedule-"))), jobs, ...extra };
  const { files, auth } = createApp(deps, config);
  return { schedule: jobSchedule({ deps, files, auth, config, jobs }), queued };
}

describe("the job schedule (both entry points)", () => {
  it("registers only what's configured, and queues the periodic work", async () => {
    const bare = await scheduleWith({});
    expect(bare.schedule.handlers).not.toHaveProperty(REMIND_JOB);
    expect(bare.schedule.handlers).toHaveProperty(PURGE_JOB);
    await bare.schedule.atStart();
    expect(bare.queued).toEqual([RECALL_SYNC_JOB, PURGE_JOB]);

    const withPush = await scheduleWith({ push: new FakePush() });
    expect(withPush.schedule.handlers).toHaveProperty(REMIND_JOB);
    await withPush.schedule.hourly();
    await withPush.schedule.daily();
    await withPush.schedule.every10Minutes();
    expect(withPush.queued).toEqual([REMIND_JOB, RECALL_SYNC_JOB, PURGE_JOB, "service-errors.alert"]);
  });
});
