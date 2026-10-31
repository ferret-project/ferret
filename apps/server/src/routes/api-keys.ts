/**
 * /api/v1/api-keys — the signed-in user's API keys for the current household
 * (Settings → API keys). Only a real sign-in can manage keys: a key can't make
 * or see other keys.
 */
import { type ApiKeySummary, apiKeyInput, type NewApiKey } from "@ferret/shared";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { apikey } from "../db/schema";
import { type KeyMetadata, KEY_PREFIX } from "../lib/api-keys";
import { countEvent } from "../lib/analytics";
import { requireFeature } from "../lib/plan";
import { type AppEnv, requireHousehold, requireSession, requireUser } from "../lib/context";

export const apiKeys = new Hono<AppEnv>();
apiKeys.use(requireUser, requireSession, requireHousehold);

type KeyRow = typeof apikey.$inferSelect;

const metadataOf = (row: Pick<KeyRow, "metadata">): Partial<KeyMetadata> => {
  try {
    return typeof row.metadata === "string" ? JSON.parse(row.metadata) : {};
  } catch {
    return {};
  }
};

const summary = (row: KeyRow): ApiKeySummary => ({
  id: row.id,
  name: row.name,
  start: row.start,
  readOnly: metadataOf(row).readOnly ?? false,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastRequest?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
});

/** This user's keys for this household. */
async function ownKeys(c: { var: AppEnv["Variables"] }) {
  const rows = await c.var.db
    .select()
    .from(apikey)
    .where(eq(apikey.referenceId, c.var.user.id))
    .orderBy(desc(apikey.createdAt));
  return rows.filter((row) => metadataOf(row).householdId === c.var.householdId);
}

apiKeys.get("/", async (c) => c.json({ data: (await ownKeys(c)).map(summary) }));

apiKeys.post("/", async (c) => {
  await requireFeature({ deps: c.var.deps, householdId: c.var.householdId }, "apiKeys");
  const parsed = apiKeyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid input", cause: parsed.error.issues });
  const { name, readOnly, expiresInDays } = parsed.data;
  const metadata: KeyMetadata = {
    householdId: c.var.householdId,
    // Someone with read-only access to the household only gets read-only keys.
    readOnly: readOnly || c.var.role === "viewer",
  };
  const created = await c.var.auth.api.createApiKey({
    body: {
      userId: c.var.user.id,
      name,
      prefix: KEY_PREFIX,
      metadata,
      expiresIn: expiresInDays ? expiresInDays * 24 * 60 * 60 : null,
    },
  });
  const [row] = await c.var.db.select().from(apikey).where(eq(apikey.id, created.id));
  const result: NewApiKey = { ...summary(row!), key: created.key };
  countEvent(c.var.deps, "api_key.create");
  return c.json(result, 201);
});

apiKeys.delete("/:id", async (c) => {
  const key = (await ownKeys(c)).find((k) => k.id === c.req.param("id"));
  if (!key) throw new HTTPException(404, { message: "API key not found" });
  await c.var.db.delete(apikey).where(and(eq(apikey.id, key.id), eq(apikey.referenceId, c.var.user.id)));
  return c.body(null, 204);
});
