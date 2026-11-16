# Settings (.env)

Everything is set in `.env` next to `compose.yaml`; restart Ferret after a change (`docker compose up -d`). Optional
features switch on when their settings are present (an empty one, `KEY=`, counts as unset — except `CHAT_REASONING=`,
which leaves the reasoning effort out), and Ferret's log lists what's on when it starts.

## The address: PUBLIC_URL

| Setting | |
|---|---|
| `PUBLIC_URL` | The address people (and Claude) use, e.g. `https://ferret.example.lan`. **Set it.** |

Ferret puts `PUBLIC_URL` in every link it sends — invitations, password resets, share links, calendar feeds — and passkeys
and [single sign-on](./single-sign-on) are tied to it. Once it's set, sign-ins are accepted from that address only.

Left unset — a one-click install that can't know its own address — Ferret still starts, and signing in works from the
local address it's opened at: an IP address, or a name only your network knows (`umbrel.local`, `nas.lan`, a bare
hostname). Another site's page is still refused, and so is any public domain name, since an attacker's domain could be
pointed at your server. Reached by a real domain, Ferret needs `PUBLIC_URL`. Unset, links point to
`http://localhost:8787`, and passkeys and single sign-on don't work, so **Settings → Server** and the log ask you to set
it.

## Secrets

Ferret needs a few secrets. **It makes them for you** the first time it starts — the right kind, from a secure random
source — and keeps them in the data folder, in `secrets.json` (readable by Ferret's own user only, and never copied into
its [backups](./backups)). Set any of them yourself and yours is used instead; that keeps it out of the data folder and
out of any copy of it. **Settings → Server → Keys** shows where each one came from.

| Setting | What it's for | To set your own | If it's lost |
|---|---|---|---|
| `FILES_KEY` | Seals every photo, document and pairing code, and the backups. | `openssl rand -base64 32` (exactly that: 32 random bytes) | **Lost for good** without a copy — nothing uploaded can be opened again. Ferret won't make a new one once files are sealed: it stops and says which key it needs. |
| `AUTH_SECRET` | Signs sign-ins, and seals two-step sign-in. | `openssl rand -base64 32` (32+ characters) | **Can be replaced**: Ferret stops rather than swap it by itself; `node dist/cli.js secrets new AUTH_SECRET` makes a new one — everyone signs in again, and two-step sign-in is turned off for those who had it, to set up again. Passwords, passkeys and API keys keep working. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Push notifications to the installed app (set both, or neither). | `npx web-push generate-vapid-keys` | **Remade by Ferret** on its own; each device turns push on again. |

