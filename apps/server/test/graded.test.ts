/** Graded coins and cards (lib/graded.ts): PCGS and PSA certificates, with the price guide's value as a thing's value. */
import type { GradedInfo, GradingStatus, ItemGradedInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { PcgsGrading, toGraded as pcgsGraded } from "../src/adapters/local/pcgs";
import { PsaGrading, toGraded as psaGraded } from "../src/adapters/local/psa";
import type { Grading } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const QUARTER: GradedInfo = { by: "pcgs", cert: "12345678", name: "1916 STANDING 25C Type 1, FH", year: 1916, grade: "MS65FH", population: 45, popHigher: 12, priceCents: 160000, url: "https://www.pcgs.com/coinfacts/coin/detail/5703/65" };

class FakeGrading implements Grading {
  asked: string[] = [];
  async check(key: string) {
    return key === "good-grading-key";
  }
  async byCert(_key: string, cert: string) {
    this.asked.push(cert);
    return cert === "12345678" ? QUARTER : null;
  }
}

describe("graded coins and cards", () => {
  it("look up a certificate with the service's key, and value a graded thing by the price guide", async () => {
    const pcgs = new FakeGrading();
    const { user } = await setup({ grading: { pcgs, psa: new FakeGrading() } });
    const ann = await user("ann");
    expect((await ann.as("/api/v1/graded/pcgs/12345678")).status).toBe(409);
    expect((await send(ann, "PUT", "/api/v1/server/graded/pcgs", { key: "wrong-key" })).status).toBe(422);
    expect((await json<{ data: GradingStatus[] }>(send(ann, "PUT", "/api/v1/server/graded/pcgs", { key: "good-grading-key" }))).data).toEqual([
      { by: "pcgs", available: true, hint: "…-key" },
      { by: "psa", available: true, hint: null },
    ]);
    expect((await json<{ features: { graded: string[] } }>(ann.as("/api/v1/me"))).features.graded).toEqual(["pcgs"]);
    expect(await json(ann.as("/api/v1/graded/pcgs/12345678"))).toMatchObject({ name: QUARTER.name, grade: "MS65FH" });
    expect((await ann.as("/api/v1/graded/pcgs/99999999")).status).toBe(404);
    expect((await ann.as("/api/v1/graded/psa/12345678")).status).toBe(409); // no PSA key
    const coin = await ann.addItem({ name: "Standing Liberty quarter", graded: { by: "pcgs", cert: "12345678" } });
    expect(await json<ItemGradedInfo>(ann.as(`/api/v1/items/${coin.id}/graded`))).toMatchObject({ graded: { by: "pcgs", cert: "12345678" }, info: { grade: "MS65FH" }, price: { cents: 160000, currency: "USD" } });
    // Kept a week: the page asked nothing more.
    expect(pcgs.asked.filter((c) => c === "12345678")).toHaveLength(1);
    const mug = await ann.addItem({ name: "Mug" });
    expect(await json(ann.as(`/api/v1/items/${mug.id}/graded`))).toEqual({ graded: null, info: null, price: null });
    expect((await send(ann, "POST", "/api/v1/items", { name: "Bad", graded: { by: "cgc", cert: "1" } })).status).toBe(422);
  });

  it("turn PCGS's and PSA's answers into what's shown, and send the token as a Bearer", async () => {
    expect(pcgsGraded("40000001", { Name: "STANDING 25C Type 1, FH", Year: 1916, MintMark: "D", Grade: "MS65FH", PriceGuideValue: 1600, Population: 45, PopHigher: 12, CoinFactsLink: "www.pcgs.com/coinfacts/coin/detail/5703/65" })).toMatchObject({
      name: "1916-D STANDING 25C Type 1, FH",
      priceCents: 160000,
      url: "https://www.pcgs.com/coinfacts/coin/detail/5703/65",
    });
    expect(pcgsGraded("1", { IsValidRequest: true, ServerMessage: "No data found" })).toBeNull();
    expect(psaGraded("49392223", { CertNumber: "49392223", Year: "2016", Brand: "Pokemon XY Evolutions", Subject: "Charizard-Holo", CardNumber: "11", CardGrade: "GEM MT 10", TotalPopulation: 1500, PopulationHigher: 0 })).toMatchObject({
      name: "2016 Pokemon XY Evolutions Charizard-Holo #11",
      grade: "GEM MT 10",
      url: "https://www.psacard.com/cert/49392223",
    });
    const seen: { url: string; auth: string | null }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ Message: "Access to this API is limited to approved customers." }), { status: 403 });
    }) as typeof fetch;
    expect(await new PsaGrading(fetcher).check("tok")).toBe(false);
    expect(seen[0]!.auth).toBe("bearer tok");
    expect(await new PcgsGrading(fetcher).check("tok")).toBe(false);
  });
});
