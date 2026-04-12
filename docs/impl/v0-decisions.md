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
4. **Local path overrides:** Any `pnpm`/npm **link**, **`overrides`**, or **`file:`** resolution that changes which `tree-sitter-typescript` tree is installed — **re-run the digest check** (recompute hash from the resolved on-disk `parser.c`, update `GRAMMAR_DIGEST_V0` if bytes differ, same breaking snapshot semantics).

## Canonical bytes and line endings

Snapshot materialization hashes file contents **after normalizing line endings to LF** (`\n`): convert `\r\n` and standalone `\r` to `\n` before SHA-256. Paths are compared using POSIX-style relative paths sorted lexicographically for deterministic ordering.

## TSX and non-`.ts` sources

**`.tsx` files are never parsed with the v0 TypeScript grammar** (that would be silently wrong). The snapshot step **does not** include them in `files[]` or `units[]`. Instead, every materialization **discovers** every `.tsx` file under the root (recursive; excluding `node_modules`) and records each path in **`WorkspaceSnapshot.skipped_tsx_paths`** (repo-relative, sorted) so the omission is **explicit on the wire**, not an invisible gap. Parsing a `.tsx` path through the `.ts` parser is forbidden.

## Tier I unit ids and `rename_symbol` / `id_resolve` delta

Opaque unit **`id`** (v0): SHA-256 (hex) over a stable UTF-8 string: grammar digest, resolved snapshot root, POSIX relative file path, `startIndex`, `endIndex` (Tree-sitter byte offsets in **canonical LF** source), and node kind (`function_declaration` | `method_definition`). Initial **`id_resolve`** is the identity map on unit ids.

## Apply path — grammar digest gate (Task 7)

The apply entry point MUST call **`assertGrammarDigestPinned()`** at the **start of each apply attempt** (in addition to any parser initialization). Do not rely solely on “first parser load already checked” — re-check so digest drift or replaced installs fail closed at apply time.

## Pinned OSS monorepo for A/B harness (Task 9)

Before writing **`ab-harness/.pinned-rev`**, inspect the candidate repo’s **lockfile / dependencies** for **tree-sitter** (or **web-tree-sitter**) versions that **transitively conflict** with this adapter’s **`tree-sitter@0.21.1`** (e.g. a different major that would force duplicate native builds or resolution surprises). Prefer a pin where the harness install story is compatible or document the conflict and mitigation.

## Manifest discovery (spec section 16)

*TBD (Task 10).*

## Op JSON shape (v0 subset: `replace_unit`, `rename_symbol`)

*TBD (Tasks 5–6 as shapes stabilize).*
