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

**Future skip categories:** If a **second** skip reason besides TSX appears, **migrate** `skipped_tsx_paths` to a single wire field **`skipped_paths: Array<{ path: string; reason: string }>`** (sorted by `path`, then `reason`) instead of adding parallel string arrays per category.

## Tier I unit ids and `rename_symbol` / `id_resolve` delta

Opaque unit **`id`** (v0): SHA-256 (hex) over a stable UTF-8 string: grammar digest, resolved snapshot root, POSIX relative file path, `startIndex`, `endIndex` (Tree-sitter byte offsets in **canonical LF** source), and node kind (`function_declaration` | `method_definition`). Initial **`id_resolve`** is the identity map on unit ids.

## Apply path — §9 gates (Task 7)

On each **`applyBatch`** attempt, in order **before** reading files or expanding ops:

1. **`assertGrammarDigestPinned()`** — on-disk grammar artifact matches **`GRAMMAR_DIGEST_V0`**; else **`grammar_mismatch`**.
2. **`snapshot.grammar_digest === GRAMMAR_DIGEST_V0`** — snapshot header matches applying grammar; else **`grammar_mismatch`**.
3. **`snapshot.adapter`** must match the applying adapter fingerprint (**`V0_ADAPTER_FINGERPRINT`** in `snapshot.ts`); else **`adapter_version_unsupported`**.
4. **`ops.length <= snapshot.adapter.max_batch_ops`**; else **`batch_size_exceeded`** (no mutation, no backup).

Also call **`assertGrammarDigestPinned()`** from parser construction paths as today; do not rely on a prior call alone.

## Apply batch atomicity (v0)

**Process-lifetime only:** `applyBatch` backs up canonical file text in memory, restores on failure, and is **best-effort atomic** for the **current Node process**. There is **no** crash-safe journal, WAL, or post-crash recovery in v0 — a kill mid-batch can leave the workspace partially mutated.

## `replace_unit` caller sharp edge (`export`)

If **`new_text`** includes a leading **`export`** while the logical unit span starts at **`function`** (common for `export function …`), the splice can yield **`export export function`** and a **`parse_error`**. v0 does **not** validate `new_text` shape beyond parse — **callers** must supply text consistent with the unit byte range (see op JSON notes below). A regression test documents the failure mode in **`packages/ts-adapter/src/apply.test.ts`**.

## Pinned OSS monorepo for A/B harness (Task 9)

Before writing **`ab-harness/.pinned-rev`**, inspect the candidate repo’s **lockfile / dependencies** for **tree-sitter** (or **web-tree-sitter**) versions that **transitively conflict** with this adapter’s **`tree-sitter@0.21.1`** (e.g. a different major that would force duplicate native builds or resolution surprises). Prefer a pin where the harness install story is compatible or document the conflict and mitigation.

When **`packages/ab-harness/README.md`** documents baseline-vs-IR scenarios, **link** the **scoped rename / homonym** story to the passing adapter test **`packages/ts-adapter/src/apply.test.ts`** (`rename_symbol` keeps string literals intact while renaming identifiers) so the A/B narrative stays traceable to code.

## Read path — `WorkspaceSummary` vs `AdapterFingerprint` (v0)

**`max_batch_ops` duplication:** On `WorkspaceSummary`, **`max_batch_ops`** repeats the same value as **`AdapterFingerprint.max_batch_ops`** on the snapshot/report. That duplication is **intentional for v0** so agents read the batch limit on the cheap read path (spec section 6) without unpacking the full fingerprint. If **`AdapterFingerprint`** grows with more capability fields that also belong on the read path, **prefer** exposing the **full `AdapterFingerprint` struct** on `WorkspaceSummary` (or a shared `adapter_capabilities` object) instead of duplicating additional fields one-by-one.

## Conformance goldens (Task 8)

**Edit-shift id golden (plan Step 4):** MUST **apply a real edit** (e.g. **`replace_unit`** on the lower stacked unit in a multi-unit file), then **re-materialize** the snapshot. Assert: edited unit’s id **changes**; unit **above** the edit **unchanged**; unit **below** (if any) **changed** — per `units.ts` header. **Do not** substitute a **second identical materialization** of the same unchanged sources as the edit-shift test; that only proves determinism, not Tier I id semantics after mutation.

**Sign-off gate (Step 4):** Task 8 is **not** complete until the Vitest **`it.todo`** for **implementation-plan Task 8 Step 4** (`packages/conformance/src/golden.test.ts`, edit-shift describe block) is **replaced by a real test** that performs **`replace_unit`** then re-snapshot. A remaining **`todo`** in that block **blocks** Task 8 sign-off (CI should treat conformance todos as incomplete work for Task 8).

## Manifest discovery (spec section 16)

*TBD (Task 10) — wire resolution, default paths, etc.*

**`manifest_url` format (normative when Task 10 lands):** Whatever string is placed in **`WorkspaceSummary.manifest_url`** MUST be **usable to fetch or open the manifest without additional implicit repo-root context** — e.g. an absolute **`file:`** URL, a fully qualified HTTPS URL, or another locator an agent can resolve **standalone**. Do not emit a bare relative path that only makes sense combined with an undocumented CWD or “assume repo root” rule unless that combination is also specified in the same summary or a linked normative field.

## Op JSON shape (v0 subset: `replace_unit`, `rename_symbol`)

- **`replace_unit`:** `{ "op": "replace_unit", "target_id": string, "new_text": string }` — replaces the **entire** logical unit span `[start_byte, end_byte)` (canonical LF source) with `new_text`, then re-parses and re-snapshots. For `export function …`, the Tree-sitter **`function_declaration`** range usually starts at the `function` keyword (the `export ` prefix sits outside that node); **`new_text`** must splice valid source for that span (often `function name() { … }` without duplicating `export`).
- **`rename_symbol`:** `{ "op": "rename_symbol", "target_id": string, "new_name": string }` — v0 **function_declaration only**, **same file**; walks the declaration subtree and renames `identifier` nodes matching the declared name (name-independent unit **ids**; **`id_resolve_delta`** empty on success).

## `rename_symbol` scope (v0)

**Same-file, `function_declaration` only** (no `method_definition`, no cross-file). Identifiers matching the old name **inside** that declaration subtree are rewritten (declaration name, calls, nested identifiers with that spelling). **`id_resolve`** does not encode symbol names — renames do **not** emit `id_resolve_delta` entries in v0.
