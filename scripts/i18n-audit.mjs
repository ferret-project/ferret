import fs from "node:fs";
import ts from "typescript-ast";
import { copyAttributes, inspectSource, sourceFiles } from "./lib/i18n-source.mjs";

const manifest = JSON.parse(fs.readFileSync("contrib/i18n/exclusions.json", "utf8"));
const keyOf = (entry) => `${entry.file}\0${entry.source}`;
const approved = new Map(manifest.map((entry) => [keyOf(entry), entry.reason]));
const inventory = [];
const placementProblems = [];
for (const file of [...sourceFiles("apps/web/src"), ...sourceFiles("apps/server/src")].sort()) {
  // Deliberate scope boundaries: application code, not developer interfaces, adapters, schemas or demo-owned data.
  if (/\/i18n\.|\/db\/|\/adapters\/|\/mcp|\/cli|\/ports\.ts|\/openapi\.ts|\/config\.ts|\/demo\/|\/server\.ts|\/migrate\.ts/.test(file)) continue;
  const inspected = inspectSource(file);
  function checkPlacement(node) {
    if (ts.isCallExpression(node) && ["t", "translateText", "tr", "tn", "trn"].includes(node.expression.getText(inspected.ast))) {
      let invalid = false;
      let insideElement = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isJsxElement(parent)) insideElement = true;
        if (ts.isJsxAttribute(parent)) {
          if (!insideElement && !copyAttributes.has(parent.name.getText(inspected.ast))) invalid = true;
          break;
        }
        if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) invalid = true;
        if (ts.isTaggedTemplateExpression(parent) && parent.tag.getText(inspected.ast).startsWith("sql")) invalid = true;
        if (ts.isNewExpression(parent) && parent.expression.getText(inspected.ast) === "Date") invalid = true;
        if (ts.isPropertyAssignment(parent) && ["Content-Type", "Cache-Control", "id", "code", "key", "slug", "path", "field", "sure"].includes(parent.name.getText(inspected.ast).replaceAll('"', ""))) invalid = true;
        if (ts.isGetAccessorDeclaration(parent) && ["id", "key", "type", "slug", "field", "sure"].includes(parent.name.getText(inspected.ast))) invalid = true;
        if (ts.isFunctionLike(parent)) break;
      }
      if (invalid) placementProblems.push(`${file}:${inspected.ast.getLineAndCharacterOfPosition(node.getStart(inspected.ast)).line + 1}: translation in a technical identifier/format context`);
    }
    ts.forEachChild(node, checkPlacement);
  }
  checkPlacement(inspected.ast);
  for (const entry of inspected.entries) {
    inventory.push({ file, line: entry.line, source: entry.text, reason: approved.get(keyOf({ file, source: entry.text })) ?? null });
  }
}
const unreviewed = inventory.filter((entry) => !entry.reason);
const used = new Set(inventory.map(keyOf));
const stale = manifest.filter((entry) => !used.has(keyOf(entry)));
if (process.argv.includes("--json")) console.log(JSON.stringify({ inventory, unreviewed, stale, placementProblems }, null, 2));
else {
  console.log(`Residual-string audit: ${inventory.length} literal occurrences reviewed; ${unreviewed.length} unreviewed, ${stale.length} stale exclusions.`);
  for (const entry of unreviewed) console.error(`${entry.file}:${entry.line}: ${JSON.stringify(entry.source)}`);
  for (const entry of stale) console.error(`Stale exclusion: ${entry.file}: ${JSON.stringify(entry.source)}`);
  for (const problem of placementProblems) console.error(problem);
}
if (unreviewed.length || stale.length || placementProblems.length) process.exitCode = 1;
