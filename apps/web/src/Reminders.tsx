import { t as translateText } from "./i18n";
import { tr } from "./i18n";
/**
 * Settings → Notifications → Reminders: a private calendar link for maintenance
 * (Apple/Google Calendar, with an alert on the day) and a daily push
 * notification to this device (on iPhone, only from the Home Screen app) of
 * what's urgent. Each is per person. Other apps (Apprise) are in Notifications.tsx.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyField } from "./CopyField";
import { api } from "./lib/api";
import { HelpLink } from "./HelpLink";
import { NotInPlan, usePlanFeature } from "./PlanUsage";
import { isIOS } from "./lib/install";

/**
 * How this device adds a calendar link: an iPhone or iPad (and Safari on a Mac) hands `webcal://` to the Calendar app,
 * which asks to subscribe; Chrome and the rest on a Mac don't (or pass it to Chrome, which can't subscribe) — there it's
 * Calendar → File → New Calendar Subscription by hand; elsewhere, the link into whichever calendar they use.
 */
function calendarWay(): "apple" | "mac-safari" | "mac-other" | "other" {
  const ua = navigator.userAgent;
  if (isIOS()) return "apple";
  if (/Macintosh/.test(ua)) return /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua) ? "mac-safari" : "mac-other";
  return "other";
}

/** A Ferret only the home network reaches (a .lan name, a 192.168… address): Google Calendar's servers can't fetch it. */
const atHome = (host = window.location.hostname) =>
  /(^localhost$|\.(lan|local|home|home\.arpa|internal|localdomain)$)/i.test(host) ||
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) ||
  (!host.includes(".") && !host.includes(":"));

export function Reminders({ householdId }: { householdId: string }) {
  return (
    <section className="card" aria-labelledby="reminders-title">
      <div className="card-body gap-5">
        <div className="space-y-1">
          <h2 id="reminders-title" className="card-title flex items-center gap-2">
            <span className="icon-[tabler--bell] size-5 text-primary" />
            {translateText("Reminders")}<HelpLink page="guide/reminders.html" label={translateText("Reminders")} />
          </h2>
          <p className="text-sm text-base-content/70">
            {translateText("Hear about filters, servicing and warranties about to end, when it matters. Just for you.")}</p>
        </div>
        <CalendarFeed householdId={householdId} />
        <hr className="border-base-content/10" />
        <PushReminders householdId={householdId} />
      </div>
    </section>
  );
}

function CalendarFeed({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const key = ["calendar", householdId];
  const status = useQuery({ queryKey: key, queryFn: api.calendarStatus });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({ mutationFn: api.createCalendar, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteCalendar, onSuccess: refresh });
  const feed = status.data;
  const busy = create.isPending || remove.isPending;
  const feature = usePlanFeature(householdId, "calendarFeeds");

  function reset() {
    if (window.confirm(translateText("Make a new link? Calendars subscribed to the current one stop updating until you subscribe again."))) create.mutate();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="avatar avatar-placeholder">
          <div className="size-10 rounded-full bg-primary/10 text-primary">
            <span className="icon-[tabler--calendar-event] size-5" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-base-content">{translateText("Calendar (maintenance)")}</h3>
          <p className="text-sm text-base-content/70">
            {feed?.active && !feature.on
              ? translateText("Paused: nothing new comes through to your calendar until your plan has calendar feeds again.")
              : feed?.active
              ? translateText("On: due maintenance shows up in your calendar, with an alert at 9:00 on the day. Add it on each device you want it on.")
              : translateText("Due maintenance in your calendar app, kept up to date, with an alert at 9:00 on the day.")}
          </p>
        </div>
        {!feed?.active && feature.on && (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || status.isPending} onClick={() => create.mutate()}>
            {create.isPending && <span className="loading loading-spinner loading-xs" />}
            {translateText("Turn on")}</button>
        )}
      </div>

      {!feature.on && <NotInPlan feature="calendarFeeds" planName={feature.planName} />}

      {feature.on && feed?.active && feed.url && feed.webcal && <AddToCalendar url={feed.url} webcal={feed.webcal} />}
      {feature.on && feed?.active && !feed.url && (
        <p className="ps-13 text-sm text-base-content/70 max-sm:ps-0">
          {translateText("This link was made before Ferret kept links, so it can't be shown. Reset it to get one you can see here (subscribe again with it).")}</p>
      )}

      {feed?.active && (
        <div className="flex flex-wrap gap-2 ps-13 max-sm:ps-0">
          {feature.on && (
            <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={reset}>
              {create.isPending ? <span className="loading loading-spinner loading-xs" /> : <span className="icon-[tabler--refresh] size-4" />}
              {translateText("Reset link")}</button>
          )}
          <button type="button" className="btn btn-text btn-sm" disabled={busy} onClick={() => remove.mutate()}>
            <span className="icon-[tabler--calendar-off] size-4" />
            {translateText("Turn off")}</button>
        </div>
      )}
      {(create.isError || remove.isError) && <p className="text-sm text-error">{create.error?.message ?? remove.error?.message}</p>}
    </div>
  );
}

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** The VAPID public key as the bytes pushManager.subscribe wants. */
function keyBytes(base64url: string) {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function PushReminders({ householdId }: { householdId: string }) {
  const qc = useQueryClient();
  const key = ["push", householdId];
  const supported = pushSupported();
  const status = useQuery({
    queryKey: key,
    queryFn: async () => api.pushStatus((await currentSubscription())?.endpoint),
    enabled: supported,
  });
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      const existing = await currentSubscription();
      if (!on) {
        if (existing) {
          await api.pushUnsubscribe(existing.endpoint);
          await existing.unsubscribe();
        }
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") {
        throw new Error(translateText("Notifications are blocked for Ferret — allow them in your browser or iPhone Settings"));
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.data!.publicKey!) }));
      await api.pushSubscribe(subscription.toJSON());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const test = useMutation({ mutationFn: api.pushTest });

  let note: string;
  if (!supported) {
    note = isIos()
      ? translateText("On iPhone: tap Share → Add to Home Screen, open Ferret from your Home Screen, then turn this on there.")
      : translateText("This browser can't receive push notifications.");
  } else if (status.data && !status.data.enabled) {
    note = "Not set up on this server yet (it needs VAPID keys).";
  } else if (status.data?.subscribed) {
    note = "On for this device: one notification a day when maintenance is due or a warranty ends within a week.";
  } else {
    note = "A notification on this device on days maintenance is due or a warranty is about to end.";
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="avatar avatar-placeholder">
        <div className="size-10 rounded-full bg-primary/10 text-primary">
          <span className="icon-[tabler--device-mobile-message] size-5" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium text-base-content">{translateText("Push on this device")}</h3>
        <p className="text-sm text-base-content/70">{note}</p>
        {(toggle.isError || test.isError) && <p className="mt-1 text-sm text-error">{toggle.error?.message ?? test.error?.message}</p>}
        {test.data && <p className="mt-1 text-sm text-success">{tr("Sent to {v0} ", { v0: test.data.sent })}{test.data.sent === 1 ? translateText("device") : translateText("devices")}.</p>}
      </div>
      {supported && status.data?.enabled && (
        <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
          {status.data.subscribed && (
            <button type="button" className="btn btn-text btn-sm" disabled={test.isPending} onClick={() => test.mutate()}>
              {translateText("Send a test")}</button>
          )}
          <input
            type="checkbox"
            className="switch switch-primary"
            aria-label={translateText("Push notifications on this device")}
            checked={status.data.subscribed}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
        </div>
      )}
    </div>
  );
}

