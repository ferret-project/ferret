/** Decoding HomeKit and Matter pairing codes (packages/shared/src/pairing.ts), against known codes. */
import { isPairingPayload, parsePairing } from "@ferret/shared/utils";
import { describe, expect, it } from "vitest";

describe("pairing codes", () => {
  it("decodes HomeKit QR codes", () => {
    expect(parsePairing("X-HM://00U90Q99FMI2D")).toEqual({
      kind: "homekit",
      payload: "X-HM://00U90Q99FMI2D",
      code: "822-04-003",
      category: "Shower system",
      details: { setupId: "MI2D", categoryNumber: 30, flags: 10, version: 0 },
    });
    expect(parsePairing("x-hm://005keouce7fba")).toMatchObject({ code: "383-13-374", category: "Lightbulb", payload: "X-HM://005KEOUCE7FBA" });
  });

  it("decodes Matter QR codes (the Matter SDK's test code)", () => {
    expect(parsePairing("MT:Y.K9042C00KA0648G00")).toEqual({
      kind: "matter",
      payload: "MT:Y.K9042C00KA0648G00",
      code: "3497-011-2332",
      category: null,
      details: { vendorId: 0xfff1, productId: 0x8000, discriminator: 3840, commissioningFlow: 0 },
    });
  });

  it("takes typed codes, and checks Matter's check digit", () => {
    expect(parsePairing("822 04 003")).toMatchObject({ kind: "homekit", code: "822-04-003", payload: null });
    expect(parsePairing("3497-011-2332")).toMatchObject({ kind: "matter", code: "3497-011-2332", payload: null });
    expect(parsePairing("3497-011-2333")).toBeNull(); // wrong check digit
    expect(parsePairing("4006381333931")).toBeNull(); // a barcode
    expect(parsePairing("X-HM://nope")).toBeNull();
    expect(parsePairing("MT:!!!")).toBeNull();
  });

  it("knows a pairing QR from anything else", () => {
    expect(isPairingPayload("X-HM://00U90Q99FMI2D")).toBe(true);
    expect(isPairingPayload(" mt:Y.K9042C00KA0648G00")).toBe(true);
    expect(isPairingPayload("https://ferret.lan/l/K7QM2X")).toBe(false);
    expect(isPairingPayload("036000291452")).toBe(false);
  });
});
