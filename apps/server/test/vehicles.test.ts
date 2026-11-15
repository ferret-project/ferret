/** Vehicles from NHTSA (lib/vehicles.ts): VINs decoded into suggestions, and vehicle recalls. */
import type { ItemListing } from "@ferret/shared";
import { looksLikeVin, vinCheckDigitOk, vinOf } from "@ferret/shared/utils";
import { describe, expect, it } from "vitest";
import { nhtsaDate } from "../src/adapters/local/nhtsa";
import { checkHousehold } from "../src/lib/recalls";
import { calm, componentName, describeEngine, makeName, VIN_BACKFILL_JOB, VIN_JOB, vinBackfillJob, vinLookupJob } from "../src/lib/vehicles";
import type { Deps, RawVehicleRecall, RawVinDecode, VehicleData } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

/** NHTSA's own example VIN (a 2003 Honda Accord), and one whose check digit is wrong. */
const ACCORD = "1HGCM82633A004352";
const BAD_CHECK = "1HGCM82643A004352";

class FakeVehicles implements VehicleData {
  decoded: string[] = [];
  asked: string[] = [];
  async decodeVin(vin: string): Promise<RawVinDecode | null> {
    this.decoded.push(vin);
    if (vin !== ACCORD) return null;
    return { make: "HONDA", model: "Accord", year: 2003, trim: "EX-V6", body: "Coupe", displacementL: 2.998832712, cylinders: 6, fuel: "Gasoline", drive: null };
  }
  async recalls(make: string, model: string, year: number): Promise<RawVehicleRecall[]> {
    this.asked.push(`${year} ${make} ${model}`);
    return [
      {
        campaign: "19V182000",
        reportedOn: "2019-03-06",
        manufacturer: "Honda (American Honda Motor Co.)",
        component: "AIR BAGS:FRONTAL:DRIVER SIDE:INFLATOR MODULE",
        summary: "Honda is recalling specific 2003 Accord vehicles…",
        consequence: "An explosion of an inflator may result in sharp metal fragments striking the driver.",
        remedy: "Dealers will replace the driver's air bag inflator, free of charge.",
        notes: null,
      },
    ];
  }
}

async function vehicleSetup() {
  const vehicles = new FakeVehicles();
  const s = await setup({ vehicles });
  s.jobs.register({ [VIN_JOB]: vinLookupJob(s.deps as Deps), [VIN_BACKFILL_JOB]: vinBackfillJob(s.deps as Deps) });
  const ann = await s.user("ann"); // the server admin
  const cars = await json<{ id: string }>(send(ann, "POST", "/api/v1/categories", { name: "Vehicles", fields: [{ key: "vin", label: "VIN", type: "text" }] }));
  return { ...s, vehicles, ann, cars };
}

describe("VINs", () => {
  it("are 17 characters without I, O or Q; a serial number is only one with the right check digit", () => {
    expect(looksLikeVin("1hgcm8263-3a004352")).toBe(true);
    expect(looksLikeVin("1HGCM82633A00435")).toBe(false);
    expect(looksLikeVin("1HGCM82633A00435O")).toBe(false);
    expect(vinCheckDigitOk(ACCORD)).toBe(true);
    expect(vinCheckDigitOk(BAD_CHECK)).toBe(false);
    expect(vinOf({ customFields: { vin: BAD_CHECK.toLowerCase() } })).toBe(BAD_CHECK); // typed in a VIN field: taken
    expect(vinOf({ serialNumber: BAD_CHECK })).toBeNull(); // a serial number: only when it's surely a VIN
    expect(vinOf({ serialNumber: ACCORD })).toBe(ACCORD);
  });

  it("read NHTSA's words the way people write them", () => {
    expect(nhtsaDate("27/06/2019")).toBe("2019-06-27");
    expect(makeName("HONDA")).toBe("Honda");
    expect(makeName("MERCEDES-BENZ")).toBe("Mercedes-Benz");
    expect(makeName("BMW")).toBe("BMW");
    expect(describeEngine({ displacementL: 2.998832712, cylinders: 6, fuel: "Gasoline" })).toBe("3.0 L 6-cylinder, gasoline");
    expect(componentName("AIR BAGS:FRONTAL:DRIVER SIDE")).toBe("Air bags: frontal, driver side");
    expect(calm("THE WIPER MOTOR MAY FAIL. CONTACT NHTSA AT 1-888-327-4236.")).toBe("The wiper motor may fail. Contact NHTSA at 1-888-327-4236.");
    expect(calm("Dealers will replace the inflator.")).toBe("Dealers will replace the inflator.");
  });
});

