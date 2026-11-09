import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyAttributes, inspectSource } from "../../../scripts/lib/i18n-source.mjs";

test("discovers literal, conditional and interpolated display props, not technical or user data", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "ferret-i18n-"));
  const file = path.join(dir, "fixture.tsx");
  try {
    fs.writeFileSync(file, '<Form noneLabel={"No room"} submit={editing ? "Save now" : "Add now"} title={user.name} value="Stable protocol" name="Stable name" />; <Picker noneLabel={`${property.name} (a room)`} />; <Form submit={translateText("Already translated")} />;');
    const copy = inspectSource(file).entries.filter((entry) => entry.actionable).map((entry) => entry.text);
    assert.deepEqual(copy, ["No room", "Save now", "Add now", "{v0} (a room)"]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("audit allows display prop translations while still rejecting technical props", () => {
  const audit = fs.readFileSync(new URL("../../../scripts/i18n-audit.mjs", import.meta.url), "utf8");
  assert.ok(copyAttributes.has("noneLabel"));
  assert.ok(copyAttributes.has("submit"));
  assert.match(audit, /copyAttributes.has/);
  assert.match(audit, /translation in a technical identifier/);
});
