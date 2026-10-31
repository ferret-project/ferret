/**
 * The Ferret app — runtime-agnostic. An entry point (server.ts for Node) builds the Deps and calls createApp().
 */
import { recordServiceError } from "./lib/service-errors";
import { z } from "zod";
import type { BetterAuthPlugin } from "better-auth";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { type Auth, MEMBERSHIP_LIMIT, createAuth } from "./auth";
import { NEW_ACCOUNT_JOB } from "./jobs/new-account";
import { NEW_PLACE_JOB, PASSKEY_ADDED_JOB, PASSWORD_CHANGED_JOB, SECURITY_ALERT_JOB } from "./jobs/security-alert";
import { MAGIC_LINK_JOB } from "./lib/magic-link";
import { mailTo } from "./lib/notifications";
import { RESET_JOB } from "./lib/password-reset";
import { VERIFY_EMAIL_JOB, emailEnabled } from "./lib/email-verification";
import { queueInvitationEmail } from "./lib/invitation-email";
import { type Config, trustedOrigins } from "./config";
import type { AppEnv } from "./lib/context";
import { countSignIns } from "./lib/analytics";
import { demoGuard } from "./lib/demo";
import { TURNSTILE_HEADER, TURNSTILE_ORIGIN, signUpHumanCheck } from "./lib/turnstile";
import { FileStore } from "./lib/files";
import type { Deps, JobHandler, Jobs } from "./ports";
import { apiKeys } from "./routes/api-keys";
import { attention } from "./routes/attention";
import { backup } from "./routes/backup";
import { server } from "./routes/server";
import { barcodes } from "./routes/barcodes";
import { downloads } from "./routes/downloads";
import { calendar, calendarSettings } from "./routes/calendar";
import { catalog } from "./routes/catalog";
import { claims } from "./routes/claims";
import { exporter } from "./routes/export";
import { inventory } from "./routes/inventory";
import { join } from "./routes/join";
import { labels, shortLinks } from "./routes/labels";
import { maintenance } from "./routes/maintenance";
import { mcp } from "./routes/mcp";
import { notifications } from "./routes/notifications";
import { providers } from "./routes/providers";
import { push } from "./routes/push";
import { security } from "./routes/security";
import { stock } from "./routes/stock";
import { pairing } from "./routes/pairing";
import { trash } from "./routes/trash";
import { imports } from "./routes/imports";
import { shared, shareShortLinks, shares } from "./routes/shares";
import { borrowed, borrowerShortLinks, loans } from "./routes/loans";
import { payoff } from "./routes/payoff";
import { unlock } from "./routes/unlock";
import { household } from "./routes/household";
import { roomScans } from "./routes/room-scans";
import { plan } from "./routes/plan";
import { memberLimit } from "./lib/plan";

/**
 * sha256 of Labels.tsx's inline print-page styles (its PAGE_STYLES: a letter sheet, and a label printer's page across or
 * as it comes) — the only inline styles the CSP allows.
 */
export const LABEL_PAGE_STYLE_HASHES = [
  "sha256-CtjabVpNplF+9c/fO8NMQkN6lJUKjXjtVcf/tdqfO3g=", // @page { size: letter; margin: 0; }
  "sha256-UgX/htrm6Yf0qwTvfrs2SoeyPTDARwpPSYnL8W7vZsE=", // @page { size: landscape; margin: 0; }
  "sha256-Rdf/YbsmqghAFqEpRQsECqy8/1wsTFWrI8d4QcD9E0k=", // @page { margin: 0; }
];

/** YouTube's privacy-enhanced player: the help's front page embeds the tour video (apps/docs/index.md). */
export const YOUTUBE_EMBED = "https://www.youtube-nocookie.com";

/** The /api routes that take files: an item's uploads, and a room scan's photos (each has its own limit). */
const UPLOAD_PATH = /^\/api\/v1\/(items\/[^/]+\/attachments|room-scans)$/;

