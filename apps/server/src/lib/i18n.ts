import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { intlLocale, languageOf, translate, plural, type Language, type MessageValues } from "@ferret/shared/i18n";
import { householdLanguage, userLanguage, user, invitation } from "../db/schema";
import type { Db } from "../ports";

/** Async context is isolated per request/job, never a process-global mutable language. */
const context = new AsyncLocalStorage<Language>();
export const currentLanguage = (): Language => context.getStore() ?? "en";
export const locale = () => intlLocale(currentLanguage());
export const withLanguage = <T>(language: Language, fn: () => T): T => context.run(language, fn);
export const t = (source: string, values?: MessageValues) => translate(currentLanguage(), source, values);
export const tn = (count: number, one: string, other: string, values?: MessageValues) => plural(currentLanguage(), count, one, other, values);
export const translator = (language: Language) => (source: string, values?: MessageValues) => translate(language, source, values);

/** A person's explicit preference wins, then the household, then English. */
export async function preferredLanguage(db: Db, userId?: string | null, householdId?: string | null): Promise<Language> {
  if (userId) {
    const [row] = await db.select().from(userLanguage).where(eq(userLanguage.userId, userId));
    if (row) return languageOf(row.language);
  }
  if (householdId) {
    const [row] = await db.select().from(householdLanguage).where(eq(householdLanguage.householdId, householdId));
    if (row) return languageOf(row.language);
  }
  return "en";
}

export async function jobLanguage(db: Db, payload: unknown): Promise<Language> {
  const data = payload as { userId?: string; householdId?: string; email?: string; invitationId?: string; language?: unknown } | null;
  let userId = data?.userId;
  let householdId = data?.householdId;
  let email = data?.email;
  if (data?.invitationId) {
    const [invited] = await db.select({ email: invitation.email, householdId: invitation.organizationId }).from(invitation).where(eq(invitation.id, data.invitationId));
    householdId ??= invited?.householdId;
    email ??= invited?.email;
  }
  if (!userId && email) {
    const [who] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    userId = who?.id;
  }
  if (!userId && !householdId) {
    const { serverAdmin } = await import("./server-admin");
    userId = (await serverAdmin(db))?.id;
  }
  if (userId) {
    const [row] = await db.select().from(userLanguage).where(eq(userLanguage.userId, userId));
    if (row) return languageOf(row.language);
  }
  if (householdId) {
    const [row] = await db.select().from(householdLanguage).where(eq(householdLanguage.householdId, householdId));
    if (row) return languageOf(row.language);
  }
  return data?.language === "hu" || data?.language === "en" ? data.language : "en";
}
