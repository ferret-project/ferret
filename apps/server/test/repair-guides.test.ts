/** "Repair guides on iFixit" (lib/repair-guides.ts): a link only on a sure match, asked once per brand + model. */
import type { ItemListing, VehicleInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { guideQuery, pickGuide, REPAIR_GUIDE_JOB, repairGuideJob } from "../src/lib/repair-guides";
import type { Deps, RepairGuides } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const DEVICES: Record<string, { title: string; url: string }[]> = {
  "DeWalt DCD771C2": [
    { title: "DeWalt DCD771C2", url: "https://www.ifixit.com/Device/DeWalt_DCD771C2" },
    { title: "DeWalt DCD771C2 Type-1", url: "https://www.ifixit.com/Device/Dewalt_Cordless_Drill_DCD771C2__TYPE_1_2014" },
  ],
  "Apple iPhone 12": [{ title: "iPhone 12", url: "https://www.ifixit.com/Device/iPhone_12" }],
  "Acme X100": [{ title: "Acme Toaster Oven", url: "https://www.ifixit.com/Device/Acme_Toaster_Oven" }],
};

class FakeGuides implements RepairGuides {
  asked: string[] = [];
  async searchDevices(query: string) {
    this.asked.push(query);
    return DEVICES[query] ?? [];
  }
}

const accord: VehicleInfo = { vin: "1HGCM82633A004352", status: "found", make: "Honda", model: "Accord", year: 2003, trim: null, body: null, engine: null, drive: null, decodedAt: null };

describe("repair guide matching", () => {
  it("asks only about brand + model with a digit in it, or a decoded vehicle", () => {
    expect(guideQuery({ brand: "DeWalt", model: "DCD771C2", vehicle: null })).toMatchObject({ query: "DeWalt DCD771C2" });
    expect(guideQuery({ brand: "Acme", model: "Classic", vehicle: null })).toBeNull();
    expect(guideQuery({ brand: null, model: "DCD771C2", vehicle: null })).toBeNull();
    expect(guideQuery({ brand: null, model: null, vehicle: accord })).toMatchObject({ query: "2003 Honda Accord", year: 2003 }); // with the year, iFixit finds the right generation
  });

  it("takes a device only when its title surely is the thing", () => {
    expect(pickGuide(DEVICES["DeWalt DCD771C2"]!, { brand: "DeWalt", model: "DCD771C2", vehicle: null }, null)?.title).toBe("DeWalt DCD771C2");
    expect(pickGuide(DEVICES["Apple iPhone 12"]!, { brand: "Apple", model: "iPhone 12", vehicle: null }, null)?.title).toBe("iPhone 12");
    expect(pickGuide(DEVICES["Acme X100"]!, { brand: "Acme", model: "X100", vehicle: null }, null)).toBeNull();
    const years = [{ title: "1998-2002 Honda Accord", url: "https://www.ifixit.com/Device/a" }, { title: "2003-2007 Honda Accord", url: "https://www.ifixit.com/Device/b" }];
    expect(pickGuide(years, { brand: null, model: null, vehicle: accord }, 2003)?.url).toBe("https://www.ifixit.com/Device/b");
    expect(pickGuide([{ title: "2008-2012 Honda Accord", url: "https://www.ifixit.com/Device/c" }], { brand: null, model: null, vehicle: accord }, 2003)).toBeNull();
  });
});

describe("repair guide links", () => {
  it("show on a thing's page once switched on, asked once per brand + model for every household", async () => {
    const guides = new FakeGuides();
    const s = await setup({ repairGuides: guides });
    s.jobs.register({ [REPAIR_GUIDE_JOB]: repairGuideJob(s.deps as Deps) });
    const ann = await s.user("ann");
    const drill = await ann.addItem({ name: "Drill", brand: "DeWalt", model: "DCD771C2" });
    await s.jobs.drain();
    expect(guides.asked).toEqual([]); // off: nothing leaves the server
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${drill.id}`))).repairGuide ?? null).toBeNull();

    expect(await json(send(ann, "PUT", "/api/v1/server/repair-guides", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    // Opening its page asks in the background; the link is there next time.
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${drill.id}`))).repairGuide ?? null).toBeNull();
    await s.jobs.drain();
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${drill.id}`))).repairGuide).toEqual({ title: "DeWalt DCD771C2", url: "https://www.ifixit.com/Device/DeWalt_DCD771C2" });

    // Another household's drill of the same model: already known, not asked again. A vague one: never asked.
    const bob = await s.user("bob");
    const theirs = await bob.addItem({ name: "My drill", brand: "dewalt", model: "DCD-771-C2" });
    await bob.addItem({ name: "Toaster", brand: "Acme", model: "Classic" });
    await s.jobs.drain();
    expect((await json<ItemListing>(bob.as(`/api/v1/items/${theirs.id}`))).repairGuide?.title).toBe("DeWalt DCD771C2");
    expect(guides.asked).toEqual(["DeWalt DCD771C2"]);
    expect(await json(ann.as("/api/v1/server/repair-guides"))).toMatchObject({ asked: 1, found: 1 });
  });
});
