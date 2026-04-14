import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/** Absolute path to `src/parser.c` from the installed `tree-sitter-python` package. */
export function grammarArtifactPath(): string {
  const pkgRoot = dirname(_require.resolve("tree-sitter-python/package.json"));
  return join(pkgRoot, "src/parser.c");
}

/** SHA-256 of `grammarArtifactPath()` file bytes, lowercase hex. */
export function computePyGrammarDigestFromArtifact(): string {
  const buf = readFileSync(grammarArtifactPath());
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Expected digest for the pinned `tree-sitter-python@0.21.0` lockfile version.
 * Artifact: `src/parser.c`. See `docs/impl/v0-decisions.md` — Python adapter (v2).
 */
export const PY_GRAMMAR_DIGEST =
  "00461a24da2781da9be50b547f1710f9d22c3da102c60f250d8668fd46166191";

let digestGateOk = false;

/**
 * Fail closed if on-disk `src/parser.c` does not match `PY_GRAMMAR_DIGEST`.
 * Idempotent within a process after first success.
 */
export function assertPyGrammarDigestPinned(): void {
  if (digestGateOk) {
    return;
  }
  const computed = computePyGrammarDigestFromArtifact();
  if (computed !== PY_GRAMMAR_DIGEST) {
    throw new Error(
      `[gate:runtime_grammar_artifact] On-disk tree-sitter-python parser.c does not match PY_GRAMMAR_DIGEST: ` +
        `expected ${PY_GRAMMAR_DIGEST}, computed ${computed} from ${grammarArtifactPath()}. ` +
        "Re-hash src/parser.c, update PY_GRAMMAR_DIGEST, record the bump in docs/impl/v0-decisions.md.",
    );
  }
  digestGateOk = true;
}
