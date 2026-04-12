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

## Blob externalization (v1)

**Date (normative for this repo):** 2026-04-12

**Default:** `inline_threshold_bytes = 8192` (UTF-8). Passed as an optional argument to **`materializeSnapshot`**; callers may raise it per request to force inlining of larger unit spans.

**Cache location:** Under the **snapshot workspace root** (the same absolute directory passed to **`materializeSnapshot({ rootPath })`** and **`applyBatch({ snapshotRootPath })`**):  
**`<snapshotRoot>/.cache/blobs/`**  
(`join(snapshotRoot, ".cache", "blobs")`, resolved to absolute paths in APIs). This directory is created on demand when at least one logical unit is externalized. It is listed in **`WorkspaceSummary.blob_cache_path`** so agents know where local **`sha256:`** payloads are stored.

**Ref and file naming (normative):**

- Wire **`blob_ref`** strings are **`sha256:`** followed by **64 lowercase hexadecimal** digits (the SHA-256 digest of the unit’s UTF-8 bytes, same bytes as the logical span in canonical LF source).
- On disk, each blob is a single file whose name is the **64-character lowercase hex digest** (no `sha256:` prefix, no extension): **`<blob_cache_path>/<64-hex>`**. File contents are UTF-8 text bytes identical to the logical unit span in canonical LF source.

**Eviction / GC:** **None in v1.** The cache **grows** with materialization; no automatic deletion. Documented limitation until a later version adds policy.

**Cache miss:** **`fetchBlobText(blobRef, snapshotRootPath)`** throws **`BlobNotFoundError`**. The error **`message`** is machine-oriented and includes the normative prefix **`[blob_unavailable]`** so programmatic filters can key off it without parsing prose. On apply, this maps to **`ValidationReport.entries[]`** with code **`blob_unavailable`** (warning severity when the op can still proceed using on-disk file bytes for splice/parse). **`omitted_due_to_size`** MUST still list externalized refs (reason **`inline_threshold`**); if a fetch fails, the same ref may also appear with reason **`unavailable`** per spec **`OmittedBlob.reason`**.

**Read path honesty:** **`WorkspaceSummary.omitted_due_to_size`** lists every **`sha256:`** payload not inlined in **`LogicalUnit`** records ( **`source_text === null`**, **`blob_ref`/`blob_bytes` set**). Absence of a unit’s text in the snapshot object is never treated as “empty”; omissions are explicit.

**Invariant (LogicalUnit):** **`source_text`** and **`blob_ref`** are never both non-null. Inline mode: **`source_text`** is a string (possibly empty), **`blob_ref`** and **`blob_bytes`** are **`null`**. Externalized mode: **`source_text`** is **`null`**, **`blob_ref`** is a **`sha256:`** string, **`blob_bytes`** is the UTF-8 byte length of that payload.

---

## Canonical bytes and line endings

Snapshot materialization hashes file contents **after normalizing line endings to LF** (`\n`): convert `\r\n` and standalone `\r` to `\n` before SHA-256. Paths are compared using POSIX-style relative paths sorted lexicographically for deterministic ordering.

## TSX and non-`.ts` sources

**`.tsx` files are never parsed with the v0 TypeScript grammar** (that would be silently wrong). The snapshot step **does not** include them in `files[]` or `units[]`. Instead, every materialization **discovers** every `.tsx` file under the root (recursive; excluding `node_modules`) and records each path in **`WorkspaceSnapshot.skipped_tsx_paths`** (repo-relative, sorted) so the omission is **explicit on the wire**, not an invisible gap. Parsing a `.tsx` path through the `.ts` parser is forbidden.

**Future skip categories:** If a **second** skip reason besides TSX appears, **migrate** `skipped_tsx_paths` to a single wire field **`skipped_paths: Array<{ path: string; reason: string }>`** (sorted by `path`, then `reason`) instead of adding parallel string arrays per category.

## Tier I unit ids and `rename_symbol` / `id_resolve` delta

Opaque unit **`id`** (v0): SHA-256 (hex) over a stable UTF-8 string: grammar digest, resolved snapshot root, POSIX relative file path, `startIndex`, `endIndex` (Tree-sitter byte offsets in **canonical LF** source), and node kind (`function_declaration` | `method_definition`). Initial **`id_resolve`** is the identity map on unit ids.

