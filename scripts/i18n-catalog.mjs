import fs from "node:fs";
import ts from "typescript-ast";
import { sourceFiles } from "./lib/i18n-source.mjs";

const sources = new Map();
const add = (text, file) => { if (text) { if (!sources.has(text)) sources.set(text, []); sources.get(text).push(file); } };
const dynamic = {
  "apps/server/src/auth.ts": ["INVITE_ONLY", "NO_EMAIL"],
  "apps/server/src/lib/templates.ts": ["STARTER_TEMPLATES", "grades"],
  "apps/web/src/Demo.tsx": ["FEATURES", "PARTS"],
  "apps/web/src/PayOff.tsx": ["DAYS"],
  "apps/web/src/Providers.tsx": ["TRADES"],
  "apps/server/src/lib/digest.ts": ["DAYS", "GROUPS"],
  "apps/server/src/lib/inventory.ts": ["TEXT_FIELDS"],
};
for (const file of [...sourceFiles("apps/web/src"), ...sourceFiles("apps/server/src"), ...sourceFiles("packages/shared/src")]) {
  if (/\/db\/|\/adapters\/|\/demo\//.test(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isCallExpression(node) && ["t", "translateText", "tr"].includes(node.expression.getText(ast)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text, file);
    if (ts.isCallExpression(node) && ["tn", "trn"].includes(node.expression.getText(ast))) for (const argument of [node.arguments[1], node.arguments[2]]) if (argument && ts.isStringLiteral(argument)) add(argument.text, file);
    if (ts.isVariableDeclaration(node) && dynamic[file]?.includes(node.name.getText(ast))) {
      function collect(child) {
        if (ts.isStringLiteral(child)) {
          const first = ts.isArrayLiteralExpression(child.parent) && child.parent.elements.indexOf(child) === 0;
          const tuples = ["FEATURES", "PARTS", "TEXT_FIELDS"].includes(node.name.getText(ast));
          if (!(tuples && first) && !/^[A-Z0-9]{2,}$/.test(child.text) && (tuples || /^[A-Z]|^\d+″/.test(child.text))) add(child.text, file);
        }
        ts.forEachChild(child, collect);
      }
      collect(node.initializer);
    }
    if (file.endsWith("/labels.ts") && ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) add(node.initializer.text, file);
    if (file === "packages/shared/src/index.ts" || file.startsWith("apps/server/src/")) {
      if (ts.isPropertyAssignment(node) && ["message", "error"].includes(node.name.getText(ast)) && ts.isStringLiteral(node.initializer)) add(node.initializer.text, file);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "refine" && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) add(node.arguments[1].text, file);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const auth = JSON.parse(fs.readFileSync("packages/shared/src/locales/auth-messages.json", "utf8"));
for (const source of Object.keys(auth)) add(source, "better-auth@1.7.14");
const en = Object.fromEntries([...sources.keys()].sort().map((source) => [source, source]));
if (process.argv.includes("--update")) {
  fs.writeFileSync("packages/shared/src/locales/en.json", JSON.stringify(en, null, 2) + "\n");
  console.log(`Extracted ${sources.size} source messages (including ${Object.keys(auth).length} Better Auth messages).`);
} else {
  const current = JSON.parse(fs.readFileSync("packages/shared/src/locales/en.json", "utf8"));
  const missing = Object.keys(en).filter((key) => !Object.hasOwn(current, key));
  const stale = Object.keys(current).filter((key) => !Object.hasOwn(en, key));
  if (missing.length || stale.length) { console.error({ missing, stale }); process.exitCode = 1; }
  else console.log(`Catalog source coverage: ${sources.size} messages, no missing or stale keys.`);
}
