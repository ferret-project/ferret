/** Shared to Ferret (the web manifest's share_target) when the app's service worker didn't answer it: into the app. */
import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

describe("POST /share-target", () => {
  it("opens the app's share screen with the link and words", async () => {
    const { app } = await setup();
    const form = new FormData();
    form.set("title", "DeWalt 20V drill");
    form.set("text", "Look at this");
    form.set("url", "https://shop.example/dcd771");
    form.set("files", new File([new Uint8Array(10)], "photo.jpg", { type: "image/jpeg" }));
    const res = await app.request("/share-target", { method: "POST", body: form });
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!, "http://x");
    expect(to.pathname).toBe("/");
    const q = new URLSearchParams(to.hash.split("?")[1]);
    expect(to.hash.startsWith("#/share?")).toBe(true);
    expect(Object.fromEntries(q)).toEqual({ url: "https://shop.example/dcd771", title: "DeWalt 20V drill", text: "Look at this" });
  });

  it("sends a share too big to read here to the screen that says so", async () => {
    const { app } = await setup();
    const form = new FormData();
    form.set("files", new File([new Uint8Array(2 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" }));
    const res = await app.request("/share-target", { method: "POST", body: form });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/#/share?failed=1");
  });

  it("opens the empty share screen for an empty share", async () => {
    const { app } = await setup();
    const res = await app.request("/share-target", { method: "POST", body: new FormData() });
    expect(res.headers.get("location")).toBe("/#/share");
  });
});
