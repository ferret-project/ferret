/** Maintenance: tasks on items and places, marking them done, history, and household isolation. */
import { addDays, type MaintenanceLogEntry, type MaintenanceTask, nextDue, type Provider, type ProviderVisit, today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { calendarFeed, member, pushSubscription } from "../src/db/schema";
import { sendReminders } from "../src/jobs/remind";
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
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);

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
