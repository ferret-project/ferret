/** Maintenance by use: readings, "every 5,000 miles" (or by time, whichever first), projections, done at a reading. */
import { addDays, effectiveDue, type MaintenanceTask, today, type UsageSummary } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("when maintenance by use is due", () => {
  const on = "2026-10-19";
  it("is the day a reading reached it", () => {
    const r = [{ value: 40000, readOn: "2026-06-01" }, { value: 45200, readOn: "2026-09-01" }, { value: 46000, readOn: "2026-10-01" }];
    expect(effectiveDue({ timeDueOn: null, usageDueAt: 45000 }, r, on)).toEqual({ dueOn: "2026-09-01", estimated: false });
  });
  it("is projected from how fast it's used", () => {
    // 3,000 miles in 60 days = 50 a day; 2,000 more to go = 40 days on from the last reading.
    const r = [{ value: 40000, readOn: "2026-08-01" }, { value: 43000, readOn: "2026-09-30" }];
    expect(effectiveDue({ timeDueOn: null, usageDueAt: 45000 }, r, on)).toEqual({ dueOn: "2026-11-09", estimated: true });
    // …unless the calendar says sooner.
    expect(effectiveDue({ timeDueOn: "2026-11-01", usageDueAt: 45000 }, r, on)).toEqual({ dueOn: "2026-11-01", estimated: false });
  });
  it("is a year on from the last reading while there's no rate", () => {
    expect(effectiveDue({ timeDueOn: null, usageDueAt: 45000 }, [{ value: 40000, readOn: "2026-10-01" }], on)).toEqual({ dueOn: "2027-10-01", estimated: true });
  });
  it("is just the date when it isn't by use", () => {
    expect(effectiveDue({ timeDueOn: "2027-01-01", usageDueAt: null }, [], on)).toEqual({ dueOn: "2027-01-01", estimated: false });
  });
});

describe("maintenance by use", () => {
  it("counts from readings, reschedules as they come, and moves on from the reading when done", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const car = await ann.addItem({ name: "Car" });
    const task = (data: object) => send(ann, "POST", "/api/v1/maintenance", { title: "Change oil", itemId: car.id, usageEvery: 5000, ...data });

    // The car has to count something, and say where it's at.
    expect((await task({})).status).toBe(422);
    await send(ann, "PATCH", `/api/v1/items/${car.id}`, { usageUnit: "miles" });
    expect((await task({})).status).toBe(422);
    const start = addDays(today(), -60);
    expect((await send(ann, "POST", `/api/v1/items/${car.id}/usage`, { value: 40000, readOn: start })).status).toBe(201);

    const oil = await json<MaintenanceTask>(task({}));
    expect(oil.usage).toMatchObject({ every: 5000, dueAt: 45000, unit: "miles", now: 40000, perDay: null });
    expect(oil).toMatchObject({ dueOn: addDays(start, 365), dueEstimated: true, timeDueOn: null });

    // A second reading gives a rate (2,000 in 60 days): due when 3,000 more are done — 90 days on.
    await send(ann, "POST", `/api/v1/items/${car.id}/usage`, { value: 42000 });
    const projected = await json<MaintenanceTask>(ann.as(`/api/v1/maintenance/${oil.id}`));
    expect(projected).toMatchObject({ dueOn: addDays(today(), 90), dueEstimated: true, status: "upcoming" });

    // Whichever comes first: every 5,000 miles or a month.
    const both = await json<MaintenanceTask>(task({ title: "Check tyres", intervalCount: 1, intervalUnit: "month" }));
    expect(both).toMatchObject({ dueEstimated: false });
    expect(both.dueOn).toBe(both.timeDueOn);

    // Past it: due from the day it got there.
    await send(ann, "POST", `/api/v1/items/${car.id}/usage`, { value: 45100 });
    expect(await json<MaintenanceTask>(ann.as(`/api/v1/maintenance/${oil.id}`))).toMatchObject({ dueOn: today(), dueEstimated: false, status: "due" });

    // Done at 45,300: next at 50,300.
    const done = await json<MaintenanceTask>(send(ann, "POST", `/api/v1/maintenance/${oil.id}/done`, { reading: 45300 }));
    expect(done.usage).toMatchObject({ dueAt: 50300, now: 45300 });
    expect(done.status).toBe("upcoming");
    const summary = await json<UsageSummary>(ann.as(`/api/v1/items/${car.id}/usage`));
    expect(summary.readings.map((r) => r.value)).toEqual([45300, 45100, 42000, 40000]);
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${car.id}/history`));
    expect(history.data.map((h) => h.summary)).toContain("Done: Change oil (Car) at 45,300 miles");

    // A typo removed: rescheduled without it.
    const typo = await json<{ id: string }>(send(ann, "POST", `/api/v1/items/${car.id}/usage`, { value: 99999 }));
    expect((await json<MaintenanceTask>(ann.as(`/api/v1/maintenance/${oil.id}`))).dueOn).toBe(today());
    expect((await send(ann, "DELETE", `/api/v1/usage/${typo.id}`)).status).toBe(204);
    expect((await json<MaintenanceTask>(ann.as(`/api/v1/maintenance/${oil.id}`))).status).toBe("upcoming");

    // Changing the amount counts on from the same start.
    const longer = await json<MaintenanceTask>(send(ann, "PATCH", `/api/v1/maintenance/${oil.id}`, { usageEvery: 7500 }));
    expect(longer.usage?.dueAt).toBe(52800);

    // Someone else's car isn't theirs to read.
    const bob = await user("bob");
    expect((await send(bob, "POST", `/api/v1/items/${car.id}/usage`, { value: 1 })).status).toBe(404);
  });
});
