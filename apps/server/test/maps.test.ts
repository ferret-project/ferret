/** Map pictures of properties (Apple Maps Web Snapshots), fetched by the server. */
import type { PlacesTree } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { AppleMapSnapshots } from "../src/adapters/local/apple-maps";
import { FakeMaps, setup } from "./helpers";

describe("property maps", () => {
  it("show a picture of the address, only for this household's properties with one, and only when switched on", async () => {
    const maps = new FakeMaps();
    const { user } = await setup({ maps });
    const ann = await user("ann");
    const bob = await user("bob");
    const home = (await (
      await ann.as("/api/v1/properties", {
        method: "POST",
        body: JSON.stringify({ name: "Home", street: "1 Apple Park Way", city: "Cupertino", region: "CA", postalCode: "95014", country: "USA" }),
      })
    ).json()) as { id: string };
    const cabin = (await (await ann.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Cabin" }) })).json()) as { id: string };

    expect(((await (await ann.as("/api/v1/locations/tree")).json()) as PlacesTree).maps).toBe(true);
    const map = await ann.as(`/api/v1/properties/${home.id}/map?scheme=dark`);
    expect([map.status, map.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(maps.asked).toEqual([{ address: "1 Apple Park Way, Cupertino, CA 95014, USA", scheme: "dark" }]);

    expect((await ann.as(`/api/v1/properties/${cabin.id}/map`)).status).toBe(404); // no address
    expect((await bob.as(`/api/v1/properties/${home.id}/map`)).status).toBe(404); // not bob's
    expect(maps.asked).toHaveLength(1);
  });

  it("are off without a Maps key", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const home = (await (await ann.as("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Home", city: "Denver" }) })).json()) as { id: string };
    expect(((await (await ann.as("/api/v1/locations/tree")).json()) as PlacesTree).maps).toBe(false);
    expect((await ann.as(`/api/v1/properties/${home.id}/map`)).status).toBe(404);
  });
});

describe("Apple Maps snapshot URLs", () => {
  it("are signed as Apple asks: ES256 over the path and every parameter, base64url, signature last", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\\n${btoa(String.fromCharCode(...pkcs8))}\\n-----END PRIVATE KEY-----`; // as in .env
    const signed = await new AppleMapSnapshots("TEAM123", "KEY456", pem).signedPath("1 Main St, Denver, CO", "light");

    const [path, signature] = signed.split("&signature=") as [string, string];
    expect(path).toMatch(/^\/api\/v1\/snapshot\?center=1%20Main%20St%2C%20Denver%2C%20CO&/);
    expect(path).toContain("&colorScheme=light&");
    expect(path).toContain(`&annotations=${encodeURIComponent('[{"point":"center","color":"8b4a2d","markerStyle":"balloon"}]')}&`);
    expect(path.endsWith("&teamId=TEAM123&keyId=KEY456")).toBe(true);
    expect(signature).toMatch(/^[\w-]{86}$/); // 64 raw bytes (r‖s), base64url without padding
    const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, new TextEncoder().encode(path))).toBe(true);
  });
});