export interface AppOptions {
  /** The help at /docs (VitePress): the sha256 of its inline scripts, from its build's csp.json. */
  docsScriptHashes?: string[];
  /**
   * A fresh nonce in each response's script-src, for a proxy in front that injects its own inline script (a CDN's bot
   * detection) and reads the nonce from this header. Nothing of ours uses it.
   */
  cspNonce?: boolean;
  /** More origins the app's pages may load scripts from and connect to (an entry point's own, e.g. a page-view beacon). */
  csp?: { scriptSrc?: string[]; connectSrc?: string[] };
  /** Auth plugins, routes, jobs and a before-delete hook added by the entry point. */
  extensions?: Extensions;
}

/**
 * Ferret's extension points, filled by the entry point. Tables of its own come from its own migrations (with a
 * prefix), run after Ferret's.
 */
export interface Extensions {
  /** Better Auth plugins, after Ferret's own. */
  authPlugins?: BetterAuthPlugin[];
  /**
   * More routes, mounted after Ferret's own: `/api/v1/...` ones use lib/context's requireUser / requireHousehold like
   * Ferret's, and need an OPERATIONS entry if they're to be in the API reference.
   */
  routes?: (app: Hono<AppEnv>) => void;
  /**
   * Called before a household or an account is deleted for good (Settings → Household / Security), in the request:
   * e.g. to end something tied to it. Throwing stops the deletion (say why: the
   * message is shown).
   */
  beforeDelete?: {
    household?: (c: Context<AppEnv>, householdId: string) => Promise<void>;
    account?: (c: Context<AppEnv>, userId: string) => Promise<void>;
  };
  /** More background jobs and periodic work, run alongside Ferret's (jobs/schedule.ts). */
  jobs?: (ctx: { deps: Deps; files: FileStore; auth: Auth; config: Config; jobs: Jobs }) => {
    handlers?: Record<string, JobHandler>;
    hourly?: () => Promise<void>;
    daily?: () => Promise<void>;
  };
}

