import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import tsLang from "tree-sitter-typescript/bindings/node/typescript.js";
import { assertGrammarDigestPinned } from "./grammar_meta.js";

/**
 * Returns a new Tree-sitter parser configured for **plain TypeScript** (`.ts`).
 * TSX uses a different generated `parser.c` in the same npm package; v0 stays on
 * the `typescript` grammar only (see `docs/impl/v0-decisions.md`).
 */
export function createTypeScriptParser(): Parser {
  assertGrammarDigestPinned();
  const parser = new Parser();
  parser.setLanguage(tsLang);
  return parser;
}

export function parseTypeScriptSource(source: string): Tree {
  return createTypeScriptParser().parse(source);
}
