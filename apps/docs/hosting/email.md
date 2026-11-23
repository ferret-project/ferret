# Email and notifications

## Apprise

Ferret sends email and notifications to other apps through [Apprise](https://github.com/caronc/apprise-api), which
runs as a second container (`apprise` in `compose.yaml`) and keeps nothing. Turn it on with:

```bash
APPRISE_URL=http://apprise:8000
```

People can then add their own reminder destinations — ntfy, Pushover, Telegram, email and 100+ more — in
**Notifications**. Ferret only allows known Apprise services there.

## Email

Ferret needs email to **confirm new accounts** (without it, nobody but the first account can join), for **Forgot your
password?**, for **sign-in-again links** after wrong passwords, and to **email invitations** (without it, you send the link yourself). Give it an Apprise mail address to send from — for
Gmail, an [app password](https://support.google.com/accounts/answer/185833):

```bash
MAIL_URL=mailtos://you:app-password@gmail.com
```

Or any SMTP server. A relay that lets your network in without a login (like Google Workspace's SMTP relay) needs only the
server, the port and who it's from — `mode=ssl` for port 465, `mode=starttls` for 587:

```bash
MAIL_URL=mailtos://example.com:465?smtp=smtp-relay.gmail.com&from=noreply@example.com&name=Ferret&mode=ssl
```

## Push notifications

Push works out of the box: Ferret makes its key pair the first time it starts ([secrets](./configuration#secrets)), and
**Settings → Server → Access → Keys** shows the public one. To use your own pair instead — the same on a new server, say:

```bash
npx web-push generate-vapid-keys
```

```bash
VAPID_PUBLIC_KEY=…
VAPID_PRIVATE_KEY=…
```

Changing the pair (yours or Ferret's) means each device turns push on again.

```bash
VAPID_SUBJECT=mailto:you@example.com
```

`VAPID_SUBJECT` tells push services who to contact about your server: a `mailto:` or `https:` address **on a public domain**. Apple's push service — iPhones, iPads and Safari on a Mac — refuses anything else, such as `mailto:admin@ferret.lan` or `https://ferret.lan` (the server's log answers `403 BadJwtToken` for those devices), so on a server with a local name, set it to an email address you use. Left unset, it's `admin@` your `PUBLIC_URL`'s host, and Ferret warns at start when Apple would refuse it.

Push needs HTTPS. The daily reminder goes out from `REMIND_HOUR` (default 9) in each household's own time zone (**Settings → Household → Time zone**; a household that hasn't chosen one uses the server's `TZ`).
