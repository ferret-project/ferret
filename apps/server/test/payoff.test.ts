/** Making it pay off: recall alerts, the insurance coverage check, and the weekly summary. */
import { today } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { sendWeeklyDigests } from "../src/lib/digest";
import { checkHousehold, normalise } from "../src/lib/recalls";
import type { RawRecall, Recalls } from "../src/ports";
import { config, FakeNotifier, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const RECALLS: RawRecall[] = [
  {
    RecallID: 11022,
    RecallDate: "2026-10-15T00:00:00",
    Title: "3M Company Recalls Scotch™ Thermal Laminators Due to Risk of Serious Injury or Death from Fire Hazard",
    Description: "This recall involves the Scotch™ thermal laminator, model number TL1302Z. The laminator is light gray/white.",
    URL: "https://cpsc.gov/Recalls/2027/3M-laminators",
    Products: [{ Name: "Scotch™ Thermal Laminators", Model: "" }],
    Importers: [{ Name: "3M Company, of St. Paul, Minnesota" }],
    Hazards: [{ Name: "The recalled thermal laminators can overheat, posing a fire hazard." }],
    Remedies: [{ Name: "Stop using and unplug the laminators and contact 3M for a full refund." }],
  },
  {
    RecallID: 10900,
    RecallDate: "2025-03-02T00:00:00",
    Title: "DEWALT Recalls Cordless Drills Due to Burn Hazard",
    Description: "This recall involves 20V MAX cordless drills, model DCD999.",
    Products: [{ Name: "20V MAX Cordless Drills", Model: "DCD999" }],
    Manufacturers: [{ Name: "Stanley Black & Decker" }],
  },
  {
    RecallID: 10777,
    RecallDate: "2024-06-01T00:00:00",
    Title: "Acme Recalls Kettles",
    Products: [{ Name: "Electric Kettle" }],
    ProductUPCs: [{ UPC: "012345678905" }],
  },
];

/** Like the CPSC's search: recalls with the brand in their title or among their companies. */
class FakeRecalls implements Recalls {
  asked: string[] = [];
  async forBrand(brand: string) {
    this.asked.push(brand);
    return RECALLS.filter((r) => ` ${normalise([r.Title, ...(r.Manufacturers ?? []).map((m) => m.Name), ...(r.Importers ?? []).map((m) => m.Name)].join(" "))} `.includes(` ${brand} `));
  }
}

describe("recall alerts", () => {
  it("asks about the brands you own (once a week), only when switched on, and finds what matches your things", async () => {
    const recalls = new FakeRecalls();
    const { db, deps, user } = await setup({ recalls });
    const ann = await user("ann"); // the first account: the server admin
    const laminator = await ann.addItem({ name: "Laminator", brand: "Scotch", model: "TL-1302Z" });
    const drill = await ann.addItem({ name: "Cordless drill", brand: "DeWalt" });
    const kettle = await ann.addItem({ name: "Kettle", brand: "Acme", barcode: "012345678905" });
    await ann.addItem({ name: "Leaf blower", brand: "DeWalt" }); // DeWalt, but not a drill
    await ann.addItem({ name: "Tape", brand: "Scotch" }); // Scotch, but not a laminator
    const v = { deps, db, householdId: ann.householdId, userId: "", timeZone: "UTC", via: "web" as const };

    // Off until the server admin switches it on: nothing asked.
    expect(await checkHousehold(v)).toBe(0);
    expect(recalls.asked).toEqual([]);
    expect(await json(ann.as("/api/v1/recalls"))).toMatchObject({ data: [], enabled: false });
    expect(await json(send(ann, "PUT", "/api/v1/server/recalls", { enabled: true }))).toMatchObject({ available: true, enabled: true });

    expect(await checkHousehold(v)).toBe(3);
    expect(recalls.asked.sort()).toEqual(["acme", "dewalt", "scotch"]); // each brand once
    expect(await checkHousehold(v)).toBe(0); // found once; brands not asked again this week
    expect(recalls.asked).toHaveLength(3);
    expect(await json(ann.as("/api/v1/server/recalls"))).toMatchObject({ brands: 3, recalls: 3 });
    const bob = await user("bob");
    expect((await bob.as("/api/v1/server/recalls")).status).toBe(403); // the server admin's switch
    const open = await json<{ data: { id: string; itemId: string; match: string; recall: { title: string } }[]; enabled: boolean }>(ann.as("/api/v1/recalls"));
    expect(open.enabled).toBe(true);
    expect(open.data.map((r) => [r.itemId, r.match])).toEqual([
      [kettle.id, "barcode"],
      [laminator.id, "model"],
      [drill.id, "possible"],
    ]);
    const bell = await json<{ data: { kind: string; severity: string; title: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.filter((a) => a.kind === "recall").map((a) => [a.severity, a.title])).toEqual([
      ["urgent", "Recalled: Kettle"],
      ["urgent", "Recalled: Laminator"],
      ["soon", "Possible recall: Cordless drill"],
    ]);

    // Not mine: it goes, and isn't found again; the item keeps it in its history.
    const possible = open.data.find((r) => r.match === "possible")!;
    expect((await send(ann, "POST", `/api/v1/recalls/${possible.id}`, { status: "dismissed" })).status).toBe(204);
    expect(await checkHousehold(v)).toBe(0);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/recalls"))).data).toHaveLength(2);
    expect(await json(ann.as(`/api/v1/items/${drill.id}/recalls`))).toMatchObject({ data: [{ status: "dismissed" }] });
    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${drill.id}/history`));
    expect(history.data[0]!.summary).toBe("Not affected by the recall: Cordless drill");
    // Another household doesn't see them.
    expect((await send(bob, "POST", `/api/v1/recalls/${possible.id}`, { status: "open" })).status).toBe(404);
  });
});

describe("coverage check", () => {
  it("compares limits with what the things they cover are worth", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    await ann.addItem({ name: "Ring", valueCents: 1_200_000, tags: ["Jewelry"] });
    await ann.addItem({ name: "Watch", valueCents: 220_000, tags: ["jewelry"] });
    await ann.addItem({ name: "Necklace", tags: ["Jewelry"] }); // no value
    await ann.addItem({ name: "Sofa", valueCents: 150_000 });

    const jewelry = await json<{ id: string; valueCents: number; shortCents: number; items: number; unvalued: number }>(
      send(ann, "POST", "/api/v1/coverage", { label: "Jewelry & watches", limitCents: 150_000, scope: "tag", tag: "Jewelry" }),
    );
    expect(jewelry).toMatchObject({ valueCents: 1_420_000, shortCents: 1_270_000, items: 3, unvalued: 1 });
    await send(ann, "POST", "/api/v1/coverage", { label: "Personal property", limitCents: 10_000_000, scope: "all" });
    expect((await json<{ data: { label: string; valueCents: number; shortCents: number }[] }>(ann.as("/api/v1/coverage"))).data.map((c) => [c.label, c.valueCents, c.shortCents])).toEqual([
      ["Jewelry & watches", 1_420_000, 1_270_000],
      ["Personal property", 1_570_000, 0],
    ]);
    const bell = await json<{ data: { kind: string; title: string; detail: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.filter((a) => a.kind === "coverage")).toEqual([
      expect.objectContaining({ title: "Jewelry & watches: worth $14,200", detail: "Covered for $1,500 — $12,700 short" }),
    ]);
    expect((await send(ann, "POST", "/api/v1/coverage", { label: "Guns", limitCents: 250_000, scope: "category" })).status).toBe(422);
    expect((await send(ann, "DELETE", `/api/v1/coverage/${jewelry.id}`)).status).toBe(204);
  });
});

describe("weekly summary", () => {
  it("is set per person, and sends nothing (that day) when there's nothing to say", async () => {
    const notifier = new FakeNotifier();
    const MAIL = "mailtos://ferret:pw@mail.example.com";
    const { deps, files, user } = await setup({ notifier, mailUrl: MAIL });
    const ann = await user("ann");
    const now = new Date();
    expect(await json(send(ann, "PUT", "/api/v1/me/weekly", { day: now.getDay(), email: true }))).toMatchObject({ day: now.getDay(), email: true, canEmail: true });
    const weekly = () => sendWeeklyDigests({ ...deps, files, appUrl: config.PUBLIC_URL, mailUrl: MAIL, now, on: today(now) } as Parameters<typeof sendWeeklyDigests>[0]);
    expect(await weekly()).toBe(0); // nothing to say: nothing sent
    expect(notifier.sent).toEqual([]);
    expect(await json(ann.as("/api/v1/me/weekly"))).toMatchObject({ lastSentOn: today(now) }); // and not tried again today
  });

  it("sends the bell's entries and what's lent out, once, on the day chosen — by email if asked", async () => {
    const notifier = new FakeNotifier();
    const MAIL = "mailtos://ferret:pw@mail.example.com";
    const { deps, files, user } = await setup({ notifier, mailUrl: MAIL });
    const ann = await user("ann");
    const now = new Date();
    await send(ann, "PUT", "/api/v1/me/weekly", { day: now.getDay(), email: true });
    await ann.addItem({ name: "New item" });
    const ladder = await ann.addItem({ name: "Ladder" });
    await send(ann, "POST", `/api/v1/items/${ladder.id}/loans`, { direction: "lent", person: "Sam" });
    const weekly = () => sendWeeklyDigests({ ...deps, files, appUrl: config.PUBLIC_URL, mailUrl: MAIL, now, on: today(now) } as Parameters<typeof sendWeeklyDigests>[0]);
    expect(await weekly()).toBe(1);
    expect(await weekly()).toBe(0); // once a week
    const mail = notifier.sent.at(-1)!;
    expect(mail.url).toBe(`${MAIL}?to=${encodeURIComponent("ann@example.com")}`);
    expect(mail.title).toBe("Your week in Ferret: 1 thing to look at");
    expect(mail.body).toContain("To name\n• ");
    expect(mail.body).toContain(`Lent out\n• Ladder — with Sam since ${today()}`);
  });
});
