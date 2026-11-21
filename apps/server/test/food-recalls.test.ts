/** The FDA's food and medicine recalls (lib/recalls.ts, openFDA): fetched once a day, matched by barcode only. */
import { describe, expect, it } from "vitest";
import { OpenFdaRecalls } from "../src/adapters/local/openfda";
import { checkHousehold, fdaRow, refreshFdaRecalls, upcsIn, validCode } from "../src/lib/recalls";
import type { FdaRecalls, RawFdaRecall } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const CHEDDAR: RawFdaRecall = {
  recall_number: "H-0197-2027",
  event_id: "99123",
  report_date: "20261111",
  status: "Ongoing",
  classification: "Class I",
  product_description: 'Raw milk cheddar cheese packed in vacuum sealed clear plastic, "FAMILY FARMSTEAD MILD RAW CHEDDAR", 8oz. UPC: 860007132216; Family Farmstead Dairy',
  code_info: "No lot code, Best By JUL 22 27",
  reason_for_recall: "Potential Listeria monocytogenes contamination.",
  recalling_firm: "Family Farmstead Dairy, LLC",
  city: "Worcester",
  state: "NY",
};
const TABLETS: RawFdaRecall = {
  recall_number: "D-0558-2026",
  report_date: "20261001",
  status: "Ongoing",
  classification: "Class II",
  product_description: "Children's chewable tablets, 30 count bottle, UPC 3 07660 74610 2",
  code_info: "Lot 12345678",
  reason_for_recall: "Presence of foreign substance: small metallic particles.",
  recalling_firm: "Some Pharma Inc.",
};
/** No barcode: can't be matched, so not kept. */
const NO_CODE: RawFdaRecall = { recall_number: "H-0001-2027", report_date: "20261110", product_description: "Bulk sesame seeds", recalling_firm: "Spice Co" };

class FakeFda implements FdaRecalls {
  asked: string[] = [];
  async reportedSince(kind: "food" | "drug", from: string, to: string) {
    this.asked.push(`${kind} ${from}-${to}`);
    return kind === "food" ? [CHEDDAR, NO_CODE] : [TABLETS];
  }
}

describe("food and medicine recalls", () => {
  it("pick out the barcodes a report names, by their check digit", () => {
    expect(validCode("860007132216")).toBe(true);
    expect(validCode("860007132217")).toBe(false);
    expect(upcsIn("UPC: 860007132216; lot 123456789013")).toEqual(["860007132216"]); // the lot number fails its check
    expect(upcsIn("UPC 3 07660 74610 2 and 8 24790 85270 6")).toEqual(["307660746102", "824790852706"]);
    expect(upcsIn("Item 860007132216")).toEqual([]); // no word saying it's a barcode
    expect(fdaRow(NO_CODE)).toBeNull();
    expect(fdaRow({ ...CHEDDAR, kind: "food" })).toMatchObject({
      id: "fda:H-0197-2027",
      recalledOn: "2026-11-11",
      title: "Family Farmstead Dairy, LLC recalls Raw milk cheddar cheese packed in vacuum sealed clear plastic",
      hazard: "Potential Listeria monocytogenes contamination.",
      remedy: "FDA food recall · Class I · Ongoing",
      upcs: ["860007132216"],
      url: "https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=99123",
    });
    expect(fdaRow({ ...CHEDDAR, kind: "food" })!.description).toContain("Affected: No lot code, Best By JUL 22 27");
  });

  it("are fetched once a day with recall checks on, and match things by barcode — never by brand and name", async () => {
    const fda = new FakeFda();
    const { db, deps, user } = await setup({ fdaRecalls: fda });
    const ann = await user("ann");
    const cheese = await ann.addItem({ name: "Cheddar cheese", brand: "Family Farmstead Dairy", barcode: "860007132216" });
    // Same firm, same kind of thing, another barcode: not matched (it would be a CPSC "possible").
    await ann.addItem({ name: "Mild cheddar cheese", brand: "Family Farmstead Dairy", barcode: "012345678905" });
    const tablets = await ann.addItem({ name: "Chewable tablets", barcode: "0307660746102" }); // EAN-13 spelling of the UPC
    const v = { deps, db, householdId: ann.householdId, userId: "", timeZone: "UTC", currency: "USD", via: "web" as const };

    expect(await checkHousehold(v)).toBe(0); // off
    expect(fda.asked).toEqual([]);
    await send(ann, "PUT", "/api/v1/server/recalls", { enabled: true });
    expect(await checkHousehold(v)).toBe(2);
    expect(fda.asked).toHaveLength(2);
    expect(fda.asked[0]).toMatch(/^food \d{8}-\d{8}$/);
    const open = await json<{ data: { itemId: string; match: string; recall: { title: string; remedy: string } }[] }>(ann.as("/api/v1/recalls"));
    expect(open.data.map((r) => [r.itemId, r.match]).sort()).toEqual([[cheese.id, "barcode"], [tablets.id, "barcode"]].sort());
    expect(await json(ann.as("/api/v1/server/recalls"))).toMatchObject({ available: true, fda: 2 });

    // Again today: not fetched again.
    await checkHousehold(v);
    expect(fda.asked).toHaveLength(2);
    // Tomorrow: from a week before the last day fetched, for late reports.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await refreshFdaRecalls(deps, tomorrow);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
    expect(fda.asked[2]).toBe(`food ${weekAgo}-${tomorrow.toISOString().slice(0, 10).replace(/-/g, "")}`);
    expect(today).toBeTruthy();
  });

  it("ask openFDA by report date, a page at a time, and take its 404 as none", async () => {
    const urls: URL[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.startsWith("/drug/")) return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
      const skip = Number(url.searchParams.get("skip"));
      const page = Array.from({ length: skip === 0 ? 1000 : 3 }, (_, i) => ({ ...CHEDDAR, recall_number: `H-${skip + i}` }));
      return new Response(JSON.stringify({ meta: { results: { total: 1003 } }, results: page }), { status: 200 });
    }) as typeof fetch;
    const fda = new OpenFdaRecalls(fetcher);
    expect(await fda.reportedSince("food", "20251120", "20261120")).toHaveLength(1003);
    expect(urls[0]!.searchParams.get("search")).toBe("report_date:[20251120 TO 20261120]");
    expect(urls.map((u) => u.searchParams.get("skip"))).toEqual(["0", "1000"]);
    expect(await fda.reportedSince("drug", "20251120", "20261120")).toEqual([]);
  });
});
