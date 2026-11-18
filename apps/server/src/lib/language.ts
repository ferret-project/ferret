/**
 * The language Ferret writes to each person in — emails, push, notifications — and the server's own translations.
 *
 * Each account has a language (`account_setting`, set from the app's language picker; null = English). The server's
 * text is English in the code, written as `tr("Hi {name},", { name })`: plain calls, not Lingui's macros (the server is
 * bundled four different ways), with named placeholders and ICU plurals. apps/web's Lingui config extracts them into
 * the same source list as the app's (messages.pot → the community's translations on Weblate), and
 * `translations.mjs prepare` writes the server's part of each language as `catalogs` (Deps), keyed by Lingui's message
 * id. A string a language hasn't translated yet is English.
 */
import { type I18n, setupI18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import { eq } from "drizzle-orm";
import { accountSetting, user } from "../db/schema";
import type { Db } from "../ports";
import { inList } from "./sql";

/** Each language's translations of the server's text, compiled, by Lingui message id. */
export type Catalogs = Record<string, Record<string, unknown>>;

/** A language code the app could offer: en, pl, pt-BR, zh-Hans… */
export const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface Tr {
  /** The English text in this language, its {placeholders} filled in. */
  (english: string, values?: Record<string, unknown>): string;
  /** The language actually used ("en" when there's no translation of it). */
  locale: string;
  /** A day ("2026-12-02") or a moment, written out in this language: "December 2" / "2 grudnia". */
  date(when: string | Date, options?: Intl.DateTimeFormatOptions & { timeZone?: string }): string;
}

const ids = new Map<string, string>();
const idOf = (english: string): string => {
  const known = ids.get(english);
  if (known) return known;
  const id = generateMessageId(english);
  ids.set(english, id);
  return id;
};

const instances = new WeakMap<Catalogs, Map<string, I18n>>();
const NONE: Catalogs = {};

function i18nFor(catalogs: Catalogs, locale: string) {
  let byLocale = instances.get(catalogs);
  if (!byLocale) instances.set(catalogs, (byLocale = new Map()));
  let i18n = byLocale.get(locale);
  if (!i18n) {
    i18n = setupI18n();
    // English (and anything not translated yet) arrives as plain text: compile it as it's used.
    i18n.setMessagesCompiler(compileMessage);
    i18n.loadAndActivate({ locale, messages: (catalogs[locale] ?? {}) as never });
    byLocale.set(locale, i18n);
  }
  return i18n;
}

/** Text in `language`, if the server has it; else English. */
export function translator(catalogs: Catalogs | undefined, language: string | null | undefined): Tr {
  const all = catalogs ?? NONE;
  const locale = language && language !== "en" && all[language] ? language : "en";
  const i18n = i18nFor(all, locale);
  const tr = ((english: string, values?: Record<string, unknown>) => i18n._({ id: idOf(english), message: english, values })) as Tr;
  tr.locale = locale;
  tr.date = (when, options = { month: "long", day: "numeric" }) => {
    // A bare day is that day wherever you are: read and written in UTC so it can't slip to the day before.
    const day = typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when);
    const d = typeof when === "string" ? new Date(day ? `${when}T00:00:00Z` : when) : when;
    return d.toLocaleDateString(locale, day ? { ...options, timeZone: "UTC" } : options);
  };
  return tr;
}

/** A person's language (null: they haven't chosen; English). */
export async function languageOf(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.select({ language: accountSetting.language }).from(accountSetting).where(eq(accountSetting.userId, userId));
  return row?.language ?? null;
}

/** The language of whoever has this email address (English if nobody does). */
export async function languageOfEmail(db: Db, email: string): Promise<string | null> {
  const [row] = await db
    .select({ language: accountSetting.language })
    .from(user)
    .innerJoin(accountSetting, eq(accountSetting.userId, user.id))
    .where(eq(user.email, email.toLowerCase()));
  return row?.language ?? null;
}

/** Several people's languages at once (by user id). */
export async function languagesOf(db: Db, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await db.select().from(accountSetting).where(inList(accountSetting.userId, [...new Set(userIds)]));
  return new Map(rows.flatMap((r) => (r.language ? [[r.userId, r.language] as const] : [])));
}

/** Text for one person, in their language. */
export async function trFor(deps: { db: Db; catalogs?: Catalogs }, userId: string | null | undefined): Promise<Tr> {
  return translator(deps.catalogs, userId ? await languageOf(deps.db, userId) : null);
}

export async function setLanguage(db: Db, userId: string, language: string | null) {
  await db
    .insert(accountSetting)
    .values({ userId, language })
    .onConflictDoUpdate({ target: accountSetting.userId, set: { language, updatedAt: new Date() } });
}
