/** Maintenance: tasks on items and places, marking them done, history, and household isolation. */
import { addDays, type MaintenanceLogEntry, type MaintenanceTask, nextDue, type Provider, type ProviderVisit, taskOccurrences, today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { calendarFeed, maintenanceTask, member, pushSubscription } from "../src/db/schema";
import { sendReminders } from "../src/jobs/remind";
import { FEED_REPEATS, toICalendar } from "../src/lib/calendar";
import { FakePush, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("maintenance", () => {
  it("schedules a repeating task, rolls it on when done, and keeps the history", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const furnace = await ann.addItem({ name: "Furnace" });

    const created = await send(ann, "POST", "/api/v1/maintenance", {
      title: "Replace filter",
      itemId: furnace.id,
      intervalCount: 3,
      intervalUnit: "month",
      dueOn: addDays(today(), -5),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as MaintenanceTask;
    expect(task).toMatchObject({ itemName: "Furnace", status: "overdue", intervalCount: 3 });

    // Done a few days ago: the next one is three months from then, not from when it was due.
    const doneOn = addDays(today(), -2);
    const done = await json<MaintenanceTask>(send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, { doneOn, costCents: 2499, note: "MERV 11" }));
    expect(done).toMatchObject({ lastDoneOn: doneOn, dueOn: nextDue(doneOn, 3, "month"), status: "upcoming" });

    const history = await json<{ data: MaintenanceLogEntry[] }>(ann.as(`/api/v1/maintenance/${task.id}/history`));
    expect(history.data).toEqual([expect.objectContaining({ doneOn, doneByName: "ann", note: "MERV 11", costCents: 2499 })]);

    // An item's own list, and a future "done" is refused.
    const forItem = await json<{ data: MaintenanceTask[] }>(ann.as(`/api/v1/maintenance?itemId=${furnace.id}`));
    expect(forItem.data.map((t) => t.title)).toEqual(["Replace filter"]);
    expect((await send(ann, "POST", `/api/v1/maintenance/${task.id}/done`, { doneOn: addDays(today(), 3) })).status).toBe(422);
  });

  it("finishes a one-off, lists open tasks soonest first, and edits and removes them", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const later = await json<MaintenanceTask>(send(ann, "POST", "/api/v1/maintenance", { title: "Clean gutters", intervalCount: 1, intervalUnit: "year" }));
    expect(later.dueOn).toBe(nextDue(today(), 1, "year")); // one interval from today when no date is given
    const once = await json<MaintenanceTask>(send(ann, "POST", "/api/v1/maintenance", { title: "Service the boiler" }));
    expect(once).toMatchObject({ dueOn: today(), status: "due" });

    const open = await json<{ data: MaintenanceTask[] }>(ann.as("/api/v1/maintenance"));
    expect(open.data.map((t) => t.title)).toEqual(["Service the boiler", "Clean gutters"]);

    await send(ann, "POST", `/api/v1/maintenance/${once.id}/done`, {});
    const after = await json<{ data: MaintenanceTask[] }>(ann.as("/api/v1/maintenance"));
    expect(after.data.map((t) => t.title)).toEqual(["Clean gutters"]);
    const finished = await json<{ data: MaintenanceTask[] }>(ann.as("/api/v1/maintenance?status=done"));
    expect(finished.data.map((t) => t.title)).toEqual(["Service the boiler"]);

    // Making it a one-off clears both halves of the interval.
    const edited = await json<MaintenanceTask>(send(ann, "PATCH", `/api/v1/maintenance/${later.id}`, { title: "Clear gutters", intervalCount: null }));
    expect(edited).toMatchObject({ title: "Clear gutters", intervalCount: null, intervalUnit: null });
    expect((await send(ann, "DELETE", `/api/v1/maintenance/${later.id}`)).status).toBe(204);
    expect((await ann.as(`/api/v1/maintenance/${later.id}`)).status).toBe(404);
  });

  it("validates the interval, and keeps households apart", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    expect((await send(ann, "POST", "/api/v1/maintenance", { title: "x", intervalCount: 2 })).status).toBe(422);

    const bobsItem = await bob.addItem({ name: "Bob's mower" });
    expect((await send(ann, "POST", "/api/v1/maintenance", { title: "Sharpen", itemId: bobsItem.id })).status).toBe(404);
    const bobs = await json<MaintenanceTask>(send(bob, "POST", "/api/v1/maintenance", { title: "Sharpen blade", itemId: bobsItem.id }));
    expect((await ann.as(`/api/v1/maintenance/${bobs.id}`)).status).toBe(404);
    expect((await send(ann, "POST", `/api/v1/maintenance/${bobs.id}/done`, {})).status).toBe(404);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/maintenance"))).data).toEqual([]);
  });

  it("drops tasks whose item was removed", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const mower = await ann.addItem({ name: "Mower" });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Change oil", itemId: mower.id });
    await send(ann, "DELETE", `/api/v1/items/${mower.id}`);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/maintenance"))).data).toEqual([]);
  });
});

