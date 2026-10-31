/**
 * Every background job and when the periodic ones run, for any entry point: server.ts (Node) registers the handlers
 * with its job runner and drives the periodic work with timers; another runtime drives the same schedule its own way.
 * Only what's configured is registered (no push, no reminder job).
 */
import type { Extensions } from "../app";
import type { Auth } from "../auth";
import type { Config } from "../config";
import { BACKUP_JOB, backupDue, backupJob } from "../lib/backup";
import { DOWNLOAD_JOB, downloadJob } from "../lib/downloads";
import { VERIFY_EMAIL_JOB, sendVerificationJob } from "../lib/email-verification";
import { INVITE_EMAIL_JOB, sendInvitationJob } from "../lib/invitation-email";
import type { FileStore } from "../lib/files";
import { ensureFullText, refreshFullText } from "../lib/fulltext";
import { MAGIC_LINK_JOB, magicLinkJob } from "../lib/magic-link";
import { RESET_JOB, passwordResetJob } from "../lib/password-reset";
import { PRODUCT_JOB, productLookupJob } from "../lib/products";
import { aboutServer, alertServiceErrors, recordServiceError } from "../lib/service-errors";
import type { Deps, JobHandler, Jobs } from "../ports";
import { DOCUMENT_JOB, PHOTO_JOB, analyzeAttachment } from "./analyze";
import { ROOM_SCAN_JOB, analyzeRoomScan } from "../lib/room-scans";
import { BACKFILL_JOB, INDEX_JOB, backfillIndex, indexItem } from "./index-item";
import { PDF_BACKFILL_JOB, PDF_THUMB_JOB, pdfThumbnail, pdfThumbnailBackfill } from "./pdf-thumbnail";
import { PURGE_JOB, purgeJob } from "./purge";
import { RECALL_CHECK_JOB, RECALL_SYNC_JOB, recallCheckJob, recallSyncJob } from "./recalls";
import { REMIND_JOB, sendReminders } from "./remind";
import {
  NEW_PLACE_JOB,
  PASSKEY_ADDED_JOB,
  PASSWORD_CHANGED_JOB,
  SECURITY_ALERT_JOB,
  newPlaceAlert,
  passkeyAddedAlert,
  passwordChanged,
  securityAlert,
} from "./security-alert";
import { NEW_ACCOUNT_JOB, newAccountAlert } from "./new-account";
import { UNLOCK_JOB, sendUnlockLink } from "./unlock";

const SERVICE_ALERT_JOB = "service-errors.alert";

export interface Schedule {
  handlers: Record<string, JobHandler>;
  /** Once when the server starts: catch up on what changed while it was off. */
  atStart(): Promise<void>;
  /** Services that started failing: tell the server admin (at most once every 6 hours per service). */
  every10Minutes(): Promise<void>;
  /** Reminders (each household from REMIND_HOUR where it is) and the nightly backup (from BACKUP_HOUR). */
  hourly(): Promise<void>;
  /** Deleted things purged after 30 days; recalls checked (when switched on). */
  daily(): Promise<void>;
}

