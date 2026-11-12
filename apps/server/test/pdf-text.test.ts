/** What docling missed, from the PDF's own text: whole pages, and a part-number table under a heading it kept. */
import { describe, expect, it } from "vitest";
import { missedPages, withMissedPages } from "../src/lib/pdf-text";
import { FakeDocuments, pdf, setup } from "./helpers";

const docling = `# JCDC-3 Cyclone Dust Collector

## 8.2 Cleaning and bag inspection

Clean canister filter frequently to keep the collector's performance at its optimum. Empty or replace canister and drum collection bags when full.

## 9.0 Optional accessories

## 10.0 Troubleshooting

Motor will not start. Check connections at plug or circuit panel. Install safety key.`;

const pages = [
  "JCDC-3 Cyclone Dust Collector\n8.2 Cleaning and bag inspection\nClean canister filter frequently to keep the collector's performance at its optimum.\nEmpty or replace canister and drum collection bags when full.",
  "9.0 Optional accessories\nPart no. Description\n717511 Canister collection bag for JCDC (package of 5)\n717531 Drum collection bag for JCDC-3 (package of 5)\n10.0 Troubleshooting\nMotor will not start. Check connections at plug or circuit panel.\nInstall safety key.",
  "11.1.2 Parts List\nIndex No Part No Description Size Qty\n35 .............. 717531 ...................... Drum Collection Bag for JCDC-3 (pkg. of 5) ...... 1\n63 .............. JCDC3-63 ................. Canister Filter ........ 1\n64 .............. JCDC1.5-59 .............. Foam Tape ........ 1\n65 .............. JCDC1.5-60 .............. Clamp ........ 1",
  "", // a scanned page: no text
];

describe("pages docling missed", () => {
  it("adds a page it mostly lacks, whole, and lines with part numbers it lacks from a page it read", () => {
    expect(missedPages(docling, pages)).toEqual([
      [2, "717511 Canister collection bag for JCDC (package of 5)\n717531 Drum collection bag for JCDC-3 (package of 5)"],
      [3, pages[2]],
    ]);
    const merged = withMissedPages(docling, pages)!;
    expect(merged.startsWith(docling)).toBe(true);
    expect(merged).toContain("## Page 3\n\n11.1.2 Parts List");
    expect(merged).toContain("63 … JCDC3-63 … Canister Filter … 1"); // dot leaders tidied
    expect(withMissedPages(docling, [pages[0]!])).toBe(docling); // nothing missed: unchanged
  });

  it("is the PDF's own text when there's no docling, and nothing for a scan", () => {
    expect(withMissedPages(undefined, pages)).toMatch(/^## Page 1\n\nJCDC-3[\s\S]*## Page 3/);
    expect(withMissedPages(undefined, ["", ""])).toBeUndefined();
  });

  it("stores docling's reading with what it missed, so searching the item finds the part number", async () => {
    const pdfPages = { firstPage: async () => null, pageTexts: async () => pages };
    const { user, jobs } = await setup({ documents: new FakeDocuments([docling]), pdfPages });
    const pat = await user("pat");
    const { id } = await pat.addItem({ name: "Dust collector" });
    await pat.upload(id, pdf(), "manual.pdf", "document");
    await jobs.drain();
    const [a] = await pat.attachments(id);
    expect((a!.analysis as { text: string }).text).toContain("## Page 2\n\n717511 Canister collection bag");
    const found = (await (await pat.as(`/api/v1/items/${id}/find?q=717531`)).json()) as { passages: { heading?: string }[] };
    expect(found.passages.map((p) => p.heading)).toEqual(expect.arrayContaining(["Page 2", "Page 3"]));
  });
});
