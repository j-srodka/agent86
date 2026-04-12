# v0 implementation decisions

Implementation-time choices for the Agent IR v0 reference stack (per [implementation plan](../superpowers/plans/2026-04-12-agent-ir-v0-implementation.md)). The product spec remains locked; this file is the normative log for repo-specific behavior.

## Grammar digest (v0, normative for this repo)

**Artifact (single choice, no “or” in code):** `grammar_digest` is the **SHA-256** (lowercase hex) of the file  
`tree-sitter-typescript/typescript/src/parser.c`  
as installed from the **pnpm-lockfile-pinned** npm package `tree-sitter-typescript` (currently **0.23.2**). The checked-in constant is **`GRAMMAR_DIGEST_V0`** in `packages/ts-adapter/src/grammar_meta.ts`.

**Scope:** v0 uses the **TypeScript** grammar only (`.ts`). The sibling **`tsx/src/parser.c`** is a different artifact and is **not** hashed for this digest. TSX support is out of scope until explicitly added (would require a separate constant or versioning strategy).

**Runtime:** The adapter loads `tree-sitter` **0.21.1** (peer-compatible) and `tree-sitter-typescript/bindings/node/typescript.js`. The digest gate compares **parser source bytes**, not the npm version string alone.

**CI / fail closed:** `assertGrammarDigestPinned()` (or equivalent) MUST run before apply; computed hash MUST equal `GRAMMAR_DIGEST_V0` or the batch fails.

**Bump policy — triggers (normative for when to re-hash and update the constant):**

1. **Lockfile package version change:** The pinned `tree-sitter-typescript` version in `pnpm-lock.yaml` (or equivalent) changes — re-hash the chosen artifact, update the in-repo digest constant, record a changelog entry, and treat as **breaking** for snapshot compatibility with prior digests.
2. **Artifact path or format change:** The implementation switches which file is hashed (e.g. WASM vs `parser.c`) or the package layout delivers a different on-disk artifact for the same semver — re-hash, update constant, same breaking snapshot semantics as (1).
3. **Intentional grammar bump without npm churn:** Rare case where the npm version is unchanged but the vendored or resolved artifact was replaced (e.g. manual pin fix) — re-hash and update if the file bytes differ.

## Canonical bytes and line endings

*TBD (Task 3).*

## Tier I unit ids and `rename_symbol` / `id_resolve` delta

*TBD (Tasks 3 and 6).*

## Manifest discovery (spec section 16)

*TBD (Task 10).*

## Pinned OSS monorepo for A/B harness

*TBD (Task 9).*

## Op JSON shape (v0 subset: `replace_unit`, `rename_symbol`)

*TBD (Tasks 5–6 as shapes stabilize).*
