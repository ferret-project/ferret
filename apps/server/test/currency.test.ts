import { currencyForLocale, currencyDigits, formatMoney, moneyNumber, parseMoney } from "@ferret/shared";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

describe("money", () => {
  it("is written in the currency's own way and the reader's", () => {
    expect(formatMoney(129_99, "USD", { locale: "en-US" })).toBe("$129.99");
    expect(formatMoney(123_456_78, "USD", { locale: "en-US" })).toBe("$123,457"); // totals: whole units from 1,000
    expect(formatMoney(8000, "USD", { exact: true, locale: "en-US" })).toBe("$80.00");
    expect(formatMoney(123_456, "EUR", { exact: true, locale: "de-DE" })).toBe("1.234,56 €");
    expect(formatMoney(1500_00, "JPY", { exact: true, locale: "en-US" })).toBe("¥1,500"); // no decimals in yen
    expect(currencyForLocale("de-AT")).toBe("EUR");
    expect(currencyForLocale("en-GB")).toBe("GBP");
    expect(currencyForLocale("en")).toBe("USD");
  });

  it("shows whole forints without changing stored or exported precision", () => {
    expect(formatMoney(129_00, "HUF", { exact: true, locale: "hu-HU" })).toBe("129 Ft");
    expect(formatMoney(129_49, "HUF", { locale: "hu-HU" })).toBe("129 Ft");
    expect(formatMoney(129_50, "HUF", { exact: true, locale: "hu-HU" })).toBe("130 Ft");
    expect(formatMoney(-129_50, "HUF", { exact: true, locale: "hu-HU" })).toBe("-130 Ft");
    const nativeDigits = new Intl.NumberFormat("en", { style: "currency", currency: "HUF" }).resolvedOptions().maximumFractionDigits!;
    expect(currencyDigits("HUF")).toBe(nativeDigits);
    expect(moneyNumber(129_50, "HUF")).toBe((129_50 / 100).toFixed(nativeDigits));
    expect(parseMoney("129,50")).toBe(129_50);
    expect(formatMoney(129_50, "USD", { exact: true, locale: "en-US" })).toBe("$129.50");
  });

  it("also hides HUF decimals when an older runtime reports two currency digits", () => {
    const nativeOptions = Intl.NumberFormat.prototype.resolvedOptions;
    const spy = vi.spyOn(Intl.NumberFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.NumberFormat) {
      const options = nativeOptions.call(this);
      return options.currency === "HUF" ? { ...options, minimumFractionDigits: 2, maximumFractionDigits: 2 } : options;
    });
    try {
      expect(formatMoney(129_00, "HUF", { exact: true, locale: "hu" })).toBe("129 Ft");
    } finally {
      spy.mockRestore();
    }
  });

  it("is read from what people and spreadsheets write", () => {
    expect(parseMoney("$1,234.56")).toBe(123_456);
    expect(parseMoney("1.234,56 €")).toBe(123_456);
    expect(parseMoney("1 234,56")).toBe(123_456);
    expect(parseMoney("CHF 1'234.50")).toBe(123_450);
    expect(parseMoney("12,5")).toBe(1250);
    expect(parseMoney("1.234.567")).toBe(123_456_700);
    expect(parseMoney("1,234")).toBe(123_400);
    // Three digits after one mark: the reader's own decimal point decides.
    expect(parseMoney("1.234", ",")).toBe(123_400);
    expect(parseMoney("1,234", ",")).toBe(123);
    expect(parseMoney("nothing")).toBeNull();
  });
});

describe("a household's currency", () => {
  it("is dollars until the owner or an admin chooses another; only what's sent changes", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await json(ann.as("/api/v1/household/settings"))).toMatchObject({ currency: "USD", timeZone: null });
    await send(ann, "PUT", "/api/v1/household/settings", { timeZone: "Europe/Berlin" });
    expect(await json(send(ann, "PUT", "/api/v1/household/settings", { currency: "eur" }))).toMatchObject({ currency: "EUR", timeZone: "Europe/Berlin" });
    expect((await send(ann, "PUT", "/api/v1/household/settings", { currency: "XYZ" })).status).toBe(422);
    expect(await json(ann.as("/api/v1/household/settings"))).toMatchObject({ currency: "EUR" });
  });

  it("writes the server's own words, the spreadsheet and the dashboard summary in it", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    await send(ann, "PUT", "/api/v1/household/settings", { currency: "EUR" });
    const drill = await json<{ id: string }>(send(ann, "POST", "/api/v1/items", { name: "Drill", valueCents: 8000 }));
    await send(ann, "PATCH", `/api/v1/items/${drill.id}`, { valueCents: 9550 });

    const history = await json<{ data: { summary: string }[] }>(ann.as(`/api/v1/items/${drill.id}/history`));
    expect(history.data.map((h) => h.summary).join("\n")).toContain("value €80.00 → €95.50");

    const csv = await (await ann.as("/api/v1/export/items.csv")).text();
    const [head, row] = csv.replace("﻿", "").split("\r\n");
    const cols = head!.split(",");
    const cells = row!.split(",");
    expect(cells[cols.indexOf("Value (each)")]).toBe("95.50");
    expect(cells[cols.indexOf("Currency")]).toBe("EUR");

    expect(await json(ann.as("/api/v1/summary"))).toMatchObject({ valueCents: 9550, currency: "EUR" });
  });
});
