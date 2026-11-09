import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const load = (name) => JSON.parse(readFileSync(new URL(`../src/locales/${name}.json`, import.meta.url), "utf8"));
const en = load("en");
const hu = load("hu");
const unchanged = new Set(load("unchanged"));
const placeholders = (text) => [...text.matchAll(/\{\w+\}/g)].map(([token]) => token).sort();

test("English and Hungarian have identical non-empty source key sets", () => {
  assert.deepEqual(Object.keys(hu).sort(), Object.keys(en).sort());
  assert.ok(Object.keys(en).length > 0);
  for (const [key, value] of Object.entries(en)) assert.equal(key, value, `English is the source fallback: ${key}`);
});

test("every translation preserves the complete placeholder multiset", () => {
  for (const [key, value] of Object.entries(hu)) assert.deepEqual(placeholders(value), placeholders(key), key);
});

test("translations contain no unreviewed English, blank messages or hidden direction controls", () => {
  for (const [key, value] of Object.entries(hu)) {
    assert.equal(typeof value, "string", key);
    // Legacy English plural suffix: Hungarian uses a singular noun after a number.
    assert.ok(value.length > 0 || key === "s", `Blank translation: ${key}`);
    assert.ok(key !== value || unchanged.has(key), `Untranslated source: ${key}`);
    assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(value), `Invisible control: ${key}`);
    assert.ok(!/&(?:amp|quot|rsquo|lsquo|nbsp);/.test(value), `Escaped JSX entity in text: ${key}`);
  }
  for (const key of unchanged) assert.equal(hu[key], key, `Stale untranslated allowlist entry: ${key}`);
});

test("high-risk authentication wording distinguishes passwords, passkeys and recovery codes", () => {
  assert.equal(hu.Password, "Jelszó");
  assert.equal(hu.Passkey, "Hozzáférési kulcs");
  assert.equal(hu["Backup code"], "Helyreállító kód");
  assert.match(hu["Your password alone will sign you in again. Your backup codes stop working."], /érvénytelenné/);
  assert.match(hu["FILES_KEY is only in this server's data folder: lose that, and every photo, document and backup is lost too. Make a key file — Settings → Server → Keys."], /FILES_KEY/);
});
