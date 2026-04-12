import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Resolved at runtime from the installed `tree-sitter-typescript` package (pnpm
 * lockfile pins the version). Artifact: **only** `typescript/src/parser.c` (v0
 * uses the TypeScript grammar; TSX is a separate `parser.c` in this package).
 */
export function grammarArtifactPath(): string {
  const pkgRoot = dirname(require.resolve("tree-sitter-typescript/package.json"));
  return join(pkgRoot, "typescript/src/parser.c");
}

/** SHA-256 of `grammarArtifactPath()` file bytes, lowercase hex (no `sha256:` prefix). */
export function computeGrammarDigestFromArtifact(): string {
  const buf = readFileSync(grammarArtifactPath());
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Expected digest for the pinned `tree-sitter-typescript` lockfile version.
 * Bump only when the grammar artifact bytes change (see `docs/impl/v0-decisions.md`).
 */
export const GRAMMAR_DIGEST_V0 =
  "74fe453edd70f4eae9af0a1050cbd7943d8971d59165b6aaebbaa0a0b716d1aa";

let digestGateOk = false;

/**
 * Fail closed if on-disk `parser.c` does not match `GRAMMAR_DIGEST_V0`.
 * Idempotent within a process after first success.
 */
export function assertGrammarDigestPinned(): void {
  if (digestGateOk) {
    return;
  }
  const computed = computeGrammarDigestFromArtifact();
  if (computed !== GRAMMAR_DIGEST_V0) {
    throw new Error(
      `grammar_digest mismatch: expected ${GRAMMAR_DIGEST_V0}, computed ${computed} from ${grammarArtifactPath()}. ` +
        "Re-hash `typescript/src/parser.c`, update GRAMMAR_DIGEST_V0, and record the bump in docs/impl/v0-decisions.md.",
    );
  }
  digestGateOk = true;
}
