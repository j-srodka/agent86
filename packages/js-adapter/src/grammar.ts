// MAINTENANCE: When tree-sitter-javascript version changes in pnpm-lock.yaml, recompute
// JS_GRAMMAR_DIGEST from the pinned parser artifact (src/parser.c in the installed
// package) and update this constant. See docs/impl/v0-decisions.md — JavaScript adapter (js-adapter, v1).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/** Absolute path to `src/parser.c` from the installed `tree-sitter-javascript` package. */
export function grammarArtifactPath(): string {
  const pkgRoot = dirname(_require.resolve("tree-sitter-javascript/package.json"));
  return join(pkgRoot, "src/parser.c");
}

/** SHA-256 of `grammarArtifactPath()` file bytes, lowercase hex. */
export function computeJsGrammarDigestFromArtifact(): string {
  const buf = readFileSync(grammarArtifactPath());
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Expected digest for the pinned `tree-sitter-javascript@0.23.1` lockfile version.
 * Artifact: `src/parser.c`. See `docs/impl/v0-decisions.md` — JavaScript adapter (js-adapter, v1).
 */
export const JS_GRAMMAR_DIGEST =
  "1150721590eca3c7b6623c7dc3498184f3e22c5d895a08b4806ebf5804f817c3";

let digestGateOk = false;

/**
 * Fail closed if on-disk `src/parser.c` does not match `JS_GRAMMAR_DIGEST`.
 * Idempotent within a process after first success.
 */
export function assertJsGrammarDigestPinned(): void {
  if (digestGateOk) {
    return;
  }
  const computed = computeJsGrammarDigestFromArtifact();
  if (computed !== JS_GRAMMAR_DIGEST) {
    throw new Error(
      `[gate:runtime_grammar_artifact] On-disk tree-sitter-javascript parser.c does not match JS_GRAMMAR_DIGEST: ` +
        `expected ${JS_GRAMMAR_DIGEST}, computed ${computed} from ${grammarArtifactPath()}. ` +
        "Re-hash src/parser.c, update JS_GRAMMAR_DIGEST, record the bump in docs/impl/v0-decisions.md.",
    );
  }
  digestGateOk = true;
}