**`move_unit` / `relocate_unit` (spec section 4.3):** The locked spec describes these as first-class ops with **`id_resolve_delta`** forward edges. **v0 does not implement them** (deferred to v1+ per implementation plan). **`id_resolve`** is always the **identity** map at materialization. For the two implemented ops (**`replace_unit`**, **`rename_symbol`**), **`id_resolve_delta`** on success is always **empty** (`{}`) — no non-identity remaps.

## Apply path — §9 gates (Task 7)

On each **`applyBatch`** attempt, in order **before** reading files or expanding ops:

1. **`assertGrammarDigestPinned()`** — on-disk grammar artifact matches **`GRAMMAR_DIGEST_V0`**; else **`grammar_mismatch`** with message prefix **`[gate:runtime_grammar_artifact]`** (runtime / lockfile install vs checked-in constant).
2. **`snapshot.grammar_digest === GRAMMAR_DIGEST_V0`** — snapshot header matches applying grammar; else **`grammar_mismatch`** with prefix **`[gate:snapshot_grammar_digest]`** (stale or foreign snapshot vs current adapter). Operators should distinguish these in telemetry.
3. **`snapshot.adapter`** must match the applying adapter fingerprint (**`V0_ADAPTER_FINGERPRINT`** in `snapshot.ts`); else **`adapter_version_unsupported`**. **`max_batch_ops`** is part of that equality: changing it is a **breaking** adapter version bump for interchange (same as name/semver drift), not an independent knob.
4. **`ops.length <= snapshot.adapter.max_batch_ops`**; else **`batch_size_exceeded`** (no mutation, no backup).

Also call **`assertGrammarDigestPinned()`** from parser construction paths as today; do not rely on a prior call alone.

## Apply batch atomicity (v0)

**Process-lifetime only:** `applyBatch` backs up canonical file text in memory, restores on failure, and is **best-effort atomic** for the **current Node process**. There is **no** crash-safe journal, WAL, or post-crash recovery in v0 — a kill mid-batch can leave the workspace partially mutated.

## `replace_unit` caller sharp edge (`export`)

If **`new_text`** includes a leading **`export`** while the logical unit span starts at **`function`** (common for `export function …`), the splice can yield **`export export function`** and a **`parse_error`**. v0 does **not** validate `new_text` shape beyond parse — **callers** must supply text consistent with the unit byte range (see op JSON notes below). Regression coverage: **`packages/ts-adapter/src/apply.test.ts`** (`replace_unit: leading export in new_text duplicates export and fails parse`), and **`packages/conformance/src/golden.test.ts`** (Tier I edit-shift golden: correct `new_text` without duplicating `export` for the middle stacked unit).

## Pinned OSS monorepo for A/B harness (Task 9)

**Pinned repository (v0):** **`https://github.com/colinhacks/zod`** at commit **`c7805073fef5b6b8857307c3d4b3597a70613bc2`** (see **`packages/ab-harness/.pinned-rev`**). **Rationale:** mid-sized TypeScript monorepo; at this pin the dependency graph does **not** pull a conflicting **tree-sitter** major alongside the adapter’s **`tree-sitter@0.21.1`**, keeping the harness + adapter install story predictable.

Before changing the pin, re-check the candidate revision’s **lockfile** for **tree-sitter** / **web-tree-sitter** versions that could force duplicate native builds or resolution surprises; document any intentional conflict and mitigation.

When **`packages/ab-harness/README.md`** documents baseline-vs-IR scenarios, **link** the **scoped rename / homonym** story to the adapter test **`packages/ts-adapter/src/apply.test.ts`** (`rename_symbol` keeps string literals intact while renaming identifiers) so the A/B narrative stays traceable to code.

## Read path — `WorkspaceSummary` vs `AdapterFingerprint` (v0)