export function createApp(deps: Deps, config: Config, opts: AppOptions = {}) {
  const { jobs, notifier } = deps;
  const auth = createAuth(deps.db, config, {
    // Slow (push, Apprise, email): jobs, so sign-in answers straight away.
    onFailedSignIns: jobs ? (alert) => jobs.enqueue(SECURITY_ALERT_JOB, alert) : undefined,
    onNewPlace: jobs ? (signIn) => jobs.enqueue(NEW_PLACE_JOB, signIn) : undefined,
    passwordReset:
      jobs && notifier && config.MAIL_URL
        ? {
            enqueue: (email) => jobs.enqueue(RESET_JOB, { email }),
            send: (to, token) =>
              notifier.send(mailTo(config.MAIL_URL!, to.email), {
                title: "Choose a new Ferret password",
                body:
                  `Hi ${to.name}, someone (hopefully you) asked to reset your Ferret password. ` +
                  `Choose a new one here — the link works once, for an hour:\n\n${config.PUBLIC_URL}/#/reset-password/${token}\n\n` +
                  "If you didn't ask, ignore this: your password stays as it is.",
              }),
            changed: (who) => jobs.enqueue(PASSWORD_CHANGED_JOB, { userId: who.id, email: who.email }),
          }
        : undefined,
    // "Email me a sign-in link" (lib/magic-link.ts): the same front as password reset, and only with email.
    magicLink:
      jobs && notifier && config.MAIL_URL
        ? {
            enqueue: (email) => jobs.enqueue(MAGIC_LINK_JOB, { email }),
            send: (email, url) =>
              notifier.send(mailTo(config.MAIL_URL!, email), {
                title: "Sign in to Ferret",
                body:
                  `Here's your link to sign in to Ferret — it works once, for 15 minutes:\n\n${url}\n\n` +
                  "If you didn't ask for it, ignore this: nobody can use it without your email.",
              }),
          }
        : undefined,
    onPasskeyAdded: jobs ? (added) => jobs.enqueue(PASSKEY_ADDED_JOB, added) : undefined,
    onAccountCreated: jobs && config.ADMIN_WEBHOOK_URL ? () => jobs.enqueue(NEW_ACCOUNT_JOB, {}) : undefined,
    // New accounts confirm their email (lib/email-verification.ts): the link goes out from a job.
    verifyEmail: emailEnabled(deps, config)
      ? (to, url) => jobs!.enqueue(VERIFY_EMAIL_JOB, { email: to.email, name: to.name, url })
      : undefined,
    // Invitations: the link is emailed too, when Ferret can send email (lib/invitation-email.ts).
    inviteEmail: emailEnabled(deps, config) ? (invitation) => queueInvitationEmail(deps.db, jobs!, invitation) : undefined,
    // A plan may limit the people in a household (lib/plan.ts).
    membershipLimit: deps.entitlements ? (householdId) => memberLimit(deps, householdId, MEMBERSHIP_LIMIT) : undefined,
    mayCreateHousehold: deps.entitlements?.mayCreateHousehold ? (userId) => deps.entitlements!.mayCreateHousehold!(userId) : undefined,
    plugins: opts.extensions?.authPlugins,
  });
  const files = new FileStore(deps.db, deps.blobs, config.FILES_KEY);
  const app = new Hono<AppEnv>();
  const origins = trustedOrigins(config);

  // Request log, without the secret in calendar feed addresses (/calendar/<token>.ics — the token is the credential).
  if (config.NODE_ENV !== "test") app.use(logger((line, ...rest) => console.log(redactTokens(line), ...rest)));
  const turnstile = deps.humanCheck && config.TURNSTILE_SITE_KEY ? [TURNSTILE_ORIGIN] : [];
  const appHeaders = secureHeaders({
    // Only Ferret's own code runs: no inline or outside scripts. 'wasm-unsafe-eval' is the barcode scanner
    // (zxing, served from here); outside https images are product photos from the online barcode database.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // Turnstile's widget (sign-up, when it's set up) is its own script and frame.
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", ...turnstile, ...(opts.csp?.scriptSrc ?? []), ...(opts.cspNonce ? [NONCE] : [])],
      // The label sheet's print margins (Labels.tsx: <style>@page…</style>), by its hash — test/hardening.test.ts checks it.
      styleSrc: ["'self'", ...LABEL_PAGE_STYLE_HASHES.map((h) => `'${h}'`)],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", ...(opts.csp?.connectSrc ?? [])],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      ...(turnstile.length && { frameSrc: turnstile }),
    },
  });
  // The help (/docs, VitePress) is static pages of our own with no user content: its few inline scripts are allowed by
  // hash, and inline style attributes (which its HTML uses) are allowed there only. Its front page plays the tour video
  // in YouTube's privacy-enhanced player (no cookies until it's played) — the only frame, and the help's only.
  const docsHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...(opts.docsScriptHashes ?? []).map((h) => `'${h}'`)],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameSrc: [YOUTUBE_EMBED],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
    },
  });
  app.use((c, next) => (c.req.path === "/docs" || c.req.path.startsWith("/docs/") ? docsHeaders(c, next) : appHeaders(c, next)));
  // JSON bodies are small; only uploads (their own limit, MAX_UPLOAD_MB) and /mcp (photos as base64) carry files.
  app.use("/api/*", (c, next) =>
    UPLOAD_PATH.test(c.req.path) ? next() : bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: { code: "http_413", message: "Request too large" } }, 413) })(c, next),
  );
  app.use(
    "/api/*",
    cors({
      origin: [config.PUBLIC_URL, ...origins],
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Household-Id", TURNSTILE_HEADER],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use(async (c, next) => {
    c.set("deps", deps);
    c.set("db", deps.db);
    c.set("auth", auth);
    c.set("config", config);
    c.set("files", files);
    c.set("extensions", opts.extensions);
    await next();
  });
  // The public demo's locks and off switch (lib/demo.ts): nothing unless DEMO is set.
  app.use(demoGuard);

  app.get("/healthz", (c) => c.json({ ok: true, app: "ferret" }));
  // "Forgot password?" and "Email me a sign-in link" answer every request alike (lib/password-reset.ts,
  // lib/magic-link.ts) — even one whose body isn't JSON, which Better Auth would otherwise turn away before the front
  // sees it. Still through its rate limiter.
  app.post("/api/auth/:path{request-password-reset|sign-in/magic-link}", async (c) => {
    const text = await c.req.text();
    let isObject = false;
    try {
      const parsed: unknown = JSON.parse(text);
      isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      // not JSON: sent on as {}
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set("content-type", "application/json");
    return auth.handler(new Request(c.req.url, { method: "POST", headers, body: isObject ? text : "{}" }));
  });
  app.post("/api/auth/sign-up/email", signUpHumanCheck);
  app.post("/api/auth/:path{sign-in/email|sign-up/email}", countSignIns);
  // Coming back from single sign-on (lib/sso.ts): a refusal Better Auth answers as an error (Ferret's sign-up rules:
  // invite-only) goes back to the sign-in screen with the reason, rather than leaving the browser on a JSON error.
  app.get("/api/auth/callback/:id", async (c) => {
    const res = await auth.handler(c.req.raw);
    if (res.status < 400 || res.headers.has("location")) return res;
    return c.redirect(`/?sso=failed&error=${res.status === 403 ? "invite_only" : "sign_in_failed"}`, 302);
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/api/v1/api-keys", apiKeys);
  app.route("/api/v1/maintenance", maintenance);
  app.route("/api/v1/attention", attention);
  app.route("/api/v1/calendar", calendarSettings);
  app.route("/api/v1/labels", labels);
  app.route("/api/v1/export", exporter);
  app.route("/api/v1/providers", providers);
  app.route("/l", shortLinks);
  app.route("/api/v1/push", push);
  app.route("/api/v1/notifications", notifications);
  app.route("/api/v1/security", security);
  app.route("/api/v1/trash", trash);
  app.route("/api/v1/import", imports);
  app.route("/api/v1/shares", shares);
  app.route("/api/v1/household", household);
  app.route("/api/v1/plan", plan);
  app.route("/api/v1/room-scans", roomScans);
  app.route("/api/v1/shared", shared);
  app.route("/s", shareShortLinks);
  app.route("/api/v1/borrowed", borrowed);
  app.route("/b", borrowerShortLinks);
  app.route("/api/v1/backup", backup);
  app.route("/api/v1/server", server);
  app.route("/api/v1/sign-in", unlock);
  app.route("/calendar", calendar);
  app.route("/api/v1", join);
  app.route("/api/v1", catalog);
  app.route("/api/v1", claims);
  app.route("/api/v1", barcodes);
  app.route("/api/v1", downloads);
  app.route("/api/v1", stock);
  app.route("/api/v1", pairing);
  app.route("/api/v1", loans);
  app.route("/api/v1", payoff);
  app.route("/api/v1", inventory);
  app.route("/mcp", mcp);
  opts.extensions?.routes?.(app);

  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: { code: "not_found", message: "Not found" } }, 404)
      : c.text("Not found", 404),
  );
  app.onError(async (err, c) => {
    if (err instanceof HTTPException) {
      return c.json(
        { error: { code: `http_${err.status}`, message: err.message, details: err.cause ?? undefined } },
        err.status,
      );
    }
    // A query string that doesn't fit its schema (bodies go through body() and are 422s already).
    if (err instanceof z.ZodError) return c.json({ error: { code: "http_422", message: "Invalid input", details: err.issues } }, 422);
    console.error(err);
    // A bug, not a refusal: in the service error log as "Ferret itself", by route (not by id), so the server admin hears.
    await recordServiceError(deps.db, "ferret", `${c.req.method} ${c.req.routePath}`, err).catch(() => {});
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  return { app, auth, files };
}

/** A log line with calendar feed tokens hidden. */
export const redactTokens = (line: string) => line.replace(/\/calendar\/[\w-]+\.ics/g, "/calendar/…ics");
