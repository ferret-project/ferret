/** Device support (lib/support.ts): when a phone or tablet stops getting updates, from endoflife.date, confirmed per thing. */
import type { AttentionItem, ItemSupportStatus, SupportLookupStatus } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { EndOfLife } from "../src/adapters/local/endoflife";
import type { SupportRelease } from "../src/db/schema";
import { deviceLabel, matchDevice } from "../src/lib/support";
import type { SupportLifecycles } from "../src/ports";
import { setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const rel = (name: string, label: string, eolFrom: string | null, isEol = false): SupportRelease => ({ name, label, releaseDate: null, eolFrom, isEol });

class FakeSupport implements SupportLifecycles {
  lines: Record<string, { label: string; releases: SupportRelease[] }> = {
    pixel: { label: "Google Pixel", releases: [rel("6", "Pixel 6", inDays(40)), rel("6pro", "Pixel 6 Pro", inDays(40)), rel("8", "Pixel 8", inDays(2000))] },
    iphone: { label: "Apple iPhone", releases: [rel("15-pro", "15 Pro", null)] },
    "samsung-mobile": { label: "Samsung Mobile", releases: [rel("s23", "Galaxy S23", inDays(-10), true)] },
    kindle: { label: "Amazon Kindle", releases: [rel("kindle-11", "Kindle (11th Generation)", inDays(900))] },
  };
  asked: string[] = [];
  async devices() {
    return Object.entries(this.lines).map(([name, l]) => ({ name, label: l.label }));
  }
  async releases(product: string) {
    this.asked.push(product);
    return this.lines[product] ?? null;
  }
}

async function supportOn() {
  const support = new FakeSupport();
  const s = await setup({ support });
  const ann = await s.user("ann");
  expect(await json<SupportLookupStatus>(send(ann, "PUT", "/api/v1/server/support", { enabled: true }))).toMatchObject({ available: true, enabled: true });
  await s.jobs.drain();
  return { ...s, ann, support };
}

const bell = async (u: User) => (await json<{ data: AttentionItem[] }>(u.as("/api/v1/attention"))).data.filter((a) => a.kind === "support");

describe("device support", () => {
  it("is off until the server admin switches it on", async () => {
    const s = await setup({ support: new FakeSupport() });
    const ann = await s.user("ann");
    const phone = await ann.addItem({ name: "Pixel 6 Pro", brand: "Google" });
    expect(await json(ann.as(`/api/v1/items/${phone.id}/support`))).toEqual({ status: "off" });
  });

  it("suggests the model a thing is, tracks it once confirmed, and warns before updates stop", async () => {
    const { ann } = await supportOn();
    expect(await json(ann.as("/api/v1/server/support"))).toMatchObject({ devices: 6, tracked: 0 });
    const phone = await ann.addItem({ name: "Pixel 6 Pro", brand: "Google" });
    const offered = await json<ItemSupportStatus>(ann.as(`/api/v1/items/${phone.id}/support`));
    expect(offered).toMatchObject({ status: "suggested", support: { product: "pixel", release: "6pro", label: "Pixel 6 Pro", ended: false } });
    expect(await bell(ann)).toEqual([]); // not until it's confirmed

    const tracked = await json<ItemSupportStatus>(send(ann, "PUT", `/api/v1/items/${phone.id}/support`, { product: "pixel", release: "6pro" }));
    expect(tracked).toMatchObject({ status: "tracked", support: { label: "Pixel 6 Pro", eolFrom: inDays(40) } });
    expect(await bell(ann)).toEqual([expect.objectContaining({ itemId: phone.id, title: "Pixel 6 Pro stops getting security updates", severity: "soon" })]);

    // Stopped tracking: not offered again, and the bell forgets it.
    expect(await json(send(ann, "DELETE", `/api/v1/items/${phone.id}/support`))).toEqual({ status: "none" });
    expect(await bell(ann)).toEqual([]);
  });

  it("matches models named without their line, and leaves out names too vague to be sure", async () => {
    const { ann } = await supportOn();
    const status = async (thing: { name: string; brand?: string; model?: string }) => json<ItemSupportStatus>(ann.as(`/api/v1/items/${(await ann.addItem(thing)).id}/support`));
    expect(await status({ name: "iPhone 15 Pro", brand: "Apple" })).toMatchObject({ status: "suggested", support: { label: "Apple iPhone 15 Pro" } });
    expect(await status({ name: "Phone", brand: "Samsung", model: "Galaxy S23" })).toMatchObject({ status: "suggested", support: { label: "Samsung Galaxy S23", ended: true } });
    expect(await status({ name: "15 Pro case" })).toEqual({ status: "none" }); // no "iPhone"
    expect(await status({ name: "Kindle" })).toEqual({ status: "none" });
    expect(await status({ name: "Kindle Paperwhite" })).toEqual({ status: "none" });
  });

  it("says when updates have stopped, and follows a date that moves", async () => {
    const { ann, jobs, support, db } = await supportOn();
    const phone = await ann.addItem({ name: "Galaxy S23", brand: "Samsung" });
    await send(ann, "PUT", `/api/v1/items/${phone.id}/support`, { product: "samsung-mobile", release: "s23" });
    expect(await bell(ann)).toEqual([expect.objectContaining({ title: "Galaxy S23 no longer gets security updates" })]);

    // Samsung extends support: tomorrow's refresh moves the date, and the bell lets it go.
    support.lines["samsung-mobile"]!.releases[0] = rel("s23", "Galaxy S23", inDays(400));
    const { supportProduct } = await import("../src/db/schema");
    await db.update(supportProduct).set({ fetchedAt: new Date(0) });
    await jobs.enqueue("support.refresh", {});
    await jobs.drain();
    expect((await json<ItemSupportStatus>(ann.as(`/api/v1/items/${phone.id}/support`))).support).toMatchObject({ eolFrom: inDays(400), ended: false });
    expect(await bell(ann)).toEqual([]);
  });

  it("is a writer's to change", async () => {
    const { ann, user } = await supportOn();
    void user;
    const phone = await ann.addItem({ name: "Pixel 8", brand: "Google" });
    expect((await send(ann, "PUT", `/api/v1/items/${phone.id}/support`, { product: "pixel", release: "nope" })).status).toBe(422);
  });
});

describe("device support helpers", () => {
  it("names a model with its line when the model's name doesn't say it", () => {
    expect(deviceLabel("Google Pixel", "Pixel 6 Pro")).toBe("Pixel 6 Pro");
    expect(deviceLabel("Apple iPhone", "18 Pro")).toBe("Apple iPhone 18 Pro");
    expect(deviceLabel("Samsung Mobile", "Galaxy S26 FE")).toBe("Samsung Galaxy S26 FE");
    expect(deviceLabel("Raspberry Pi", "500")).toBe("Raspberry Pi 500");
  });

  it("tells generations apart by the words in brackets, else takes the newest", () => {
    const kindles = [{ name: "kindle", label: "Amazon Kindle", releases: [{ ...rel("pw10", "Kindle Paperwhite (10th Generation)", null), releaseDate: "2018-11-07" }, { ...rel("pw11", "Kindle Paperwhite (11th Generation)", null), releaseDate: "2021-10-27" }] }];
    expect(matchDevice(kindles, { name: "Kindle Paperwhite" })?.release.name).toBe("pw11");
    expect(matchDevice(kindles, { name: "Kindle Paperwhite", model: "10th generation" })?.release.name).toBe("pw10");
  });

  it("prefers the longest model name", () => {
    const lines = [{ name: "pixel", label: "Google Pixel", releases: [rel("6", "Pixel 6", null), rel("6pro", "Pixel 6 Pro", null)] }];
    expect(matchDevice(lines, { name: "Pixel 6 Pro", brand: "Google" })?.release.name).toBe("6pro");
    expect(matchDevice(lines, { name: "Pixel 6" })?.release.name).toBe("6");
    expect(matchDevice([{ name: "raspberry-pi", label: "Raspberry Pi", releases: [rel("4", "4", null)] }], { name: "Raspberry Pi 4 Model B" })?.release.name).toBe("4");
  });

  it("downloads only the device lines", async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/products")) return Response.json({ result: [{ name: "pixel", label: "Google Pixel", category: "device" }, { name: "python", label: "Python", category: "lang" }] });
      return Response.json({ result: { label: "Google Pixel", releases: [{ name: "6", label: "Pixel 6", releaseDate: "2021-10-28", isEol: false, eolFrom: "2026-10-01" }] } });
    }) as typeof fetch;
    const eol = new EndOfLife(fetcher);
    expect(await eol.devices()).toEqual([{ name: "pixel", label: "Google Pixel" }]);
    expect(await eol.releases("pixel")).toEqual({ label: "Google Pixel", releases: [{ name: "6", label: "Pixel 6", releaseDate: "2021-10-28", eolFrom: "2026-10-01", isEol: false }] });
  });
});