/** The calendar link into this device's calendar: one button where Calendar takes it, the steps where it doesn't. */
function AddToCalendar({ url, webcal }: { url: string; webcal: string }) {
  const way = calendarWay();
  const byHand = (
    <ol className="list-decimal space-y-0.5 ps-5 text-sm text-base-content/80">
      <li>{translateText("Copy the calendar link below.")}</li>
      <li>{tr("In the {v0} app, choose {v1} (⌥⌘S).", { v0: <strong>{translateText("Calendar")}</strong>, v1: <strong>{translateText("File → New Calendar Subscription…")}</strong> })}</li>
      <li>{tr("Paste it, then {v0} and {v1}.", { v0: <strong>{translateText("Subscribe")}</strong>, v1: <strong>{translateText("OK")}</strong> })}</li>
    </ol>
  );
  return (
    <div className="flex flex-col gap-3 ps-13 max-sm:ps-0">
      {way === "mac-other" ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-base-content">{translateText("Add it to Apple Calendar on this Mac:")}</p>
          {byHand}
        </div>
      ) : (
        way !== "other" && (
          <div className="flex flex-col gap-1.5">
            <a href={webcal} className="btn btn-primary btn-sm self-start">
              <span className="icon-[tabler--calendar-plus] size-4" />
              {translateText("Add to Calendar")}</a>
            <p className="text-xs text-base-content/70">{translateText("Opens your Calendar app, which asks to subscribe — say yes.")}</p>
            {way === "mac-safari" && (
              <details className="text-sm">
                <summary className="tap cursor-pointer text-base-content/80">{translateText("It opened another app, or asked to open Chrome?")}</summary>
                <div className="mt-1.5">{byHand}</div>
              </details>
            )}
          </div>
        )
      )}
      <CopyField label={translateText("Calendar link")} value={url} icon="icon-[tabler--link]" />
      <details className="text-sm" open={way === "other"}>
        <summary className="tap cursor-pointer text-base-content/80">{translateText("Google Calendar, Outlook or another calendar")}</summary>
        <ul className="mt-1.5 list-disc space-y-1 ps-5 text-base-content/80">
          {atHome() ? (
            <li>{tr("{v0} can't use it: Google fetches calendars from its own servers, and they can't reach a Ferret at home ({v1}). Use Apple Calendar or Outlook on your own devices instead.", { v0: <strong>{translateText("Google Calendar")}</strong>, v1: window.location.hostname })}</li>
          ) : (
            <li>{tr("{v0} (on a computer): {v1}, paste the link, {v2}.", { v0: <strong>{translateText("Google Calendar")}</strong>, v1: <strong>{translateText("Other calendars → + → From URL")}</strong>, v2: <strong>{translateText("Add calendar")}</strong> })}</li>
          )}
          <li>{tr("{v0}: {v1}, and paste the link.", { v0: <strong>{translateText("Outlook")}</strong>, v1: <strong>{translateText("Add calendar → Subscribe from web")}</strong> })}</li>
          <li>{tr("{v0}: open these settings there and press {v1}.", { v0: <strong>{translateText("An iPhone or iPad")}</strong>, v1: <strong>{translateText("Add to Calendar")}</strong> })}</li>
        </ul>
      </details>
      <p className="text-xs text-base-content/70">{tr("Keep it private: anyone with the link can see your maintenance tasks.{v0}{v1}", { v0: " ", v1: <a href="/docs/guide/reminders.html#if-add-to-calendar-doesn-t-work" className="link tap">
          {translateText("Trouble adding it?")}</a> })}</p>
    </div>
  );
}
