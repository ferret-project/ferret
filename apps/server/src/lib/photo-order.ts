import { asc, desc } from "drizzle-orm";
import { attachment } from "../db/schema";

/**
 * The order an item's photos are shown in, and which is its picture (the first): the one last chosen as the main photo
 * (`mainAt`, lib/attachments.ts setMainPhoto — SQLite puts nulls last when descending), then as they were added. Every
 * "first photo" uses it.
 */
export const PHOTO_ORDER = [desc(attachment.mainAt), asc(attachment.createdAt)] as const;