export function jobSchedule({
  deps,
  files,
  auth,
  config,
  jobs,
  extensions,
}: {
  deps: Deps;
  files: FileStore;
  auth: Auth;
  config: Config;
  jobs: Jobs;
  /** The same extensions createApp got: their jobs run alongside Ferret's. */
  extensions?: Extensions;
}): Schedule {
  const { db } = deps;
  const appUrl = config.PUBLIC_URL;
  const mailUrl = config.MAIL_URL;
  const search = deps.ai && deps.vectors;
  const reminders = deps.push || deps.notifier;

  // Uploads and edits return at once; analysis, then search indexing, happen here.
  const onItemChanged = async (itemId: string) => {
    await refreshFullText(db, itemId);
    if (deps.vectors) await jobs.enqueue(INDEX_JOB, { itemId });
  };
  const analyze = analyzeAttachment({
    db,
    files,
    ai: deps.ai,
    chat: deps.chat,
    images: deps.images,
    documents: deps.documents,
    analytics: deps.analytics,
    entitlements: deps.entitlements,
    onItemChanged,
  });

  const handlers: Record<string, JobHandler> = {
    [PHOTO_JOB]: analyze,
    [DOCUMENT_JOB]: analyze,
    [ROOM_SCAN_JOB]: analyzeRoomScan({ db, files, ai: deps.ai, entitlements: deps.entitlements }),
    [DOWNLOAD_JOB]: downloadJob({ ...deps, files, maxBytes: config.MAX_UPLOAD_MB * 1024 * 1024 }),
    [SECURITY_ALERT_JOB]: securityAlert({ ...deps, files, appUrl }),
    [NEW_PLACE_JOB]: newPlaceAlert({ ...deps, files, appUrl, mailUrl }),
    [UNLOCK_JOB]: sendUnlockLink({ ...deps, files, appUrl, mailUrl }),
    [RESET_JOB]: passwordResetJob({ db, auth }),
    [MAGIC_LINK_JOB]: magicLinkJob({ db, auth }),
    [PASSKEY_ADDED_JOB]: passkeyAddedAlert({ ...deps, files, appUrl, mailUrl }),
    [VERIFY_EMAIL_JOB]: sendVerificationJob({ notifier: deps.notifier, mailUrl }),
    [INVITE_EMAIL_JOB]: sendInvitationJob({ ...deps, appUrl, mailUrl }),
    [PASSWORD_CHANGED_JOB]: passwordChanged({ ...deps, files, appUrl, mailUrl }),
    [NEW_ACCOUNT_JOB]: newAccountAlert({ db: deps.db, appUrl, adminWebhook: config.ADMIN_WEBHOOK_URL }),
    [SERVICE_ALERT_JOB]: async () => void (await alertServiceErrors({ ...deps, files, appUrl, about: aboutServer(config, deps), mailUrl, adminWebhook: config.ADMIN_WEBHOOK_URL })),
    [RECALL_SYNC_JOB]: recallSyncJob(deps),
    [RECALL_CHECK_JOB]: recallCheckJob(deps),
    [PURGE_JOB]: purgeJob({ ...deps, files }),
  };
  if (deps.pdfPages && deps.images) {
    handlers[PDF_THUMB_JOB] = pdfThumbnail({ db, files, pdfPages: deps.pdfPages, images: deps.images });
    handlers[PDF_BACKFILL_JOB] = pdfThumbnailBackfill({ db, jobs });
  }
  if (deps.products) handlers[PRODUCT_JOB] = productLookupJob(deps);
  if (search) {
    handlers[INDEX_JOB] = indexItem({ db, ai: deps.ai!, vectors: deps.vectors! });
    handlers[BACKFILL_JOB] = backfillIndex({ db, jobs });
  }
  if (reminders) handlers[REMIND_JOB] = sendReminders({ ...deps, files, appUrl, remindHour: config.REMIND_HOUR, mailUrl });
  if (deps.backups) handlers[BACKUP_JOB] = backupJob({ db, blobs: deps.blobs, ...deps.backups, filesKey: config.FILES_KEY, keep: config.BACKUP_KEEP });
  const extra = extensions?.jobs?.({ deps, files, auth, config, jobs });
  Object.assign(handlers, extra?.handlers);
  // A job that fails on its last try is given up: in the service error log (as "jobs", by type), so the server admin hears.
  for (const [type, handler] of Object.entries(handlers)) {
    handlers[type] = async (payload, ctx) => {
      const started = Date.now();
      try {
        await handler(payload, ctx);
      } catch (err) {
        if (ctx.lastAttempt) await recordServiceError(db, "jobs", type, err, new Date(), { ms: Date.now() - started }).catch(() => {});
        throw err;
      }
    };
  }

  /** Queues a job; trouble queueing is logged, never thrown into a timer. */
  const enqueue = (type: string) => jobs.enqueue(type, {}).catch((err) => console.warn(`Couldn't queue ${type}: ${String(err)}`));
  const hourly = async () => {
    if (reminders) await enqueue(REMIND_JOB);
    if (deps.backups) {
      // One a day from BACKUP_HOUR; a failed one is tried again the next hour.
      const due = await backupDue(db, config.BACKUP_HOUR).catch((err) => console.warn(`Backup check failed: ${String(err)}`));
      if (due) await enqueue(BACKUP_JOB);
    }
    await extra?.hourly?.().catch((err) => console.warn(`An extension's hourly work failed: ${String(err)}`));
  };
  const daily = async () => {
    await enqueue(RECALL_SYNC_JOB);
    await enqueue(PURGE_JOB);
    await extra?.daily?.().catch((err) => console.warn(`An extension's daily work failed: ${String(err)}`));
  };

  return {
    handlers,
    atStart: async () => {
      if (handlers[PDF_BACKFILL_JOB]) await enqueue(PDF_BACKFILL_JOB); // PDFs from before thumbnails
      if (search) await enqueue(BACKFILL_JOB); // anything new or changed while search was off
      await daily();
      await hourly();
      await ensureFullText(db); // fills the keyword index the first time
    },
    every10Minutes: async () => void (await enqueue(SERVICE_ALERT_JOB)),
    hourly,
    daily,
  };
}
