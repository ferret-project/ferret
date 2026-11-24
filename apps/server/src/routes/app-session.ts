/**
 * The phone app's web screens signing in (lib/app-web-session.ts).
 * - POST /api/v1/app/web-session, DELETE /api/v1/app/web-session — the app itself, with its access token in the header.
 * - GET /app/enter?code=…&to=#/… — the app's web view, once: sets the cookie and opens the screen.
 */
import { type AppWebSessionStart, appWebSessionInput } from "@ferret/shared";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { type AppEnv, body } from "../lib/context";
import { appWebCookieName, endAppWebSessions, enterAppWebSession, isHttps, startAppWebSession } from "../lib/app-web-session";
import { ACCESS_TOKEN_PREFIX, verifyOAuthToken } from "../lib/oauth";
import { requireFeature } from "../lib/plan";

export const appWebSessions = new Hono<AppEnv>();

/** Only the app's own access token, in the header: never a key, a session, or the web screens' cookie. */
async function signedInApp(c: Context<AppEnv>) {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!bearer?.startsWith(ACCESS_TOKEN_PREFIX)) throw new HTTPException(401, { message: "This needs an app's own sign-in (OAuth)" });
  const app = await verifyOAuthToken(c.var.db, bearer);
  if (!app) throw new HTTPException(401, { message: "Sign in again: this app's sign-in has ended" });
  await requireFeature({ deps: c.var.deps, householdId: app.householdId }, "apiKeys");
  return app;
}

appWebSessions.post("/web-session", async (c) => {
  const app = await signedInApp(c);
  const { to } = await body(c.req.raw, appWebSessionInput);
  const { code, expiresAt } = await startAppWebSession(c.var.db, app);
  const query = new URLSearchParams({ code, ...(to ? { to } : {}) });
  return c.json({ url: `/app/enter?${query}`, expiresAt: expiresAt.toISOString() } satisfies AppWebSessionStart, 201);
});

appWebSessions.delete("/web-session", async (c) => {
  const app = await signedInApp(c);
  await endAppWebSessions(c.var.db, app);
  return c.body(null, 204);
});

export const appEnter = new Hono<AppEnv>();

appEnter.get("/enter", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const to = c.req.query("to");
  const screen = to && appWebSessionInput.shape.to.safeParse(to).success ? to : "#/";
  // Only opened by the app itself (a browser says "none" for that). A link from another site can't sign this browser
  // in as someone else: it just opens Ferret.
  const site = c.req.header("sec-fetch-site");
  const code = c.req.query("code");
  const entered = code && (site === undefined || site === "none") ? await enterAppWebSession(c.var.db, code) : null;
  if (entered) {
    setCookie(c, appWebCookieName(c.var.config), entered.token, {
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
      secure: isHttps(c.var.config),
      expires: entered.expiresAt,
    });
  }
  return c.redirect(`/${screen}`, 303);
});