describe("calendar feed", () => {
  it("serves due maintenance as iCalendar to whoever has the link, until it's replaced or they leave", async () => {
    const { app, user, db } = await setup();
    const ann = await user("ann");
    const furnace = await ann.addItem({ name: "Furnace" });
    await send(ann, "POST", "/api/v1/maintenance", {
      title: "Replace filter; check, clean",
      itemId: furnace.id,
      intervalCount: 3,
      intervalUnit: "month",
      dueOn: addDays(today(), -1),
    });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Clean gutters", dueOn: addDays(today(), 30) });

    expect(await json(ann.as("/api/v1/calendar"))).toEqual({ active: false, createdAt: null, url: null, webcal: null });
    const { url, webcal } = await json<{ url: string; webcal: string }>(send(ann, "POST", "/api/v1/calendar"));
    expect(webcal).toMatch(/^webcal:/);
    const path = new URL(url).pathname;

    const feed = await app.request(path); // no cookie: the token is the credential
    expect(feed.status).toBe(200);
    expect(feed.headers.get("Content-Type")).toContain("text/calendar");
    const ics = await feed.text();
    expect(ics).toContain("X-WR-CALNAME:ann home maintenance");
    // Overdue tasks show today, escaped properly, with an alarm.
    expect(ics).toContain(`DTSTART;VALUE=DATE:${today().replace(/-/g, "")}`);
    expect(ics).toContain("SUMMARY:Overdue: Replace filter\\; check\\, clean (Furnace)");
    expect(ics).toContain(`DTSTART;VALUE=DATE:${addDays(today(), 30).replace(/-/g, "")}`);
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2); // repeats have none
    // The filter's repeats for the next year, every 3 months from today (it's overdue): 3 of them; the gutters are a one-off.
    const repeats = [3, 6, 9].map((m) => nextDue(today(), m, "month").replace(/-/g, ""));
    for (const d of repeats) expect(ics).toContain(`DTSTART;VALUE=DATE:${d}`);
    expect(ics.match(/^SUMMARY:Replace filter.*\(expected\)/gm)).toHaveLength(3);
    expect(ics).toContain(`-${repeats[0]}@ferret`);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(5);
    expect(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    // Any line break in what people typed stays inside its line.
    await send(ann, "POST", "/api/v1/maintenance", { title: "Oil\rATTACH:https://example.invalid/a", notes: "a\rEND:VEVENT\u2028b", dueOn: addDays(today(), 3) });
    const again = await (await app.request(path)).text();
    expect(again.split("\r\n").some((line) => /[\r\n\u2028]/.test(line))).toBe(false);
    expect(again).toContain("Oil\\nATTACH:https://example.invalid/a");

    // The link can be shown again (it's kept sealed with the household key).
    expect(await json(ann.as("/api/v1/calendar"))).toMatchObject({ active: true, url, webcal });

    // Resetting replaces it: the old link stops working.
    const second = await json<{ url: string }>(send(ann, "POST", "/api/v1/calendar"));
    expect((await app.request(path)).status).toBe(404);
    expect((await app.request(new URL(second.url).pathname)).status).toBe(200);
    expect((await json<{ url: string }>(ann.as("/api/v1/calendar"))).url).toBe(second.url);

    // A feed from before links were kept: on, but its link can't be shown (reset to get one).
    await db.update(calendarFeed).set({ tokenSealed: null });
    expect(await json(ann.as("/api/v1/calendar"))).toMatchObject({ active: true, url: null });

    expect((await send(ann, "DELETE", "/api/v1/calendar")).status).toBe(204);
    expect((await app.request(new URL(second.url).pathname)).status).toBe(404);
    expect((await app.request("/calendar/not-a-real-token-at-all-really.ics")).status).toBe(404);
  });
});

