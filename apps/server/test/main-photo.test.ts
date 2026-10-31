/** An item's main photo: its picture in lists and first on its page — chosen, or a crop uploaded with main=true. */
import { describe, expect, it } from "vitest";
import { photo, setup } from "./helpers";

describe("main photo", () => {
  it("is the first photo until another is chosen; a crop uploaded as main takes over, the original kept", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const lamp = await ann.addItem({ name: "Lamp" });
    const first = await ann.upload(lamp.id, await photo(), "shelf.jpg");
    const second = await ann.upload(lamp.id, await photo(), "close.jpg");
    const listed = async () => ((await (await ann.as("/api/v1/items")).json()) as { data: { id: string; photoId: string | null }[] }).data.find((i) => i.id === lamp.id)!.photoId;
    expect(await listed()).toBe(first.id);

    const chose = await ann.as(`/api/v1/attachments/${second.id}/main`, { method: "POST" });
    expect(chose.status).toBe(200);
    expect(await listed()).toBe(second.id);
    expect((await ann.attachments(lamp.id)).map((a) => a.filename)).toEqual(["close.jpg", "shelf.jpg"]);

    // A crop of the shelf photo, as the photo editor sends it.
    const form = new FormData();
    form.set("file", new File([await photo()], "shelf (cropped).jpg"));
    form.set("kind", "photo");
    form.set("analyze", "false");
    form.set("main", "true");
    const up = await ann.as(`/api/v1/items/${lamp.id}/attachments`, { method: "POST", body: form });
    expect(up.status).toBe(201);
    const crop = (await up.json()) as { id: string; analysisStatus: string | null };
    expect(await listed()).toBe(crop.id);
    expect((await ann.attachments(lamp.id)).map((a) => a.filename)).toEqual(["shelf (cropped).jpg", "close.jpg", "shelf.jpg"]);

    const history = (await (await ann.as(`/api/v1/items/${lamp.id}/history`)).json()) as { data: { summary: string }[] };
    expect(history.data.map((h) => h.summary)).toContain("Made close.jpg the main photo of Lamp");
  });

  it("only for a photo of this household, and not for viewers", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const bob = await user("bob");
    const lamp = await ann.addItem({ name: "Lamp" });
    const pic = await ann.upload(lamp.id, await photo(), "lamp.jpg");
    expect((await bob.as(`/api/v1/attachments/${pic.id}/main`, { method: "POST" })).status).toBe(404);
  });
});
