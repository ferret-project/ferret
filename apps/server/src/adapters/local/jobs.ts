import { and, asc, eq, lte } from "drizzle-orm";
import { job } from "../../db/schema";
import type { Db, JobHandler, Jobs } from "../../ports";

interface Options {
  /** How often to look for due jobs when idle. */
  pollMs: number;
  maxAttempts: number;
  /** Retry delay doubles from here each attempt: 30s, 1m, 2m, 4m, 8m… */
  baseDelayMs: number;
  maxDelayMs: number;
}

const defaults: Options = { pollMs: 5_000, maxAttempts: 6, baseDelayMs: 30_000, maxDelayMs: 3_600_000 };

/**
 * Background jobs in a SQLite table — the Jobs port.
 * Each job type is its own lane, run one job at a time (so a busy GPU box isn't
 * flooded, and a long PDF doesn't hold up photos or search indexing). Failures
 * retry with backoff, and work resumes after a restart.
 */
export class DbJobs implements Jobs {
  private readonly opts: Options;
  private handlers: Record<string, JobHandler> = {};
  private readonly lanes = new Map<string, { timer?: ReturnType<typeof setTimeout>; busy: boolean }>();
  private started = false;

  constructor(
    private readonly db: Db,
    opts: Partial<Options> = {},
  ) {
    this.opts = { ...defaults, ...opts };
  }

  /** Queues a job. An identical job that's still waiting covers it, so repeats are dropped. */
  async enqueue(type: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const [waiting] = await this.db
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.type, type), eq(job.payload, body), eq(job.status, "pending")))
      .limit(1);
    if (!waiting) await this.db.insert(job).values({ type, payload: body });
    this.schedule(type, 0);
  }

  /** Registers what each job type does. Separate from start() so tests can drain() by hand. */
  register(handlers: Record<string, JobHandler>) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  async start() {
    // Anything "running" was interrupted by a restart: give it another go.
    await this.db.update(job).set({ status: "pending" }).where(eq(job.status, "running"));
    this.started = true;
    for (const type of Object.keys(this.handlers)) this.schedule(type, 0);
  }

  stop() {
    this.started = false;
    for (const lane of this.lanes.values()) clearTimeout(lane.timer);
  }

  /** Runs every job that's due now, one after another, across all types. */
  async drain() {
    while (await this.runNext()) {
      // keep going
    }
  }

  private schedule(type: string, ms: number) {
    if (!this.started || !this.handlers[type]) return;
    const lane = this.lanes.get(type) ?? { busy: false };
    this.lanes.set(type, lane);
    if (lane.busy) return;
    clearTimeout(lane.timer);
    lane.timer = setTimeout(() => void this.tick(type), ms);
  }

  private async tick(type: string) {
    const lane = this.lanes.get(type)!;
    if (lane.busy) return;
    lane.busy = true;
    try {
      while (await this.runNext(type)) {
        // keep going
      }
    } catch (err) {
      console.error(`Job runner (${type}):`, err);
    } finally {
      lane.busy = false;
      this.schedule(type, this.opts.pollMs);
    }
  }

  private async runNext(type?: string): Promise<boolean> {
    const due = [eq(job.status, "pending"), lte(job.runAt, new Date())];
    if (type) due.push(eq(job.type, type));
    const [next] = await this.db
      .select({ id: job.id })
      .from(job)
      .where(and(...due))
      .orderBy(asc(job.runAt))
      .limit(1);
    if (!next) return false;

    const [claimed] = await this.db
      .update(job)
      .set({ status: "running" })
      .where(and(eq(job.id, next.id), eq(job.status, "pending")))
      .returning();
    if (!claimed) return true; // taken by someone else; look again
    const attempt = claimed.attempts + 1;

    try {
      const handler = this.handlers[claimed.type];
      if (!handler) throw new Error(`No handler for job type "${claimed.type}"`);
      await handler(JSON.parse(claimed.payload), { lastAttempt: attempt >= this.opts.maxAttempts });
      await this.db.delete(job).where(eq(job.id, claimed.id));
    } catch (err) {
      const giveUp = attempt >= this.opts.maxAttempts;
      const delay = Math.min(this.opts.baseDelayMs * 2 ** (attempt - 1), this.opts.maxDelayMs);
      await this.db
        .update(job)
        .set({
          status: giveUp ? "failed" : "pending",
          attempts: attempt,
          runAt: new Date(Date.now() + delay),
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        })
        .where(eq(job.id, claimed.id));
      if (giveUp) console.warn(`Job ${claimed.type} ${claimed.id} failed for good: ${String(err)}`);
    }
    return true;
  }
}