describe("push reminders", () => {
  const device = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "BKey", auth: "secret" } });

  it("sends one summary a day per device, of what's overdue or due today", async () => {
    const push = new FakePush();
    const { user, deps, files } = await setup({ push });
    const ann = await user("ann");
    const furnace = await ann.addItem({ name: "Furnace" });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Replace filter", itemId: furnace.id, dueOn: addDays(today(), -3) });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Test smoke alarms" }); // one-off: due today
    await send(ann, "POST", "/api/v1/maintenance", { title: "Clean gutters", dueOn: addDays(today(), 5) }); // not yet

    expect(await json(ann.as(`/api/v1/push?endpoint=${encodeURIComponent(device(1).endpoint)}`))).toEqual({
      enabled: true,
      publicKey: "BFakePublicKey",
      subscribed: false,
    });
    expect((await send(ann, "POST", "/api/v1/push/subscribe", device(1))).status).toBe(204);
    expect((await json<{ subscribed: boolean }>(ann.as(`/api/v1/push?endpoint=${encodeURIComponent(device(1).endpoint)}`))).subscribed).toBe(true);

    const at = (hour: number) => () => new Date(new Date().setHours(hour, 5, 0, 0));
    const remind = (hour: number) => sendReminders({ ...deps, files, appUrl: "https://ferret.test", remindHour: 9, now: at(hour) })({}, { lastAttempt: false });

    await remind(7); // too early
    expect(push.sent).toEqual([]);
    await remind(10);
    expect(push.sent).toEqual([
      expect.objectContaining({
        title: "2 maintenance tasks due",
        body: "Replace filter (Furnace) · Test smoke alarms",
        url: "https://ferret.test/#/maintenance",
      }),
    ]);
    await remind(11); // already reminded today
    expect(push.sent).toHaveLength(1);
  });

  it("forgets devices that unsubscribed, and people who left; a test notification reaches only your devices", async () => {
    const push = new FakePush();
    const { user, deps, db, files } = await setup({ push });
    const ann = await user("ann");
    await send(ann, "POST", "/api/v1/maintenance", { title: "Test smoke alarms" });
    await send(ann, "POST", "/api/v1/push/subscribe", device(1));
    await send(ann, "POST", "/api/v1/push/subscribe", device(2));
    push.gone.add(device(2).endpoint);

    expect(await json(send(ann, "POST", "/api/v1/push/test"))).toEqual({ sent: 1 });
    expect((await db.select().from(pushSubscription)).map((s) => s.endpoint)).toEqual([device(1).endpoint]);

    await db.delete(member).where(eq(member.organizationId, ann.householdId));
    await sendReminders({ ...deps, files, appUrl: "", remindHour: 0 })({}, { lastAttempt: false });
    expect(await db.select().from(pushSubscription)).toEqual([]);
  });

  it("says when push isn't set up", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect((await json<{ enabled: boolean }>(ann.as("/api/v1/push"))).enabled).toBe(false);
    expect((await send(ann, "POST", "/api/v1/push/subscribe", device(1))).status).toBe(409);
  });
});

