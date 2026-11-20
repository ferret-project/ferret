import type { PromptSetting } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { imagePrompt } from "../src/jobs/analyze";
import { roomScanPrompt } from "../src/lib/room-scans";
import { FakeAi, photo, setup } from "./helpers";

const reply = { description: "A Nintendo DS game case.", text: "Kirby Mouse Attack\nNintendo DS", name: "Kirby: Mouse Attack", brand: "Nintendo", model: null, serialNumber: null, barcode: null, purchaseDate: null, purchasePrice: null };

describe("AI prompts", () => {
  it("ask for a titled thing's title and its publisher (GitHub issue #8)", () => {
    const photoPrompt = imagePrompt("photo", "USD");
    expect(photoPrompt).toContain('its title as printed, like "Kirby: Mouse Attack"');
    expect(photoPrompt).toContain("for a book, game or film its publisher, not the platform");
    expect(photoPrompt).toContain("or its title is printed in full");
    expect(roomScanPrompt([])).toContain("a book's, game's or film's title if clearly readable");
  });

  it("the server admin adds instructions to a built-in prompt, and resets them", async () => {
    const ai = new FakeAi([reply, reply]);
    const { jobs, user } = await setup({ ai });
    const ann = await user("ann"); // the first account: the server admin
    const { id: itemId } = await ann.addItem({ name: "New item" });

    const list = async () => ((await (await ann.as("/api/v1/server/prompts")).json()) as { data: PromptSetting[] }).data;
    const before = await list();
    expect(before.map((p) => p.kind)).toEqual(["photo", "document", "describe", "roomScan", "ask"]);
    expect(before.every((p) => p.extra === null && p.builtIn.length > 100)).toBe(true);
    expect(before.find((p) => p.kind === "photo")!.builtIn).toContain("{the household's currency}");

    const put = (kind: string, extra: string | null) => ann.as(`/api/v1/server/prompts/${kind}`, { method: "PUT", body: JSON.stringify({ extra }) });
    expect((await put("photo", "  For video games, the brand is the publisher.  ")).status).toBe(200);
    expect((await list()).find((p) => p.kind === "photo")!.extra).toBe("For video games, the brand is the publisher.");

    await ann.upload(itemId, await photo(), "kirby.jpg");
    await jobs.drain();
    const prompt = ai.calls.at(-1)!.prompt;
    expect(prompt.startsWith(imagePrompt("photo", "USD"))).toBe(true); // Ferret's own prompt stays whole
    expect(prompt.endsWith("For video games, the brand is the publisher.")).toBe(true);

    // The server check notes it.
    const check = (await (await ann.as("/api/v1/server/check", { method: "POST" })).json()) as { findings: { kind: string; examples: string[] }[] };
    expect(check.findings.find((f) => f.kind === "prompts.changed")).toMatchObject({ examples: ["photo"] });

    // Reset: the built-in prompt as it is again.
    expect((await put("photo", null)).status).toBe(200);
    expect((await list()).every((p) => p.extra === null)).toBe(true);
    await ann.upload(itemId, await photo(), "kirby-2.jpg");
    await jobs.drain();
    expect(ai.calls.at(-1)!.prompt).toBe(imagePrompt("photo", "USD"));

    expect((await put("judge", "anything")).status).toBe(404); // the search judge isn't offered
    expect((await put("ask", "x".repeat(2001))).status).toBe(422);
    const bob = await user("bob");
    expect((await bob.as("/api/v1/server/prompts")).status).toBe(403);
    expect((await bob.as("/api/v1/server/prompts/photo", { method: "PUT", body: JSON.stringify({ extra: "hi" }) })).status).toBe(403);
  });
});
