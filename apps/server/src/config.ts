import { z } from "zod";

/**
 * All runtime configuration comes from environment variables, so the same
 * code runs wherever its entry point (server.ts) is started.
 */
/** docling's form fields: object values as JSON strings. */
const formFields = (options: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(options).map(([k, val]) => [k, typeof val === "string" ? val : JSON.stringify(val)]));

/** docling's VLM pipeline with granite-docling at DOCLING_VLM_URL (an OpenAI-compatible chat completions endpoint). */
const vlmDoclingOptions = (url: string) => ({
  pipeline: "vlm",
  vlm_pipeline_model_api: {
    url,
    params: { model: "granite-docling", max_tokens: 6500, repetition_penalty: 1.05, skip_special_tokens: false },
    prompt: "Convert this page to docling.",
    response_format: "doctags",
    timeout: 180,
    concurrency: 4,
  },
});

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8787),
  /** Public URL the app is reached at, e.g. https://ferret.example.com */
  PUBLIC_URL: z.url().default("http://localhost:8787"),
  /**
   * Extra origins allowed to call the API with a sign-in (comma separated), e.g. the Vite dev server in
   * development. Unset, that's http://localhost:5173 outside production and nothing in production.
   */
  TRUSTED_ORIGINS: z.string().optional(),
  /**
   * The reverse proxies (e.g. Traefik) whose X-Forwarded-For is believed, as IP addresses or CIDR ranges, comma
   * separated. A request from anywhere else is taken to come from its own address, so nobody can claim another
   * one to dodge the sign-in limits. Unset: only loopback (a proxy on the same host).
   */
  TRUSTED_PROXIES: z.string().default("127.0.0.1,::1"),
  /** 32+ random characters. Generate with: openssl rand -base64 32 */
  AUTH_SECRET: z.string().min(32),
  /**
   * Master key that protects every household's file key (32 random bytes, base64).
   * Generate with: openssl rand -base64 32. Losing it makes uploaded files unreadable,
   * so keep a copy in a password manager — and not in the same backup as DATA_DIR.
   */
  FILES_KEY: z.string().refine((v) => base64Length(v) === 32, {
    message: "must be 32 random bytes, base64 encoded (openssl rand -base64 32)",
  }),
  /** Largest upload accepted, in megabytes. */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  /** Directory holding ferret.db and uploaded files. */
  DATA_DIR: z.string().default("./data"),
  /** Directory with the built web app (served as static files). */
  WEB_DIST: z.string().default("../web/dist"),
  /** Directory with the built help (VitePress), served at /docs. */
  DOCS_DIST: z.string().default("../docs/.vitepress/dist"),
  /**
   * "Are you a person?" before sign-up (a Turnstile widget): both keys from the widget, and the
   * hostnames its tokens may come from (comma separated; unset = PUBLIC_URL's). Unset, there's no check.
   */
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),
  TURNSTILE_HOSTNAMES: z.string().optional(),
  /**
   * Single sign-on with an OpenID Connect provider (Authelia, Pocket ID, Authentik, Keycloak…), self-hosted Ferret
   * only (lib/sso.ts). The issuer's address (its discovery document is at /.well-known/openid-configuration), and the
   * client Ferret is registered as there — redirect URI PUBLIC_URL/api/auth/callback/oidc. Unset: off.
   */
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default("openid email profile"),
  /**
   * How Ferret sends its client secret to the provider's token endpoint: "basic" (an Authorization header — the OIDC
   * default, and Authelia's and Pocket ID's) or "post" (in the form).
   */
  OIDC_CLIENT_AUTH: z.enum(["basic", "post"]).default("basic"),
  /** The sign-in button's words: "Sign in with <OIDC_NAME>". */
  OIDC_NAME: z.string().default("single sign-on"),
  /**
   * Sign-in by a forward-auth proxy's headers (Authelia, Authentik, oauth2-proxy…): off unless "true", and then only
   * from TRUSTED_HEADER_PROXIES (IP addresses or ranges, comma separated — the proxy itself, never "everyone"). The
   * proxy must strip these headers from what clients send. Self-hosted only (the Node server; lib/sso.ts).
   */
  TRUSTED_HEADER_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TRUSTED_HEADER_PROXIES: z.string().default(""),
  TRUSTED_HEADER_USER: z.string().default("Remote-User"),
  TRUSTED_HEADER_EMAIL: z.string().default("Remote-Email"),
  TRUSTED_HEADER_NAME: z.string().default("Remote-Name"),
  /**
   * Which Ferret this is: the release (2026.10.0 — Home Assistant's year.month.patch), or `git describe` between
   * releases (2026.10.0-3-gabc1234). Set by the build (the Docker image); unset: "dev".
   */
  FERRET_VERSION: z.string().default("dev"),
  /** Allow new accounts to sign up. Turn off once the family is in. */
  ALLOW_SIGNUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * The public demo: a shared demo account whose password is shown on the sign-in
   * screen, its household reset every night, visitors' own accounts deleted after DEMO_VISITOR_DAYS, a daily AI budget.
   * Never set on a real Ferret.
   */
  DEMO: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DEMO_EMAIL: z.email().default("demo@example.com"),
  /** Shown on the sign-in screen: it's the demo's, not a secret. */
  DEMO_PASSWORD: z.string().min(8).default("try-ferret-demo"),
  /** The demo's server admin (made first, so it's the admin): not shown anywhere; a secret. */
  DEMO_ADMIN_EMAIL: z.email().optional(),
  DEMO_ADMIN_PASSWORD: z.string().min(12).optional(),
  DEMO_VISITOR_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** AI calls a day, all households together (photos, documents, questions, the search judge, embeddings). */
  DEMO_AI_PER_DAY: z.coerce.number().int().min(0).default(400),
  /** The off switch: every page says the demo is resting. */
  DEMO_PAUSED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Hour of the day (server time — set TZ) when reminders (push and Apprise) go out. */
  REMIND_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  /**
   * Nightly backups: a folder off this machine (e.g. an NFS share on the NAS, mounted into the container). Each
   * night the database (encrypted with a key made from FILES_KEY) and any new files are copied there and checked.
   * Off when unset.
   */
  BACKUP_DIR: z.string().optional(),
  /** Hour of the day (server time) backups start. */
  BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  /** How many nightly copies of the database to keep (the files they need are kept with them). */
  BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  // ── Optional integrations: each feature switches on when its settings are present ──
  /**
   * Look up scanned barcodes in a product database: "upcitemdb" (100 a day free, no key). Only the barcode is sent,
   * from the server. Off when unset.
   */
  BARCODE_LOOKUP: z.enum(["upcitemdb"]).optional(),
  /** A paid UPCitemdb plan's key (more lookups a day); without it, the free tier. */
  UPCITEMDB_KEY: z.string().optional(),
  /** Web Push for maintenance reminders: `npx web-push generate-vapid-keys`. Both keys, or neither. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Who push services can contact about this sender: a mailto: or https: URL. Default: admin@ PUBLIC_URL's host. */
  VAPID_SUBJECT: z.string().optional(),
  /**
   * apprise-api (the caronc/apprise container), e.g. http://apprise:8000. Lets people get reminders in
   * ntfy, Pushover, Telegram, email and 100+ other apps, each set up in Settings with an Apprise URL.
   */
  APPRISE_URL: z.url().optional(),
  /**
   * Email for Ferret itself (needs APPRISE_URL): an Apprise mailto URL to send from, e.g.
   * mailtos://you:app-password@gmail.com — each message is addressed to its person. Used for
   * "email me a link to sign in again"; without it those links go to push and Apprise only.
   */
  MAIL_URL: z.string().regex(/^mailtos?:\/\//, "must be an Apprise mailto:// or mailtos:// URL").optional(),
  /**
   * A Discord webhook for the server admin's alerts (a service failing, unexpected errors): they're posted there too,
   * e.g. to an admins' channel. Discord: channel settings → Integrations → Webhooks → New webhook → Copy URL.
   */
  ADMIN_WEBHOOK_URL: z
    .string()
    .regex(/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//, "must be a Discord webhook URL (https://discord.com/api/webhooks/…)")
    .optional(),
  /**
   * Apple Maps pictures of each property's address (Maps Web Snapshots): an Apple Developer Team ID, and the Key ID
   * and private key (.p8 contents — PEM, or just its base64 body) of a Maps key with MapKit JS enabled. All three,
   * or none. The server fetches the pictures, so the key stays here and Apple never sees the browsers.
   */
  APPLE_MAPS_TEAM_ID: z.string().optional(),
  APPLE_MAPS_KEY_ID: z.string().optional(),
  APPLE_MAPS_PRIVATE_KEY: z.string().optional(),
  /** Ollama (OpenAI-compatible API), e.g. http://gpu.lan:11434. Enables photo analysis and embeddings. */
  OLLAMA_URL: z.url().optional(),
  /** Vision model used to describe photos and read receipts/labels. */
  VISION_MODEL: z.string().default("qwen3-vl:8b"),
  /**
   * A stronger text model (OpenAI-compatible, e.g. vLLM at http://gpu.lan:8000/v1) for
   * Ask Ferret and reading documents. Without it, VISION_MODEL does those too.
   */
  CHAT_URL: z.url().optional(),
  CHAT_MODEL: z.string().default("gpt-oss-120b"),
  /** reasoning_effort for reasoning models: low keeps answers to a few seconds. Empty to omit. */
  CHAT_REASONING: z.string().default("low"),
  /** Embedding model for semantic search. Changing it means a new QDRANT_COLLECTION (different vector size). */
  EMBED_MODEL: z.string().default("qwen3-embedding:8b"),
  /** docling-serve, e.g. http://docling.lan:5001. Enables text extraction from PDFs and scanned documents. */
  DOCLING_URL: z.url().optional(),
  /**
   * granite-docling behind an OpenAI-compatible API (e.g. vLLM: http://gpu.lan:8001/v1/chat/completions): docling reads
   * pages with its VLM pipeline through it. Without it (and without DOCLING_OPTIONS), docling's standard pipeline.
   */
  DOCLING_VLM_URL: z.url().optional(),
  /** Extra docling form fields as JSON (object values are sent as JSON strings), instead of the above. */
  DOCLING_OPTIONS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      try {
        return formFields(JSON.parse(v) as Record<string, unknown>);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be a JSON object" });
        return z.NEVER;
      }
    }),
  /** Qdrant, e.g. http://qdrant.lan:6333. With OLLAMA_URL, enables semantic search. */
  QDRANT_URL: z.url().optional(),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().default("ferret"),
  /** Reranker with a /v1/rerank API (vLLM), e.g. http://gpu.lan:8002. Refines smart search. */
  RERANK_URL: z.url().optional(),
  RERANK_MODEL: z.string().default("reranker"),
});

