# 🐾 Ferret

**Find anything you own.** A self-hosted, multi-user home inventory for your household: properties, rooms and boxes,
things with photos, receipts and manuals, warranties and claims, maintenance, stock and a shopping list, lending,
an insurance report, QR labels — and Claude, through an MCP server, to look things up and keep it up to date.

Try it: **[the demo](https://ferret-demo.digitalempire.us)** (a sample house, reset every night).

- **Your server, your data.** One Docker container with SQLite. Uploads are encrypted at rest, a key per household;
  nightly backups with a restore check; "Download everything" any time.
- **Households, not just accounts.** Owners, admins, members and read-only viewers; invitations by email.
- **AI is optional.** Point it at your own models (Ollama, any OpenAI-compatible server, docling) for suggestions
  from photos, receipts read for you, "Ask Ferret", and search by meaning. Suggestions are never applied without a tap.
- **Works on a phone.** An installable PWA: scan barcodes and QR labels, photograph a room, add things offline.
- **An API for everything.** REST at `/api/v1` (OpenAPI reference in the app) and MCP at `/mcp`, with API keys.

The help — using Ferret and running it — is built in at `/docs` (source: `apps/docs`).

## Run it (Docker)

```bash
curl -O https://raw.githubusercontent.com/ferret-project/ferret/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/ferret-project/ferret/main/.env.example
# In .env: AUTH_SECRET and FILES_KEY (each: openssl rand -base64 32), and PUBLIC_URL
docker compose up -d
```

Then open `PUBLIC_URL`; the first account made is the server admin. Keep a copy of `FILES_KEY` somewhere safe —
without it, uploaded files can't be read. Behind a reverse proxy, set `TRUSTED_PROXIES` to its address. Every
setting is in `.env.example` and the help's *Running Ferret* pages.

## Develop

Requirements: Node 26+, pnpm 10 (`npm install -g corepack && corepack enable`).

```bash
cp .env.example .env      # AUTH_SECRET and FILES_KEY, as above
pnpm install
pnpm dev                  # server on :8787, web app on :5173
pnpm test
pnpm typecheck
```

| Path | What |
|---|---|
| `apps/server` | Hono API, Better Auth, Drizzle + SQLite; MCP server; adapters behind ports (`src/ports.ts`) |
| `apps/web` | React 19 + Vite + Tailwind v4 + FlyonUI PWA |
| `apps/docs` | The help (VitePress), served at `/docs` |
| `packages/shared` | Zod schemas and helpers shared by the server and the web app |

## License

[MIT](LICENSE).