describe("service providers", () => {
  it("do tasks, get credited when they're done, and keep a history with what they cost", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const hvac = await json<{ id: string }>(
      send(ann, "POST", "/api/v1/providers", { name: "Cool Air Co", trade: "HVAC", phone: "303-555-0100", email: "service@coolair.example" }),
    );
    expect((await send(ann, "POST", "/api/v1/providers", { name: "x", email: "not-an-email" })).status).toBe(422);
    const furnace = await ann.addItem({ name: "Furnace" });
    const service = await json<MaintenanceTask>(
      send(ann, "POST", "/api/v1/maintenance", { title: "Annual service", itemId: furnace.id, intervalCount: 1, intervalUnit: "year", providerId: hvac.id }),
    );
    expect(service).toMatchObject({ providerId: hvac.id, providerName: "Cool Air Co" });

    // Done: credited to the usual provider unless told otherwise (null = we did it).
    await send(ann, "POST", `/api/v1/maintenance/${service.id}/done`, { doneOn: addDays(today(), -400), costCents: 15000 });
    await send(ann, "POST", `/api/v1/maintenance/${service.id}/done`, { doneOn: addDays(today(), -30), costCents: 18000, note: "New igniter" });
    await send(ann, "POST", `/api/v1/maintenance/${service.id}/done`, { providerId: null });

    const listed = await json<{ data: Provider[] }>(ann.as("/api/v1/providers"));
    expect(listed.data[0]).toMatchObject({ name: "Cool Air Co", tasks: 1, visits: 2, lastVisit: addDays(today(), -30), spentCents: 33000 });
    const visits = await json<{ data: ProviderVisit[] }>(ann.as(`/api/v1/providers/${hvac.id}/visits`));
    expect(visits.data.map((x) => [x.taskTitle, x.itemName, x.note, x.costCents])).toEqual([
      ["Annual service", "Furnace", "New igniter", 18000],
      ["Annual service", "Furnace", null, 15000],
    ]);
    const history = await json<{ data: MaintenanceLogEntry[] }>(ann.as(`/api/v1/maintenance/${service.id}/history`));
    expect(history.data.map((h) => h.providerName)).toEqual([null, "Cool Air Co", "Cool Air Co"]);
    expect((await json<{ data: MaintenanceTask[] }>(ann.as(`/api/v1/maintenance?providerId=${hvac.id}&status=all`))).data).toHaveLength(1);

    // Another household's provider can't be used; removing one unlinks its tasks.
    const bob = await user("bob");
    expect((await send(bob, "POST", "/api/v1/maintenance", { title: "x", providerId: hvac.id })).status).toBe(404);
    expect((await bob.as(`/api/v1/providers/${hvac.id}`)).status).toBe(404);
    expect((await send(ann, "DELETE", `/api/v1/providers/${hvac.id}`)).status).toBe(204);
    expect((await json<MaintenanceTask>(ann.as(`/api/v1/maintenance/${service.id}`))).providerId).toBeNull();
  });
});

describe("editing a task", () => {
  it("keeps its due date when only something else changes, even with no date by time stored", async () => {
    const { user, db } = await setup();
    const ann = await user("ann");
    const dueOn = addDays(today(), 20);
    const task = await json<MaintenanceTask>(send(ann, "POST", "/api/v1/maintenance", { title: "Filter", intervalCount: 3, intervalUnit: "month", dueOn }));
    await db.update(maintenanceTask).set({ timeDueOn: null }).where(eq(maintenanceTask.id, task.id));
    const edited = await json<MaintenanceTask>(send(ann, "PATCH", `/api/v1/maintenance/${task.id}`, { notes: "16x25x1" }));
    expect(edited).toMatchObject({ dueOn, timeDueOn: dueOn, status: "upcoming" });
  });
});

