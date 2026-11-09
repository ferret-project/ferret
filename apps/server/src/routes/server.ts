import { t as translateText } from "./../lib/i18n";
/**
 * /api/v1/server — the server's own settings (Settings → Server, the server admin only): who that admin is, and
 * whether things are checked against product recalls.
 */
import { Hono } from "hono";
import { type ServerAddress, type ServerSecrets, serverAdminInput } from "@ferret/shared";
import { type AppEnv, body, requireServerAdmin, requireUser } from "../lib/context";
import { serverAdmin, setServerAdmin } from "../lib/server-admin";
import { z } from "zod";
import { RECALL_SYNC_JOB } from "../jobs/recalls";
import { recallStatus, setRecallsEnabled } from "../lib/recalls";
import { serverAiFillDefaults, setServerAiFillDefaults } from "../lib/ai-fill";
import { aiFillKinds } from "@ferret/shared";
import { demoReport } from "../lib/demo";
import { DEMO_PARTS, partsOff, setPartsOff } from "../lib/demo-switches";
import { HTTPException } from "hono/http-exception";
import { aboutServer, clearServiceErrors, listServiceErrors } from "../lib/service-errors";
import { barcodeLookupStatus } from "../lib/products";
import { MAX_FILE_BYTES, addClient, addTrusted, listCertificates, removeCertificate } from "../lib/certificates";

export const server = new Hono<AppEnv>();
server.use(requireUser, requireServerAdmin);

server.get("/admin", async (c) => c.json(await serverAdmin(c.var.db)));

/** Hands the server admin over to another (confirmed) account: from then on, only they see Settings → Server. */
server.put("/admin", async (c) => {
  const { email } = await body(c.req.raw, serverAdminInput);
  return c.json(await setServerAdmin(c.var.db, email));
});

/** PUBLIC_URL and whether it was set (Settings → Server says to set it when it isn't). */
server.get("/address", (c) => c.json({ set: c.var.config.publicUrlSet, publicUrl: c.var.config.PUBLIC_URL } satisfies ServerAddress));

/** Where each secret came from (Settings → Server → Keys) — never the secrets, bar the push public key. */
server.get("/secrets", (c) => {
  const { config, deps } = c.var;
  const names = ["FILES_KEY", "AUTH_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;
  const present = { FILES_KEY: true, AUTH_SECRET: true, VAPID_PUBLIC_KEY: !!config.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: !!config.VAPID_PRIVATE_KEY };
  return c.json({
    file: deps.secrets?.file ?? null,
    secrets: names.map((name) => ({ name, source: present[name] ? (deps.secrets?.sources[name] ?? "settings") : "none" })),
    pushPublicKey: deps.push?.publicKey ?? null,
  } satisfies ServerSecrets);
});

/** Failed calls to the services Ferret uses, newest first. */
server.get("/errors", async (c) => c.json({ data: await listServiceErrors(c.var.db, aboutServer(c.var.config, c.var.deps)) }));
/** Clear them (all, or one). */
server.delete("/errors", async (c) => {
  await clearServiceErrors(c.var.db);
  return c.body(null, 204);
});
server.delete("/errors/:id", async (c) => {
  await clearServiceErrors(c.var.db, c.req.param("id"));
  return c.body(null, 204);
});

/** The public demo's use (lib/demo.ts, lib/analytics.ts): only on the demo. */
server.get("/demo", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: translateText("Not the demo") });
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(c.req.query());
  return c.json(await demoReport(c.var.deps, c.var.config, days));
});

/** The demo's parts that are switched off (lib/demo-switches.ts), and switching them. */
server.get("/demo/switches", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: translateText("Not the demo") });
  return c.json({ off: [...(await partsOff(c.var.db))] });
});
server.put("/demo/switches", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: translateText("Not the demo") });
  const { off } = await body(c.req.raw, z.object({ off: z.array(z.enum(DEMO_PARTS)).max(DEMO_PARTS.length) }));
  return c.json({ off: [...(await setPartsOff(c.var.db, off))] });
});

/** What the demo's hosting has used, against what its plan includes (the HostingUsage port); null without one. */
server.get("/demo/usage", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: translateText("Not the demo") });
  const usage = c.var.deps.hostingUsage;
  if (!usage) return c.json({ usage: null, error: null });
  try {
    return c.json({ usage: await usage.report(new Date()), error: null });
  } catch (err) {
    return c.json({ usage: null, error: err instanceof Error ? err.message : String(err) });
  }
});

/** Certificates for Ferret's own connections (lib/certificates.ts): those trusted, and client certificates. */
server.get("/certificates", async (c) => c.json(await listCertificates(c.var.deps)));
server.post("/certificates/trusted", async (c) => {
  const input = await body(c.req.raw, z.object({ name: z.string().max(80).default(""), pem: z.string().min(1).max(MAX_FILE_BYTES) }));
  return c.json(await addTrusted(c.var.deps, c.var.config.FILES_KEY, input), 201);
});
server.post("/certificates/client", async (c) => {
  const input = await body(
    c.req.raw,
    z.object({
      name: z.string().max(80).default(""),
      hosts: z.array(z.string().max(253)).min(1).max(20),
      /** The .p12 / .pfx file, base64. */
      pkcs12: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]+=*$/, "Not base64"),
      password: z.string().max(200).default(""),
    }),
  );
  return c.json(await addClient(c.var.deps, c.var.config.FILES_KEY, input), 201);
});
server.delete("/certificates/:id", async (c) => c.json(await removeCertificate(c.var.deps, c.var.config.FILES_KEY, c.req.param("id"))));

/** Online barcode lookups: on or off, and what's left of the database's allowance today. */
server.get("/barcode-lookups", async (c) => c.json(await barcodeLookupStatus(c.var.deps)));

/** "Let AI fill in": which kinds are on by default for this server's households (each household can still choose). */
server.get("/ai-fill", async (c) => c.json(await serverAiFillDefaults(c.var.db)));
server.put("/ai-fill", async (c) => {
  const input = await body(c.req.raw, z.partialRecord(z.enum(aiFillKinds), z.boolean()));
  return c.json(await setServerAiFillDefaults(c.var.db, input));
});

/** Recall checks: whether they're on, how many brands asked about and recalls kept. */
server.get("/recalls", async (c) => c.json(await recallStatus(c.var.deps)));

/** Switch recall checks on (every household is checked straight away) or off. */
server.put("/recalls", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setRecallsEnabled(c.var.db, enabled);
  if (enabled) await c.var.deps.jobs?.enqueue(RECALL_SYNC_JOB, {});
  return c.json(await recallStatus(c.var.deps));
});
