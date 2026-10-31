# Reminders

Set them up in **Household & settings → Notifications**. Each person chooses their own.

## Calendar

**Calendar (maintenance)** → **Turn on** makes a private calendar of your due maintenance. Then **Add to Calendar** on
each device you want it on: on an iPhone, iPad or a Mac in Safari it opens the Calendar app, which asks to subscribe —
say yes. Due dates show up there, kept up to date, with an alert at 9:00 on the day. On a Mac in another browser,
Ferret shows the steps instead (below). Google Calendar and Outlook take the **Calendar link** — under **Google
Calendar, Outlook or another calendar**.

Treat the link like a password — anyone with it can see the list. **Reset link** makes a new one and turns the old one
off.

On a hosted Ferret, the calendar link may come with some plans only — see [Plan and usage](./plan-and-usage).

### If Add to Calendar doesn't work

The button opens a `webcal://` link, which your device hands to whichever app has claimed calendar links.

- **On a Mac, Safari asks to open Google Chrome, or nothing happens in Chrome**: Chrome has claimed `webcal://` links,
  and Chrome can't subscribe to a calendar. Add it by hand instead — it always works:
  1. Copy the **Calendar link** under the button.
  2. Open the **Calendar** app → **File → New Calendar Subscription…** (⌥⌘S).
  3. Paste the link, press **Subscribe**, then choose how often it refreshes (every hour is good) and **OK**.

  To make the button work again in Safari: in the Calendar app, **Calendar → Settings → General → Default calendar
  app** → **Calendar**.
- **On an iPhone or iPad**: open Ferret in Safari (or from the Home Screen) and press the button there; it asks
  **Subscribe** — say yes. Or **Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed
  Calendar** and paste the link.
- **Google Calendar**: on a computer, **Other calendars → + → From URL**, and paste the link. Google fetches the
  calendar from its own servers, so this only works if your Ferret can be reached from the internet —
  a hosted Ferret can be; a Ferret at home (like `ferret.example.lan`) can't, unless you've [opened it up](../hosting/away-from-home).
  Use Apple Calendar or Outlook on your own devices instead.
- **Outlook**: **Add calendar → Subscribe from web**, and paste the link (the same internet rule applies to Outlook on
  the web).

Subscribed calendars refresh on their own schedule — Apple Calendar as often as you set, Google every several hours —
so a task you just finished can take a while to disappear.

## Push notifications

**Push on this device** sends a notification to this phone or computer. Turn it on on each device you want them on.
On an iPhone, Ferret has to be [installed on the Home Screen](./phone) first.

## Other apps

Get reminders in **ntfy, Pushover, Telegram, email** and many other apps, by adding an address for that app (an
*Apprise URL* — the page shows examples). **Send a test** checks it works. (Needs whoever runs Ferret to have turned this
on; see [Email and notifications](../hosting/email).)

## Weekly summary

**Settings → Notifications → Weekly summary**: pick a day, and once a week Ferret sends you *everything* in the bell —
not just what's urgent: possible [recalls](./recalls), [coverage](./coverage) gaps, warranty claims waiting, things to
name, what's lent out and borrowed. It comes the same way as the daily reminder (push, and your other apps), and — if
your Ferret can send email — by email too. Nothing comes when there's nothing to say.

## What and when

Once a day, in the morning, Ferret sends what's **urgent**: maintenance that's due today or overdue, warranties
ending within a week, and things that have [run out](./stock#shopping-list). If nothing is urgent, it sends nothing.

"Today" and "the morning" are where your household is: **Settings → Household → Time zone** (a new household starts
with your device's). Change it if you move — or if Ferret's idea of today is a day out.
