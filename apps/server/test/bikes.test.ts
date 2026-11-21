/** Bike Index (lib/bikes.ts): whether a bike's serial number is reported stolen, for bikes only, kept a day. */
import type { ItemBikeIndex, StolenBikeReport } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { BikeIndexRegistry, serialKey } from "../src/adapters/local/bikeindex";
import type { StolenBikes } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const REPORT: StolenBikeReport = { id: "3548192", serial: "2508WSAC0055", maker: "Salsa", model: "Flyway", year: 2026, stolenOn: "2026-11-20", location: "Seattle, WA", url: "https://bikeindex.org/bikes/3548192" };

class FakeBikeIndex implements StolenBikes {
  asked: string[] = [];
  async stolenWithSerial(serial: string) {
    this.asked.push(serial);
    return serialKey(serial) === "2508WSAC0055" ? [REPORT] : [];
  }
}

describe("Bike Index", () => {
  it("checks a bike's serial in the background once switched on — and only for bikes", async () => {
    const stolenBikes = new FakeBikeIndex();
    const { user, jobs } = await setup({ stolenBikes });
    const ann = await user("ann");
    const used = await ann.addItem({ name: "Gravel bike", serialNumber: "2508-wsac-0055" });
    const mine = await ann.addItem({ name: "Road bicycle", serialNumber: "WTU088C0390K" });
    const unnumbered = await ann.addItem({ name: "Kids' bike" });
    const drill = await ann.addItem({ name: "Drill", serialNumber: "2508WSAC0055" });

    expect(await json(ann.as(`/api/v1/items/${used.id}/bike-index`))).toEqual({ status: "off" });
    expect(await json(send(ann, "PUT", "/api/v1/server/bike-index", { enabled: true }))).toMatchObject({ available: true, enabled: true, checked: 0 });
    expect(await json(ann.as(`/api/v1/items/${used.id}/bike-index`))).toEqual({ status: "pending" });
    await json(ann.as(`/api/v1/items/${mine.id}/bike-index`));
    await jobs.drain();
    expect(await json<ItemBikeIndex>(ann.as(`/api/v1/items/${used.id}/bike-index`))).toEqual({ status: "stolen", reports: [REPORT] });
    expect(await json(ann.as(`/api/v1/items/${mine.id}/bike-index`))).toEqual({ status: "clear" });
    expect(await json(ann.as(`/api/v1/items/${unnumbered.id}/bike-index`))).toEqual({ status: "none" });
    // Not a bike: its serial is never sent.
    expect(await json(ann.as(`/api/v1/items/${drill.id}/bike-index`))).toEqual({ status: "off" });
    await jobs.drain();
    expect(stolenBikes.asked.sort()).toEqual(["2508-wsac-0055", "WTU088C0390K"]);
    const bob = await user("bob");
    expect((await send(bob, "PUT", "/api/v1/server/bike-index", { enabled: false })).status).toBe(403);
  });

  it("takes only Bike Index's stolen bikes with this very serial", async () => {
    let asked: URL | null = null;
    const fetcher = (async (input: string | URL | Request) => {
      asked = new URL(String(input));
      return new Response(
        JSON.stringify({
          bikes: [
            { id: 1, serial: "2508WSAC0055", manufacturer_name: "Salsa", stolen: true, date_stolen: 1795220520, stolen_location: "Seattle, WA", url: "https://bikeindex.org/bikes/1" },
            { id: 2, serial: "2508WSAC0056", manufacturer_name: "Salsa", stolen: true },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const found = await new BikeIndexRegistry(fetcher).stolenWithSerial("2508 wsac 0055");
    expect(found).toMatchObject([{ id: "1", maker: "Salsa", stolenOn: "2026-11-21", location: "Seattle, WA" }]);
    expect(asked!.searchParams.get("stolenness")).toBe("stolen");
    expect(await new BikeIndexRegistry(fetcher).stolenWithSerial("abc")).toEqual([]); // too short to mean anything
  });
});