All of them come back from a [key file](./backups#a-key-file-for-files-key) — one file, sealed with a passphrase you
choose. Make one once, whichever way the secrets were set, and keep it (and the passphrase) off the server.

Moving a secret Ferret made into the settings: copy it from a key file (`key recover` prints them) into `.env`, restart,
and check **Settings → Server → Keys** says "From the settings". The copy in `secrets.json` is then unused.

## General

| Setting | Default | |
|---|---|---|
| `ALLOW_SIGNUP` | `true` | Open sign-up. Set `false` once everyone's in; invitations still work. |
| `TRUSTED_PROXIES` | loopback | Your reverse proxies' addresses or ranges — every one between the internet and Ferret ([tunnels](./tunnels)). |
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
| `VAPID_SUBJECT` | Push notifications (the keys: [secrets](#secrets)). `VAPID_SUBJECT`: a `mailto:` or `https:` address on a public domain — Apple's push refuses local names like `.lan` ([more](./email)). |
| `REMIND_HOUR` | Hour the daily reminder goes out, in each household's time zone (default `9`). |
| `APPRISE_URL` | The Apprise container (`http://apprise:8000`): reminders to ntfy, Pushover, Telegram, email… |
| `MAIL_URL` | Email for Ferret itself, through Apprise (`mailtos://…`). |
| `ADMIN_WEBHOOK_URL` | A Discord webhook (channel settings → Integrations → Webhooks → Copy URL): the server admin's alerts — a service failing, or Ferret hitting an unexpected error — are posted to that channel too, at most once every 6 hours per service. It also says when someone signs up (how many accounts there are now — never who). |

## AI features — [details](./ai)

| Setting | |
|---|---|
| `VISION_URL`, `VISION_MODEL`, `EMBED_MODEL` | Reading photos; embeddings for smart search. Any OpenAI-compatible server — Ollama, llama.cpp, LM Studio, vLLM ([model servers](ai#model-servers)). `OLLAMA_URL` is `VISION_URL`'s old name and still works. |
| `EMBED_URL` | Embeddings from a different server than `VISION_URL` (e.g. a second llama-server). |
| `AI_API_KEY` | Sent as a Bearer token to the model servers (vision, embeddings, chat, reranker, speech), for servers started with an API key. |
| `CHAT_URL`, `CHAT_MODEL`, `CHAT_REASONING` | A stronger text model for Ask Ferret and documents (OpenAI-compatible). `CHAT_REASONING` (default `low`) is sent as `reasoning_effort`; set it empty for a model that doesn't take one. |
| `DOCLING_URL`, `DOCLING_VLM_URL`, `DOCLING_OPTIONS` | Reading PDFs and scanned documents; `DOCLING_VLM_URL` reads pages with granite-docling (an OpenAI-compatible endpoint) instead of docling's standard pipeline. |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION` | Smart search's vector store. Changing the collection or `EMBED_MODEL` embeds everything again at the next start ([changing the embedding model](ai#changing-the-embedding-model)). |
| `RERANK_URL`, `RERANK_MODEL` | Better ordering of search results. |
| `SPEECH_URL`, `SPEECH_MODEL` | Speech to text (an OpenAI-compatible `/v1/audio/transcriptions`: a Whisper server such as speaches, or vLLM): say a thing's name on a walkthrough. `SPEECH_MODEL` defaults to `whisper-1`. |

## Other

| Setting | |
|---|---|
| `BARCODE_LOOKUP=upcitemdb`, `UPCITEMDB_KEY` | Look up unknown barcodes online (100 a day free, per internet address; a key for more). Only the barcode is sent. Settings → Server shows how many are left today, and the server admin's bell says when they're running low. |
| `YOUTUBE_API_KEY` | Search YouTube for [how-to videos](../guide/maintenance#videos) from a maintenance task. A YouTube Data API v3 key from the Google Cloud console (free: about 100 searches a day; the same words are answered from Ferret's own copy for a week). Only the words searched for leave the server. Pasting a YouTube link works without it. [Getting a key](#youtube). |
| `APPLE_MAPS_TEAM_ID`, `APPLE_MAPS_KEY_ID`, `APPLE_MAPS_PRIVATE_KEY` | Map pictures of property addresses (Apple Developer account). |

## A YouTube key for how-to videos {#youtube}

Anyone can paste a YouTube link onto a [maintenance task](../guide/maintenance#videos). With a key, the task can also
**search YouTube** from Ferret, so nobody has to leave the app to find a video. The key is free and takes a few minutes:

1. Open the [Google Cloud console](https://console.cloud.google.com) and sign in with a Google account. Pick a project
   at the top, or make one (**New project**, any name — e.g. *ferret*). No billing account is needed.
2. **APIs & Services → Library**: search for **YouTube Data API v3** and click **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**, and copy the key.
4. Open the new key (**Edit API key**) and limit what it can do:
   - **API restrictions → Restrict key** → tick **YouTube Data API v3** only.
   - Optionally, **Application restrictions → IP addresses** → your home's public address, so the key only works from
     your server. If that address changes, searches stop working until you update it.

   Then **Save**.
5. Put it in your `.env` and restart Ferret:

   ```bash
   YOUTUBE_API_KEY=AIza…
   ```

   ```bash
   docker compose up -d
   ```

A task's **Add a video** now shows **Search YouTube**. The free allowance is 10,000 units a day and a search uses 100,
so about 100 searches a day — the same words are answered from Ferret's own copy for a week, and adding or playing
videos uses none. If searches fail (a mistyped key, the allowance used up, a changed IP address), the server admin
sees why in **Settings → Server**'s service errors, as *youtube*; pasting links keeps working.

Only the words searched for and the videos' ids go to YouTube, from the server. Videos play in YouTube's
privacy-enhanced player (`youtube-nocookie.com`), which sets no cookies until one is played.
