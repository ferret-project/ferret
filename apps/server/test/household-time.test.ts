import { localParts, today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { member } from "../src/db/schema";
import { sendReminders } from "../src/jobs/remind";
import { serverTimeZone } from "../src/lib/household-time";
import { FakePush, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("a household's time zone", () => {
  it("reads a moment's date and hour where the household is", () => {
    const at = new Date("2026-10-20T03:30:00Z"); // Tuesday 03:30 in UTC = Monday evening in Denver
    expect(today(at, "UTC")).toBe("2026-10-20");
    expect(today(at, "America/Denver")).toBe("2026-10-19");
    expect(localParts(at, "America/Denver")).toMatchObject({ hour: 21, minute: 30, weekday: 1 });
    expect(localParts(at, "Asia/Tokyo")).toMatchObject({ day: 20, hour: 12, weekday: 2 });
    // No zone: the machine's own clock, as before.
    expect(today(at)).toBe(today(at, serverTimeZone()));
  });

  it("is set in Settings by the owner and admins, and read by everyone in it", async () => {
    const { user, db } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    expect(await json(ann.as("/api/v1/household/settings"))).toEqual({ timeZone: null, serverTimeZone: serverTimeZone() });

    expect(await json(send(ann, "PUT", "/api/v1/household/settings", { timeZone: "America/Denver" }))).toMatchObject({ timeZone: "America/Denver" });
    expect((await send(ann, "PUT", "/api/v1/household/settings", { timeZone: "Mars/Olympus_Mons" })).status).toBe(422);
    expect((await json<{ timeZone: string }>(ann.as("/api/v1/household/settings"))).timeZone).toBe("America/Denver");

    // A member sees it, but can't change it.
    const bobId = (await db.query.user.findFirst({ where: (u, { eq }) => eq(u.name, "bob") }))!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: bobId, role: "member", createdAt: new Date() });
    const asBob = (method: string, data?: object) =>
      bob.as("/api/v1/household/settings", { method, headers: { "X-Household-Id": ann.householdId }, ...(data ? { body: JSON.stringify(data) } : {}) });
    expect(await json(asBob("GET"))).toMatchObject({ timeZone: "America/Denver" });
    expect((await asBob("PUT", { timeZone: "UTC" })).status).toBe(403);

    // Back to the server's own zone.
    expect(await json(send(ann, "PUT", "/api/v1/household/settings", { timeZone: null }))).toMatchObject({ timeZone: null });
  });

  it("sends each household's reminders from REMIND_HOUR where it is", async () => {
    const push = new FakePush();
    const { user, deps, files } = await setup({ push });
    const denver = await user("ann");
    const tokyo = await user("kenji");
    for (const [u, tz, n] of [[denver, "America/Denver", 1], [tokyo, "Asia/Tokyo", 2]] as const) {
      await send(u, "PUT", "/api/v1/household/settings", { timeZone: tz });
      await send(u, "POST", "/api/v1/maintenance", { title: "Test smoke alarms" }); // a one-off: due today
      await send(u, "POST", "/api/v1/push/subscribe", { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "BKey", auth: "secret" } });
    }
    const remind = (iso: string) => sendReminders({ ...deps, files, appUrl: "https://ferret.test", remindHour: 9, now: () => new Date(iso) })({}, { lastAttempt: false });
    const sentTo = () => push.sent.map((s) => s.endpoint.split("/").pop());

    await remind("2026-10-20T14:00:00Z"); // 08:00 in Denver, 23:00 in Tokyo
    expect(sentTo()).toEqual(["2"]);
    await remind("2026-10-20T15:00:00Z"); // 09:00 in Denver
    expect(sentTo()).toEqual(["2", "1"]);
    await remind("2026-10-20T16:00:00Z"); // each already reminded on its own today
    expect(push.sent).toHaveLength(2);
  });
});
