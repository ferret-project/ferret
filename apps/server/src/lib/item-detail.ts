/** One thing as its own page shows it (GET /items/:id): the listing plus who added it, labels, lifespan, links and videos. */
import { eq } from "drizzle-orm";
import { user } from "../db/schema";
import { type Caller, asListing, getItem } from "./inventory";
import { ownLabelsOf } from "./own-labels";
import { itemLifespan } from "./lifespans";
import { replacementsOf } from "./repairs";
import { repairGuideFor } from "./repair-guides";
import { homeAssistantLink } from "./home-assistant";
import { itemVideosOf } from "./videos";

export async function itemDetail(v: Caller, id: string) {
  const found = await getItem(v, id);
  const [listed] = await asListing(v, [found]);
  const [by] = found.createdBy ? await v.db.select({ name: user.name }).from(user).where(eq(user.id, found.createdBy)) : [];
  return {
    ...listed!,
    addedBy: by?.name ?? null,
    ownLabels: await ownLabelsOf(v, found.id),
    lifespan: await itemLifespan(v, found),
    homeAssistantUrl: await homeAssistantLink(v, found),
    repairGuide: await repairGuideFor(v, found),
    videos: (await itemVideosOf(v, [found.id])).get(found.id) ?? [],
    ...(await replacementsOf(v, found)),
  };
}
