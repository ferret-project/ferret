# Settings (.env)

Everything is set in `.env` next to `compose.yaml`; restart Ferret after a change (`docker compose up -d`). Optional
features switch on when their settings are present, and Ferret's log lists what's on when it starts.

## Required

| Setting | |
|---|---|
| `AUTH_SECRET` | Signs sessions. 32+ random characters: `openssl rand -base64 32`. |
| `FILES_KEY` | Master key for uploaded files: `openssl rand -base64 32`. **Keep a copy in your password manager.** |
| `PUBLIC_URL` | The address people (and Claude) use, e.g. `https://ferret.example.lan`. |

## General

| Setting | Default | |
|---|---|---|
| `ALLOW_SIGNUP` | `true` | Open sign-up. Set `false` once everyone's in; invitations still work. |
| `TRUSTED_PROXIES` | loopback | Your reverse proxy's address(es), if it's on another machine. |
| `TRUSTED_ORIGINS` | — | Extra origins allowed to call the API with a sign-in (development). Leave unset. |
| `MAX_UPLOAD_MB` | `25` | Largest photo or document. |
| `TZ` | system | The server's time zone, e.g. `America/Denver`: when backups run, and the time zone for households that haven't chosen their own (**Settings → Household → Time zone**). |
| `FERRET_DATA` | `./data` | Where the data folder is on the host (compose). |
| `FERRET_PORT` | `8787` | Port on the host (compose). |
| `FERRET_VERSION` | from the image | Which release this is (e.g. `2026.10.0`). Set by the Docker image — leave it unset. |

## Single sign-on — [details](./single-sign-on)

| Setting | Default | |
|---|---|---|
| `OIDC_ISSUER` | off | Your OpenID provider's address (Authelia, Pocket ID…): a **Sign in with …** button. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | — | The client registered there for Ferret (redirect URI `PUBLIC_URL/api/auth/callback/oidc`). |
| `OIDC_NAME` | `single sign-on` | The button's words: "Sign in with …". |
| `OIDC_SCOPES` | `openid email profile` | |
| `OIDC_CLIENT_AUTH` | `basic` | How the secret is sent to the token endpoint: `basic` or `post`. |
| `TRUSTED_HEADER_AUTH` | `false` | Sign in by a forward-auth proxy's headers. |
| `TRUSTED_HEADER_PROXIES` | — | The proxy's address(es) — the only place those headers are believed from. Required with the above. |
| `TRUSTED_HEADER_USER`, `TRUSTED_HEADER_EMAIL`, `TRUSTED_HEADER_NAME` | `Remote-User`, `Remote-Email`, `Remote-Name` | The headers' names. |

## Backups — [details](./backups)

| Setting | Default | |
|---|---|---|
| `BACKUP_DIR` | off | Folder inside the container, e.g. `/backups`. |
| `FERRET_BACKUPS` | `./backups` | Folder on the host mounted there — on another machine (a NAS share). |
| `BACKUP_HOUR` | `3` | Hour backups start. |
| `BACKUP_KEEP` | `14` | Nightly copies kept. |

## Notifications and email — [details](./email)

| Setting | |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Push notifications (`npx web-push generate-vapid-keys`). |
| `REMIND_HOUR` | Hour the daily reminder goes out, in each household's time zone (default `9`). |
| `APPRISE_URL` | The Apprise container (`http://apprise:8000`): reminders to ntfy, Pushover, Telegram, email… |
| `MAIL_URL` | Email for Ferret itself, through Apprise (`mailtos://…`). |
| `ADMIN_WEBHOOK_URL` | A Discord webhook (channel settings → Integrations → Webhooks → Copy URL): the server admin's alerts — a service failing, or Ferret hitting an unexpected error — are posted to that channel too, at most once every 6 hours per service. It also says when someone signs up (how many accounts there are now — never who). |

## AI features — [details](./ai)

| Setting | |
|---|---|
| `OLLAMA_URL`, `VISION_MODEL`, `EMBED_MODEL` | Reading photos; embeddings for smart search. |
| `CHAT_URL`, `CHAT_MODEL`, `CHAT_REASONING` | A stronger text model for Ask Ferret and documents (OpenAI-compatible). |
| `DOCLING_URL`, `DOCLING_VLM_URL`, `DOCLING_OPTIONS` | Reading PDFs and scanned documents; `DOCLING_VLM_URL` reads pages with granite-docling (an OpenAI-compatible endpoint) instead of docling's standard pipeline. |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION` | Smart search's vector store. |
| `RERANK_URL`, `RERANK_MODEL` | Better ordering of search results. |

## Other

| Setting | |
|---|---|
| `BARCODE_LOOKUP=upcitemdb`, `UPCITEMDB_KEY` | Look up unknown barcodes online (100 a day free, per internet address; a key for more). Only the barcode is sent. Settings → Server shows how many are left today, and the server admin's bell says when they're running low. |
| `APPLE_MAPS_TEAM_ID`, `APPLE_MAPS_KEY_ID`, `APPLE_MAPS_PRIVATE_KEY` | Map pictures of property addresses (Apple Developer account). |
