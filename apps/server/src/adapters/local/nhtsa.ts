/**
 * NHTSA's public vehicle data — no key, plain fetch to fixed addresses (so it runs on Workers as on Node):
 * vPIC decodes a VIN (only the VIN is sent), the recalls API lists campaigns for a make, model and year (only those).
 */
import type { RawVehicleRecall, RawVinDecode, VehicleData } from "../../ports";

const HEADERS = { Accept: "application/json", "User-Agent": "Ferret home inventory (vehicle look-up)" };

async function getJson(url: string, what: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`NHTSA ${what}: HTTP ${res.status}`);
  return res.json();
}

const text = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "Not Applicable" ? v.trim() : null);
const num = (v: unknown) => {
  const n = Number(text(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** "27/06/2019" (day first, as NHTSA writes it) → "2019-06-27". */
export function nhtsaDate(raw: unknown) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(raw ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export class NhtsaVehicles implements VehicleData {
  async decodeVin(vin: string): Promise<RawVinDecode | null> {
    const body = (await getJson(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, "VIN decode")) as {
      Results?: Record<string, unknown>[];
    };
    const r = body.Results?.[0];
    if (!r) throw new Error("NHTSA VIN decode: unexpected answer");
    const make = text(r.Make);
    // Without a make and model it didn't decode (an unknown or mistyped VIN): nothing to suggest.
    if (!make || !text(r.Model)) return null;
    return {
      make,
      model: text(r.Model),
      year: num(r.ModelYear),
      trim: text(r.Trim) ?? text(r.Series),
      body: text(r.BodyClass),
      displacementL: num(r.DisplacementL),
      cylinders: num(r.EngineCylinders),
      fuel: text(r.FuelTypePrimary),
      drive: text(r.DriveType),
    };
  }

  async recalls(make: string, model: string, year: number): Promise<RawVehicleRecall[]> {
    const q = new URLSearchParams({ make, model, modelYear: String(year) });
    const body = (await getJson(`https://api.nhtsa.gov/recalls/recallsByVehicle?${q}`, "recalls")) as { results?: Record<string, unknown>[] };
    if (!Array.isArray(body.results)) throw new Error("NHTSA recalls: unexpected answer");
    return body.results.flatMap((r) => {
      const campaign = text(r.NHTSACampaignNumber);
      const reportedOn = nhtsaDate(r.ReportReceivedDate);
      if (!campaign || !reportedOn) return [];
      return [
        {
          campaign,
          reportedOn,
          manufacturer: text(r.Manufacturer),
          component: text(r.Component),
          summary: text(r.Summary),
          consequence: text(r.Consequence),
          remedy: text(r.Remedy),
          notes: text(r.Notes),
        },
      ];
    });
  }
}