describe("vehicle look-ups", () => {
  it("decode a VIN only when the server admin has switched them on, and keep the answer on the thing", async () => {
    const { ann, cars, vehicles, jobs } = await vehicleSetup();
    const car = await ann.addItem({ name: "Car", categoryId: cars.id, customFields: { vin: ACCORD } });
    await jobs.drain();
    expect(vehicles.decoded).toEqual([]); // off: nothing leaves the server
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${car.id}`))).vehicle ?? null).toBeNull();

    // Switching on looks up the VINs already in Ferret.
    expect(await json(send(ann, "PUT", "/api/v1/server/vehicles", { enabled: true }))).toMatchObject({ available: true, enabled: true });
    await jobs.drain();
    expect(vehicles.decoded).toEqual([ACCORD]);
    const page = await json<ItemListing>(ann.as(`/api/v1/items/${car.id}`));
    expect(page.vehicle).toMatchObject({ vin: ACCORD, status: "found", make: "Honda", model: "Accord", year: 2003, trim: "EX-V6", engine: "3.0 L 6-cylinder, gasoline" });
    // A suggestion, not a change: the thing keeps its name and has no brand until someone applies them.
    expect(page).toMatchObject({ name: "Car", brand: null });

    // A VIN NHTSA doesn't know is kept as unknown; taking the VIN away forgets the answer.
    await send(ann, "PATCH", `/api/v1/items/${car.id}`, { customFields: { vin: "WVWZZZ1JZXW000001" } });
    await jobs.drain();
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${car.id}`))).vehicle).toMatchObject({ vin: "WVWZZZ1JZXW000001", status: "unknown", make: null });
    await send(ann, "PATCH", `/api/v1/items/${car.id}`, { customFields: {} });
    expect((await json<ItemListing>(ann.as(`/api/v1/items/${car.id}`))).vehicle ?? null).toBeNull();

    const bob = await (await vehicleSetup()).user("bob");
    expect((await bob.as("/api/v1/server/vehicles")).status).toBe(403); // the server admin's switch
  });

  it("find NHTSA's recalls for a decoded make, model and year — asked once a week, a sure match", async () => {
    const s = await vehicleSetup();
    const { ann, cars, vehicles, jobs, deps, db } = s;
    await send(ann, "PUT", "/api/v1/server/vehicles", { enabled: true });
    const car = await ann.addItem({ name: "Accord", categoryId: cars.id, customFields: { vin: ACCORD } });
    const twin = await ann.addItem({ name: "Second Accord", serialNumber: ACCORD });
    await jobs.drain();
    const v = { deps: deps as Deps, db, householdId: ann.householdId, userId: "", timeZone: "UTC", currency: "USD", via: "web" as const };
    await checkHousehold(v);
    expect(vehicles.asked).toEqual(["2003 Honda Accord"]); // once for both
    expect(await checkHousehold(v)).toBe(0); // found once, not asked again this week
    expect(vehicles.asked).toHaveLength(1);

    const open = await json<{ data: { itemId: string; match: string; recall: { title: string; url: string; recalledOn: string } }[] }>(ann.as("/api/v1/recalls"));
    expect(open.data.map((r) => r.itemId).sort()).toEqual([car.id, twin.id].sort());
    expect(open.data[0]).toMatchObject({
      match: "model",
      recall: { title: "Air bags: frontal, driver side, inflator module (NHTSA 19V182000)", recalledOn: "2019-03-06", url: "https://www.nhtsa.gov/recalls?nhtsaId=19V182000" },
    });
    // Counted apart from the CPSC's.
    expect(await json(ann.as("/api/v1/server/vehicles"))).toMatchObject({ vehicles: 2, recalls: 1 });
    expect(await json(ann.as("/api/v1/server/recalls"))).toMatchObject({ recalls: 0, brands: 0 });
  });
});