function base64Length(value: string) {
  try {
    return atob(value).length;
  } catch {
    return -1;
  }
}

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  // Without its own admin, the demo account would be the first account, and so the server admin.
  if (parsed.data.DEMO && !(parsed.data.DEMO_ADMIN_EMAIL && parsed.data.DEMO_ADMIN_PASSWORD)) {
    throw new Error("Invalid configuration:\n  DEMO needs DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD (the demo's own server admin)");
  }
  const c = parsed.data;
  if (c.OIDC_ISSUER && !c.OIDC_CLIENT_ID) throw new Error("Invalid configuration:\n  OIDC_ISSUER needs OIDC_CLIENT_ID (and usually OIDC_CLIENT_SECRET)");
  if (c.TRUSTED_HEADER_AUTH && !c.TRUSTED_HEADER_PROXIES.trim()) {
    throw new Error("Invalid configuration:\n  TRUSTED_HEADER_AUTH needs TRUSTED_HEADER_PROXIES (the sign-in proxy's address)");
  }
  return c;
}

/** What's sent to docling with each document: DOCLING_OPTIONS, else the VLM pipeline at DOCLING_VLM_URL, else docling's defaults. */
export function doclingOptions(config: Pick<Config, "DOCLING_OPTIONS" | "DOCLING_VLM_URL">): Record<string, string> {
  return config.DOCLING_OPTIONS ?? (config.DOCLING_VLM_URL ? formFields(vlmDoclingOptions(config.DOCLING_VLM_URL)) : {});
}

/** Web Push's contact for this server: VAPID_SUBJECT, else admin@ the public host. */
export function vapidSubject(config: Pick<Config, "VAPID_SUBJECT" | "PUBLIC_URL">) {
  return config.VAPID_SUBJECT ?? `mailto:admin@${new URL(config.PUBLIC_URL).hostname}`;
}

/** The origins trusted besides PUBLIC_URL (TRUSTED_ORIGINS, or its default for the environment). */
export function trustedOrigins(config: Pick<Config, "TRUSTED_ORIGINS" | "NODE_ENV">) {
  const raw = config.TRUSTED_ORIGINS ?? (config.NODE_ENV === "production" ? "" : "http://localhost:5173");
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}
