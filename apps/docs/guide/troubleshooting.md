# Troubleshooting

Something not working? Find it below. The first part is for everyone using Ferret; the second is for whoever runs it.
Still stuck? Ask on [Discord](https://discord.gg/XSkKyP2pdg) or open an issue on
[GitHub](https://github.com/ferret-project/ferret/issues).

## Using Ferret

### The camera doesn't open

Ferret says **Camera not available — take a photo of the barcode instead**:

- **Allow the camera.** The first time, the browser asks; if you said no, allow it again. iPhone: **Settings → Apps →
  Safari → Camera** → **Ask** or **Allow**. Chrome: the icon at the left of the address → **Camera** → **Allow**.
- **Another app has the camera.** Close a video call or another camera app and try again.
- **Ferret's address starts with `http://`.** Browsers only open the camera on a secure (`https://`) address, so
  whoever runs your Ferret needs to [put it behind HTTPS](../hosting/reverse-proxy). Until then, **take a photo** works:
  Ferret reads the barcode from the picture.

### A barcode won't scan

- Hold the phone so the barcode fills about half the frame, flat on, in good light. Tilt it slightly if a shiny wrapper
  reflects the light.
- Very small or creased barcodes: take a photo instead — a still picture is often sharper than the live camera.
- Ferret reads the barcodes on products (EAN-13, EAN-8, UPC-A, UPC-E), Code 128 and Code 39, and QR codes — its own
  labels and HomeKit / Matter codes included. Other kinds (Data Matrix, PDF417) aren't read; type the number instead.
- A barcode Ferret doesn't know can still be added — it just can't offer a name. Names come from your household's
  earlier saves, or — if the server has it switched on — an online product database.

### Push notifications don't arrive

- **iPhone and iPad**: push only works in Ferret installed on the Home Screen ([On your phone](./phone)). Open Ferret
  from its icon, then turn push on there — turning it on in Safari doesn't count.
- **"Notifications are blocked for Ferret"**: you (or the phone) said no once. iPhone: **Settings → Notifications →
  Ferret** → **Allow Notifications**. Chrome: the icon at the left of the address → **Notifications** → **Allow**.
- **Focus or Do Not Disturb** hides them; let Ferret through, or check the Notification Centre.
- Push is **once a day**, at the reminder hour, and only when something is due — see
  [what and when](./reminders#what-and-when). Nothing due, nothing sent.
- Push is per device: turn it on on each phone, tablet and computer you want it on.

### The app says Offline, but I have signal

- Close Ferret and open it again.
- If your Ferret is behind a sign-in page of its own (an access proxy, set up by whoever runs it), that sign-in has
  probably run out: opening the app again shows it. [The phone app behind a proxy](../hosting/phone-app) explains.
- Things you added while offline are kept on the phone and upload by themselves; see [No signal](./phone#no-signal).

### Signing in

- **Too many wrong passwords**: Ferret slows down tries for a while; it never locks you out for good. Wait a minute, or
  use **Email me a link to sign in again** — see [Wrong passwords](./security#wrong-passwords).
- **Forgot your password**: **Forgot your password?** on the sign-in page emails a link — if your Ferret can send email.
  If it can't, ask the household's owner or the server's admin.
- **The installed app asks you to sign in again** after you signed in in Safari: the Home Screen app keeps its own
  sign-in. Sign in once inside the app.
- **Lost your two-step codes**: use one of the backup codes you saved when you turned it on.

### Photo suggestions, Ask Ferret or search by meaning are missing

- On a hosted Ferret, AI comes with some plans only — see [Plan and usage](./plan-and-usage).
- On a Ferret run at home, each AI feature is switched on by the person who runs it ([AI features](../hosting/ai)).
- Suggestions take a little while: photos are read in the background, one at a time. Leave the item and come back.

### The calendar stopped updating

- Calendar apps check subscribed calendars on their own timetable, from every few minutes to about a day. Google
  Calendar is the slowest.
- If someone made a **new link** in Settings → Notifications, the old one stopped working — subscribe to the new one.
- Behind an access proxy, the calendar app can't sign in to it: whoever runs Ferret lets `/calendar/` through
  ([Tunnels](../hosting/tunnels#let-through-what-can-t-sign-in-to-the-proxy)).

## Running Ferret

### Something failed — where do I look?

Signed in as the [server admin](../hosting/server-admin), **Settings → Server** lists failed calls to the services
Ferret uses (AI models, email, push…) and jobs that gave up, each with **Copy details** — paste that into a question on
Discord or GitHub. The container's log (`docker compose logs ferret`) says at start what's switched on.

### Some photos aren't read: "ran out of room" or "reply wasn't JSON (finished: length)"

The vision model stopped before it answered. Most often it ran out of room. Thinking models (`qwen3-vl:8b` is
`qwen3-vl:8b-thinking`) write out their reasoning before the answer, and a model server gives each request a limited
**context window** — Ollama's default is 4,096 tokens, and a photo's prompt already takes about 2,700 of them. Service
errors then say *"the model server's context window (4,096 tokens) filled up"*. It isn't the GPU: an 8 GB card runs an
8B model fine.

- **Use the version that doesn't think** — same size, faster, and it fits the window: pull `qwen3-vl:8b-instruct` in
  Ollama and set `VISION_MODEL=qwen3-vl:8b-instruct`, then restart Ferret.
- **Or give the model server a bigger window**: Ollama's `OLLAMA_CONTEXT_LENGTH=8192` (an environment variable on the
  Ollama container; llama.cpp: `--ctx-size 8192`). It takes a little more of the GPU's memory.

Then **Clear all** in Service errors, and read the photos that failed again with the ✨ button on their thing's page.
If it says *finished: length* without the window, the reply hit Ferret's own limit — a model that wanders on; try
another model.

### Links in emails point to `localhost`, passkeys or single sign-on don't work

Set `PUBLIC_URL` to the address people use ([Settings](../hosting/configuration#the-address-public-url)) and restart.

### Sign-in is refused from one address but works from another

With `PUBLIC_URL` set, Ferret accepts sign-ins from that address only (it stops other sites signing people in). Use
that address, or change `PUBLIC_URL` to the one you use.

### Every sign-in looks like it comes from the proxy

Sign-ins all show one address — your proxy's — and everyone shares one set of wrong-password limits. Set
`TRUSTED_PROXIES` to every proxy between the internet and Ferret
([Tunnels](../hosting/tunnels#tell-ferret-which-proxies-are-yours)).

### Big photos or documents fail to upload

- **"Files can be up to 25 MB"** is Ferret's own limit, `MAX_UPLOAD_MB` (up to 100).
- **A 413 error, or an upload that fails with no message**: your reverse proxy's limit is lower. nginx allows only 1 MB
  unless told otherwise — see [Reverse proxy examples](../hosting/reverse-proxy).

### Emails don't arrive

Ferret sends email through Apprise: both `APPRISE_URL` and `MAIL_URL` must be set ([Email](../hosting/email#email)).
Failed sends are in **Settings → Server**. Check the spam folder, and that the sending address is allowed by your mail
provider.

### The container won't start, or the data folder isn't writable

Ferret runs as user 1000 inside the container. The data folder (and the backups folder) must be writable by it — see
[the data folder's owner](../hosting/install#the-data-folder-s-owner). The log says which setting is wrong if one is.

### I restarted with a new FILES_KEY and the photos are gone

Photos and documents are sealed with `FILES_KEY`. Put the old one back (from your
[key file](../hosting/backups#a-key-file-for-files-key) or wherever you kept it) and restart. Without it they can't be
read — backups included.
