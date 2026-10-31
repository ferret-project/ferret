/** Reminders to other apps through Apprise: channels per person, sealed URLs, test messages, the daily send. */
import { addDays, type NotificationChannel, today } from "@ferret/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { member, notificationChannel } from "../src/db/schema";
import { sendReminders } from "../src/jobs/remind";
import { FakeNotifier, FakePush, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) =>
  u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const NTFY = "ntfys://ntfy.example/ann-secret-topic";

describe("notifications to other apps", () => {
  it("keeps each person's channels to themselves, sealed, and sends a test", async () => {
    const notifier = new FakeNotifier();
    const { user, db } = await setup({ notifier });
    const ann = await user("ann");
    const bob = await user("bob");

    const created = await send(ann, "POST", "/api/v1/notifications", { name: "My phone", url: NTFY });
    expect(created.status).toBe(201);
    const channel = await json<NotificationChannel>(created);
    expect(channel).toMatchObject({ name: "My phone", service: "ntfys", lastError: null });
    expect(channel).not.toHaveProperty("url");

    // The URL holds a token: it's stored sealed, never as written.
    const [row] = await db.select().from(notificationChannel);
    expect(row!.urlSealed).not.toContain("ann-secret-topic");

    expect(await json(ann.as("/api/v1/notifications"))).toEqual({ enabled: true, data: [channel] });
    expect(await json(bob.as("/api/v1/notifications"))).toEqual({ enabled: true, data: [] });
    expect((await send(bob, "POST", `/api/v1/notifications/${channel.id}/test`)).status).toBe(404);
    expect((await send(bob, "DELETE", `/api/v1/notifications/${channel.id}`)).status).toBe(404);

    expect(await json(send(ann, "POST", `/api/v1/notifications/${channel.id}/test`))).toEqual({ sent: true });
    expect(notifier.sent).toEqual([expect.objectContaining({ url: NTFY, title: "Ferret reminders are on" })]);

    notifier.failing.set(NTFY, "The service didn't accept it");
    const failed = await send(ann, "POST", `/api/v1/notifications/${channel.id}/test`);
    expect(failed.status).toBe(502);
    expect((await json<{ data: NotificationChannel[] }>(ann.as("/api/v1/notifications"))).data[0]!.lastError).toBe("The service didn't accept it");

    expect((await send(ann, "DELETE", `/api/v1/notifications/${channel.id}`)).status).toBe(204);
    expect(await db.select().from(notificationChannel)).toEqual([]);
  });

  it("rejects things that aren't Apprise URLs", async () => {
    const { user } = await setup({ notifier: new FakeNotifier() });
    const ann = await user("ann");
    expect((await send(ann, "POST", "/api/v1/notifications", { name: "Phone", url: "not a url" })).status).toBe(422);
    expect((await send(ann, "POST", "/api/v1/notifications", { name: "", url: NTFY })).status).toBe(422);
  });

  it("says when Apprise isn't set up", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await json(ann.as("/api/v1/notifications"))).toEqual({ enabled: false, data: [] });
    expect((await send(ann, "POST", "/api/v1/notifications", { name: "Phone", url: NTFY })).status).toBe(409);
  });

  it("sends one daily digest per channel and device — maintenance and warranties ending — retrying failures", async () => {
    const notifier = new FakeNotifier();
    const push = new FakePush();
    const { user, deps, db, files } = await setup({ notifier, push });
    const ann = await user("ann");
    const furnace = await ann.addItem({ name: "Furnace" });
    const tv = await ann.addItem({ name: "TV" });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Replace filter", itemId: furnace.id, dueOn: addDays(today(), -3) });
    await send(ann, "POST", "/api/v1/maintenance", { title: "Clean gutters", dueOn: addDays(today(), 5) }); // not urgent yet
    await send(ann, "POST", `/api/v1/items/${tv.id}/warranties`, { endsOn: addDays(today(), 4), provider: "LG" });
    await send(ann, "POST", `/api/v1/items/${tv.id}/warranties`, { endsOn: addDays(today(), 20) }); // not urgent yet
    await send(ann, "POST", "/api/v1/notifications", { name: "Phone", url: NTFY });
    await send(ann, "POST", "/api/v1/notifications", { name: "Email", url: "mailtos://ann:pw@example.com" });
    await send(ann, "POST", "/api/v1/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/1", keys: { p256dh: "BKey", auth: "secret" } });
    notifier.failing.set("mailtos://ann:pw@example.com", "Couldn't reach Apprise");

    const at = (hour: number) => () => new Date(new Date().setHours(hour, 5, 0, 0));
    const remind = (hour: number) =>
      sendReminders({ ...deps, files, appUrl: "https://ferret.test", remindHour: 9, now: at(hour) })({}, { lastAttempt: false });

    await remind(7); // too early
    expect(notifier.sent).toEqual([]);
    await remind(10);
    expect(notifier.sent).toEqual([
      {
        url: NTFY,
        title: "2 things need attention",
        body: "• Replace filter (Furnace) — 3 days overdue\n• TV warranty (LG) — Ends in 4 days — anything to claim?\n\nhttps://ferret.test/#/",
      },
    ]);
    expect(push.sent).toEqual([
      expect.objectContaining({ title: "2 things need attention", body: "Replace filter (Furnace) · TV warranty (LG)" }),
    ]);

    // The failed channel keeps its reason and is tried again next hour; the others aren't sent twice.
    const failing = await db.select().from(notificationChannel).where(eq(notificationChannel.name, "Email"));
    expect(failing[0]).toMatchObject({ lastError: "Couldn't reach Apprise", lastNotifiedOn: null });
    notifier.failing.clear();
    await remind(11);
    expect(notifier.sent.map((s) => s.url)).toEqual([NTFY, "mailtos://ann:pw@example.com"]);
    expect(push.sent).toHaveLength(1);
    expect((await db.select().from(notificationChannel)).every((c) => c.lastError === null && c.lastNotifiedOn === today())).toBe(true);

    // Someone who leaves the household stops hearing about it.
    await db.delete(member).where(eq(member.organizationId, ann.householdId));
    await sendReminders({ ...deps, files, appUrl: "", remindHour: 0, now: () => new Date(Date.now() + 86_400_000) })({}, { lastAttempt: false });
    expect(await db.select().from(notificationChannel)).toEqual([]);
  });
});