describe("taskOccurrences (the Month view)", () => {
  const on = "2026-11-07";
  const monthly = { intervalCount: 1, intervalUnit: "month" as const };

  it("puts the next due date on its day and the repeats after it as expected", () => {
    expect(taskOccurrences({ ...monthly, dueOn: "2026-11-20" }, "2026-11-01", "2027-01-31", on)).toEqual([
      { on: "2026-11-20", kind: "due" },
      { on: "2026-12-20", kind: "expected" },
      { on: "2027-01-20", kind: "expected" },
    ]);
  });

  it("puts an overdue task on today, with its repeats counted from today", () => {
    expect(taskOccurrences({ ...monthly, dueOn: "2026-10-01" }, "2026-10-01", "2026-12-31", on)).toEqual([
      { on: "2026-11-07", kind: "overdue" },
      { on: "2026-12-07", kind: "expected" },
    ]);
  });

  it("keeps only what's in the range, also for a range months ahead", () => {
    expect(taskOccurrences({ intervalCount: 2, intervalUnit: "week", dueOn: "2026-11-10" }, "2027-03-01", "2027-03-31", on)).toEqual([
      { on: "2027-03-02", kind: "expected" },
      { on: "2027-03-16", kind: "expected" },
      { on: "2027-03-30", kind: "expected" },
    ]);
  });

  it("repeats by use from how fast the item's used, whichever's sooner", () => {
    const task = { intervalCount: 1, intervalUnit: "year" as const, dueOn: "2026-12-01", usage: { every: 3000, perDay: 50 } };
    expect(taskOccurrences(task, "2026-11-01", "2027-03-31", on).map((o) => o.on)).toEqual(["2026-12-01", "2027-01-30", "2027-03-31"]);
    // No time interval and no idea how fast it's used: just the one date.
    expect(taskOccurrences({ intervalCount: null, intervalUnit: null, dueOn: "2026-12-01", usage: { every: 3000, perDay: null } }, "2026-11-01", "2027-12-31", on)).toEqual([
      { on: "2026-12-01", kind: "due" },
    ]);
  });

  it("has nothing for a task with no due date", () => {
    expect(taskOccurrences({ ...monthly, dueOn: null }, "2026-11-01", "2026-11-30", on)).toEqual([]);
  });
});

describe("the calendar feed's repeats", () => {
  const task = (over: Partial<MaintenanceTask>): MaintenanceTask => ({
    id: "t1", title: "Filter", notes: null, itemId: null, itemName: null, locationId: null, place: null,
    intervalCount: 1, intervalUnit: "week", dueOn: "2026-11-10", lastDoneOn: null, attachmentId: null,
    providerId: null, providerName: null, part: null, status: "due", timeDueOn: null, usage: null, dueEstimated: false, videos: [],
    ...over,
  });
  const opts = { name: "Home", appUrl: "https://ferret.example.com", timeZone: "UTC", now: new Date("2026-11-07T12:00:00Z") };

  it("lists at most FEED_REPEATS repeats a task, within FEED_MONTHS", () => {
    const daily = toICalendar([task({ intervalUnit: "day" })], opts);
    expect(daily.match(/BEGIN:VEVENT/g)).toHaveLength(1 + FEED_REPEATS);
    const yearly = toICalendar([task({ intervalUnit: "year" })], opts);
    expect(yearly.match(/BEGIN:VEVENT/g)).toHaveLength(1); // the next one is 2027-11-10, past the year
  });

  it("says when there won't be enough of its part", () => {
    const part = { itemId: "p1", name: "Filter", uses: 1, left: 1, shortOn: "2026-11-17" };
    const ics = toICalendar([task({ part })], opts);
    const events = ics.split("BEGIN:VEVENT").slice(1);
    expect(events[0]).not.toContain("buy more"); // Nov 10: the one filter
    expect(events[1]!.replace(/\r\n /g, "")).toContain("Not enough Filter left by then — buy more.");
  });

  it("keeps a task due more than a year off", () => {
    const ics = toICalendar([task({ intervalCount: 2, intervalUnit: "year", dueOn: "2028-01-05", status: "upcoming" })], opts);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20280105");
    expect(ics).toContain("UID:t1@ferret");
  });
});
