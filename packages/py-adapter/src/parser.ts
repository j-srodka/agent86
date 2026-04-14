import Parser from "tree-sitter";
import type { Tree } from "tree-sitter";
import { createRequire } from "node:module";
import { assertPyGrammarDigestPinned } from "./grammar.js";

const _require = createRequire(import.meta.url);

/**
 * Returns a new Tree-sitter parser configured for Python.
 * `tree-sitter-python@0.21.0` exposes its language via `bindings/node/index.js` (CJS).
 */
export function createPythonParser(): Parser {
  assertPyGrammarDigestPinned();
  // tree-sitter-python@0.21.0 uses CJS; `require` is the correct interop path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const pyLang = _require("tree-sitter-python") as object;
  const parser = new Parser();
  parser.setLanguage(pyLang);
  return parser;
}

export function parsePythonSource(source: string): Tree {
  return createPythonParser().parse(source);
}
