/** Each person's language (lib/language.ts): saved with the account, and what Ferret sends them is in it. */
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import { today } from "@ferret/shared";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sendWeeklyDigests } from "../src/lib/digest";
import { type Catalogs, translator } from "../src/lib/language";
import { config, FakeNotifier, setup } from "./helpers";

/** A catalog as translations.mjs prepare writes it: compiled, by message id. */
const catalog = (pairs: Record<string, string>) => Object.fromEntries(Object.entries(pairs).map(([en, tr]) => [generateMessageId(en), compileMessage(tr)]));

const POLISH: Catalogs = {
  pl: catalog({
    "Hi {name},": "Cześć {name},",
    "Your week in Ferret": "Twój tydzień w Ferret",
    "Your week in Ferret: {count, plural, one {# thing} other {# things}} to look at": "Twój tydzień w Ferret: {count, plural, one {# rzecz} few {# rzeczy} many {# rzeczy} other {# rzeczy}} do sprawdzenia",
    "Lent out": "Pożyczone",
    "Open Ferret": "Otwórz Ferret",
    "Or copy this link: {link}": "Albo skopiuj ten link: {link}",
    "Buy {thing}": "Kup: {thing}",
    "Running low: {list}": "Kończy się: {list}",
  }),
};

describe("translator", () => {
  it("fills placeholders and plurals in the language, and falls back to English", () => {
    const tr = translator(POLISH, "pl");
    expect(tr.locale).toBe("pl");
    expect(tr("Hi {name},", { name: "Ania" })).toBe("Cześć Ania,");
    expect(tr("Your week in Ferret: {count, plural, one {# thing} other {# things}} to look at", { count: 3 })).toBe("Twój tydzień w Ferret: 3 rzeczy do sprawdzenia");
    expect(tr("Not translated yet, {name}", { name: "Ania" })).toBe("Not translated yet, Ania");
    expect(tr.date("2026-12-02")).toBe("2 grudnia");
  });

  it("is English for English, for nobody's choice, and for a language the server hasn't got", () => {
    for (const language of ["en", null, "fr"]) {
      const tr = translator(POLISH, language);
      expect(tr.locale).toBe("en");
      expect(tr("Hi {name},", { name: "Ann" })).toBe("Hi Ann,");
      expect(tr("Your week in Ferret: {count, plural, one {# thing} other {# things}} to look at", { count: 1 })).toBe("Your week in Ferret: 1 thing to look at");
      expect(tr.date("2026-12-02")).toBe("December 2");
    }
  });
});

describe("your language", () => {
  it("is saved with the account from a real sign-in, and /me says which", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    const me = async () => ((await (await ann.as("/api/v1/me")).json()) as { language: string | null }).language;
    expect(await me()).toBeNull();
    const put = (language: unknown) => ann.as("/api/v1/me/language", { method: "PUT", body: JSON.stringify({ language }) });
    expect((await put("pl")).status).toBe(200);
    expect(await me()).toBe("pl");
    expect((await put("en")).status).toBe(200); // English is the same as none
    expect(await me()).toBeNull();
    expect((await put("<script>")).status).toBe(422);
    expect((await put("pt-BR")).status).toBe(200);
    expect(await me()).toBe("pt-BR");
  });

  it("writes the weekly summary email in it", async () => {
    const notifier = new FakeNotifier();
    const MAIL = "mailtos://ferret:pw@mail.example.com";
    const { deps, files, user } = await setup({ notifier, mailUrl: MAIL, catalogs: POLISH });
    const ann = await user("ann");
    const now = new Date();
    await ann.as("/api/v1/me/language", { method: "PUT", body: JSON.stringify({ language: "pl" }) });
    await ann.as("/api/v1/me/weekly", { method: "PUT", body: JSON.stringify({ day: now.getDay(), email: true }) });
    const ladder = await ann.addItem({ name: "Ladder" });
    await ann.as(`/api/v1/items/${ladder.id}/loans`, { method: "POST", body: JSON.stringify({ direction: "lent", person: "Sam" }) });
    await sendWeeklyDigests({ ...deps, files, appUrl: config.PUBLIC_URL, mailUrl: MAIL, now, on: today(now) } as Parameters<typeof sendWeeklyDigests>[0]);
    const mail = notifier.sent.find((m) => m.url.startsWith(MAIL))!;
    expect(mail.title).toBe("Twój tydzień w Ferret");
    expect(mail.html).toContain('<html lang="pl">');
    expect(mail.html).toContain(">Pożyczone</h2>");
    expect(mail.html).toContain(">Otwórz Ferret</a>");
    expect(mail.html).toContain("Albo skopiuj ten link:");
    // Not translated yet: English, not a gap.
    expect(mail.body).toContain("You get this summary once a week.");
  });
});

describe("the bell", () => {
  it("is in your language in the app, and English for your API key", async () => {
    const { app, user } = await setup({ catalogs: POLISH });
    const ann = await user("ann");
    await ann.as("/api/v1/me/language", { method: "PUT", body: JSON.stringify({ language: "pl" }) });
    const soap = await ann.addItem({ name: "Soap" });
    await ann.as(`/api/v1/items/${soap.id}`, { method: "PATCH", body: JSON.stringify({ quantity: 1, minQuantity: 2 }) });
    type Entries = { data: { kind: string; title: string; detail: string }[] };
    const shopping = (r: Entries) => r.data.find((a) => a.kind === "shopping")!;
    const inApp = (await (await ann.as("/api/v1/attention")).json()) as Entries;
    expect(shopping(inApp)).toMatchObject({ title: "Kup: Soap", detail: "Kończy się: Soap" });
    const { key } = (await (await ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "script" }) })).json()) as { key: string };
    const byKey = (await (await app.request("/api/v1/attention", { headers: { Authorization: `Bearer ${key}` } })).json()) as Entries;
    expect(shopping(byKey)).toMatchObject({ title: "Buy Soap", detail: "Running low: Soap" });
  });
});

describe("the server's text", () => {
  it("is always plain English in tr(), so it can be found and translated", () => {
    const src = path.join(import.meta.dirname, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const wrong: string[] = [];
    for (const f of files) {
      const code = readFileSync(path.join(src, f), "utf8");
      // tr( followed by anything but a string, or a template that interpolates.
      for (const m of code.matchAll(/\btr\(\s*([^"'`\s)]|`[^`]*\$\{)/g)) wrong.push(`${f}: ${code.slice(m.index, m.index + 60).split("\n")[0]}`);
    }
    expect(wrong).toEqual([]);
  });
});