**`max_batch_ops` duplication:** On `WorkspaceSummary`, **`max_batch_ops`** repeats the same value as **`AdapterFingerprint.max_batch_ops`** on the snapshot/report. That duplication is **intentional for v0** so agents read the batch limit on the cheap read path (spec section 6) without unpacking the full fingerprint. **Changing `max_batch_ops` constitutes a breaking adapter version bump** because apply-time fingerprint equality includes it. If **`AdapterFingerprint`** grows with more capability fields that also belong on the read path, **prefer** exposing the **full `AdapterFingerprint` struct** on `WorkspaceSummary` (or a shared `adapter_capabilities` object) instead of duplicating additional fields one-by-one.

## Conformance goldens (Task 8)

**Edit-shift id golden (plan Step 4):** MUST **apply a real edit** (e.g. **`replace_unit`** on the lower stacked unit in a multi-unit file), then **re-materialize** the snapshot. Assert: edited unit’s id **changes**; unit **above** the edit **unchanged**; unit **below** (if any) **changed** — per `units.ts` header. **Do not** substitute a **second identical materialization** of the same unchanged sources as the edit-shift test; that only proves determinism, not Tier I id semantics after mutation.

## Manifest discovery (spec section 16)

**Chosen mechanism (v0):** A single file **`agent-ir.manifest.json`** at the **snapshot workspace root** — the same absolute directory passed to **`materializeSnapshot({ rootPath })`** and to **`applyBatch({ snapshotRootPath })`**. Discovery is **`existsSync`/`stat`-style** on that path only (no crawl of nested packages).

**Rationale:** One unambiguous location in monorepos (no “which `package.json`?” rule), easy to document and test, matches the plan’s first suggested option, and keeps the read path O(1).

**Alternatives not used:** A custom field under **`package.json`** (e.g. `"agentIr": { … }`) was rejected for v0 because workspaces often have many **`package.json`** files; picking a single convention without extra hierarchy would be arbitrary.

**`WorkspaceSummary.manifest_url`:** If **`agent-ir.manifest.json`** exists and is a regular file, set **`manifest_url`** to its absolute **`file:`** URL (Node **`pathToFileURL(absolutePath).href`**). If the file is absent, **`manifest_url`** is **`null`**. This satisfies the standalone-locator rule: agents can open the manifest without implicit repo-root context.

**Manifest body:** If the file is missing, the adapter treats the manifest as **empty** — logically **`{}`** — and performs **no network fetch**. v0 does not resolve **`https:`** or other remote URLs from the manifest; only **`file:`** (via the resolved on-disk path above) is supported for the summary field. If the file exists but contains invalid JSON, v0 returns **`{}`** for parsed content (**lenient behavior is explicit in v0**) so the read path does not throw. **v1** should add **strict JSON/schema validation** (and normative error surfacing) **before** manifest content is allowed to drive agent behavior or policy.

**`buildWorkspaceSummary`:** The function is **`async`**. All current in-repo call sites **`await`** it (unit tests only as of Task 11); integrators must not call it synchronously.

## Op JSON shape (v0 subset: `replace_unit`, `rename_symbol`)

- **`replace_unit`:** `{ "op": "replace_unit", "target_id": string, "new_text": string }` — replaces the **entire** logical unit span `[start_byte, end_byte)` (canonical LF source) with `new_text`, then re-parses and re-snapshots. For `export function …`, the Tree-sitter **`function_declaration`** range usually starts at the `function` keyword (the `export ` prefix sits outside that node); **`new_text`** must splice valid source for that span (often `function name() { … }` without duplicating `export`).
- **`rename_symbol`:** `{ "op": "rename_symbol", "target_id": string, "new_name": string }` — v0 **function_declaration only**, **same file**; walks the declaration subtree and renames `identifier` nodes matching the declared name (name-independent unit **ids**; **`id_resolve_delta`** empty on success).

## `rename_symbol` scope (v0)

**Same-file, `function_declaration` only** (no `method_definition`, no cross-file). Identifiers matching the old name **inside** that declaration subtree are rewritten (declaration name, calls, nested identifiers with that spelling). **`id_resolve`** does not encode symbol names — renames do **not** emit `id_resolve_delta` entries in v0.

---

## v0 vs locked spec — deferred behavior and v1 gaps

