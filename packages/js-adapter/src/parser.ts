import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import { createRequire } from "node:module";

import { assertJsGrammarDigestPinned } from "./grammar.js";

const _require = createRequire(import.meta.url);

/**
 * Returns a new Tree-sitter parser configured for **plain JavaScript** (`.js` / `.mjs` / `.cjs`).
 * `.jsx` is out of scope for v1 (see `docs/impl/v0-decisions.md`).
 */
export function createJavaScriptParser(): Parser {
  assertJsGrammarDigestPinned();
  // tree-sitter-javascript exposes CJS `bindings/node/index.js` via package "main".
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const jsLang = _require("tree-sitter-javascript") as object;
  const parser = new Parser();
  parser.setLanguage(jsLang);
  return parser;
}

export function parseJavaScriptSource(source: string): Tree {
  return createJavaScriptParser().parse(source);
}
