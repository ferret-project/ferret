/**
 * Lingui extractor for the server's text (apps/server/src): its `tr("…")` calls (lib/language.ts), which are plain
 * function calls rather than macros, so Lingui's own extractor doesn't see them. Each first argument — a string, or a
 * template without `${}` — becomes a message with the same id a macro would give it, so the server's strings sit in
 * messages.pot beside the app's and translators see one list.
 */
import { parse } from "@babel/parser";
import type { ExtractorType } from "@lingui/conf";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";

type Node = { type: string; loc?: { start: { line: number; column: number } }; [key: string]: unknown };

function walk(node: unknown, visit: (n: Node) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "comments" || key.endsWith("Comments")) continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}

/** The text of a string literal, or of a template with nothing interpolated; null for anything else. */
function textOf(arg: Node | undefined): string | null {
  if (!arg) return null;
  if (arg.type === "StringLiteral") return arg.value as string;
  if (arg.type === "TemplateLiteral" && (arg.expressions as unknown[]).length === 0) {
    return (arg.quasis as { value: { cooked: string } }[]).map((q) => q.value.cooked).join("");
  }
  return null;
}

export const serverExtractor: ExtractorType = {
  match: (filename) => /[\\/]apps[\\/]server[\\/]src[\\/].*\.ts$/.test(filename),
  extract(filename, code, onMessageExtracted) {
    if (!code.includes("tr(")) return;
    const ast = parse(code, { sourceType: "module", plugins: ["typescript"], errorRecovery: true });
    walk(ast.program, (n) => {
      if (n.type !== "CallExpression") return;
      const callee = n.callee as Node;
      if (callee.type !== "Identifier" || callee.name !== "tr") return;
      const args = n.arguments as Node[];
      const message = textOf(args[0]);
      if (message === null) {
        const at = n.loc?.start;
        throw new Error(`${filename}:${at?.line}: tr() needs the English as a plain string (put values in {placeholders})`);
      }
      onMessageExtracted({ id: generateMessageId(message), message, origin: [filename, n.loc?.start.line ?? 0] });
    });
  },
};