Closing alignment pass (reference stack complete). The v0 adapter meets the **core contract** (Tier I identity, normative codes on implemented paths, apply-time gates, harness). The locked spec is **wider** than v0 on purpose: table entries and optional report fields exist so v1 can grow without a spec rewrite. This section records **what v0 deliberately does not do** and a **prioritized gap table** for v1 implementers.

### Optional `ValidationReport` extensions (spec section 5.1, pass-2 / ghost-bytes)

Fields such as **`export_surface_delta`**, **`coverage_hint`**, **`declaration_peers_unpatched`**, **`rename_surface_report`** are **optional** in the spec (“implementations MAY include them”). The v0 adapter **never emits** them — correct for v0. A v1 TypeScript adapter with project-aware checking (e.g. **tsc** scope) should plan to emit at least **`export_surface_delta`** and **`coverage_hint`** where applicable.

### Formatter drift (spec section 7)

v0 **canonicalization is LF line-ending normalization only** before hash and parse. There is **no pinned formatter** (e.g. Prettier profile). The normative code **`format_drift`** exists in the section 12.1 table but is **never emitted** by v0.

### Blob / inline threshold (spec section 10)

**v1:** Implemented per **Blob externalization (v1)** (this file): **`materializeSnapshot`** externalizes unit spans above the threshold into **`<root>/.cache/blobs/`**, **`LogicalUnit.blob_ref` / `omitted_due_to_size`**, and **`fetchBlobText`**. **v0** did not externalize (always inlined; **`omitted_due_to_size`** empty).

### Generated files and provenance (spec section 11)

**Provenance** metadata on files/units, **`illegal_target_generated`**, and **`allowlist_without_generator_awareness`** have types and table entries but **no behavioral implementation** in v0 — no file is classified as generated, so those gates do not fire. v1 needs a **provenance heuristic** and/or **manifest** annotations.

### `id_resolve` supersession (spec section 8)

The **flattened forward map** is satisfied **trivially** in v0 (identity only; no moves). Codes **`ghost_unit`** and **`unknown_or_superseded_id`** are wired where **`resolveCanonicalUnitId`** applies; **explicit tests for non-identity supersession chains** require **`move_unit`** (v1). When **`move_unit`** lands, add **ghost detection** and **forward-edge** tests.

### Rejection codes: in spec section 12.1 table, **never emitted** by the v0 adapter

The following normative codes appear in the locked table for completeness; **v0 does not emit them** on any path (stubs / future use only):

`format_drift` · `reanchored_span` · `illegal_target_generated` · `allowlist_without_generator_awareness` · `surface_changed` · `declaration_peer_unpatched` · `rename_surface_skipped_refs` · `coverage_unknown` · `coverage_miss` · `partial_apply_not_permitted`

Codes **not** in this list may still be **rare** in v0 (e.g. only on specific apply failures). **`lang.*`** subcodes are modeled in types; **v0 emits none**.

### v1 gap table (prioritized)

| Priority | Area | Gap | Spec (section) |
| -------- | ---- | --- | -------------- |
| High | Blob externalization | **Done (v1):** `.cache/blobs/`, `inline_threshold_bytes` on `materializeSnapshot`, `omitted_due_to_size`, `blob_unavailable` on cache miss | 10 |
| High | Generated provenance | Provenance fields; `illegal_target_generated` / allowlist gates never fire | 11 |
| High | `move_unit` / `relocate_unit` | Not implemented; `id_resolve` forward map untested for non-identity | 4.3, 8 |
| Medium | Formatter pinning | LF-only; no Prettier profile; `format_drift` never emitted | 7 |
| Medium | Ghost-bytes report fields | `export_surface_delta`, `coverage_hint`, etc. never emitted | 5.1 |
| Medium | `rename_symbol` scope | Same-file `function_declaration` only; no methods, no cross-file | Ops |
| Medium | Manifest strict mode | Lenient `{}` on invalid JSON; no schema validation | 16 |
| Low | TSX grammar | `skipped_tsx_paths` only; full TSX needs separate grammar constant | 4.1 |
| Low | Unemitted table codes | See list above | 12.1 |
| Low | Supersession tests | Ghost chain tests need `move_unit` | 8 |
