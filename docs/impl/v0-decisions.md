# v0 implementation decisions

Implementation-time choices for the Agent86 v0 reference stack (per [implementation plan](../superpowers/plans/2026-04-12-agent-ir-v0-implementation.md)). The product spec remains locked; this file is the normative log for repo-specific behavior.

## Grammar digest (v0, normative for this repo)

**Artifact (single choice, no “or” in code):** `grammar_digest` is the **SHA-256** (lowercase hex) of the file  
`tree-sitter-typescript/typescript/src/parser.c`  
as installed from the **pnpm-lockfile-pinned** npm package `tree-sitter-typescript` (currently **0.23.2**). The checked-in constant is `**GRAMMAR_DIGEST_V0`** in `packages/ts-adapter/src/grammar_meta.ts`.

**Scope:** v0 uses the **TypeScript** grammar only (`.ts`). The sibling `**tsx/src/parser.c`** is a different artifact and is **not** hashed for this digest. TSX support is out of scope until explicitly added (would require a separate constant or versioning strategy).

**Runtime:** The adapter loads `tree-sitter` **0.21.1** (peer-compatible) and `tree-sitter-typescript/bindings/node/typescript.js`. The digest gate compares **parser source bytes**, not the npm version string alone.

**CI / fail closed:** `assertGrammarDigestPinned()` (or equivalent) MUST run before apply; computed hash MUST equal `GRAMMAR_DIGEST_V0` or the batch fails.

**Bump policy — triggers (normative for when to re-hash and update the constant):**

1. **Lockfile package version change:** The pinned `tree-sitter-typescript` version in `pnpm-lock.yaml` (or equivalent) changes — re-hash the chosen artifact, update the in-repo digest constant, record a changelog entry, and treat as **breaking** for snapshot compatibility with prior digests.
2. **Artifact path or format change:** The implementation switches which file is hashed (e.g. WASM vs `parser.c`) or the package layout delivers a different on-disk artifact for the same semver — re-hash, update constant, same breaking snapshot semantics as (1).
3. **Intentional grammar bump without npm churn:** Rare case where the npm version is unchanged but the vendored or resolved artifact was replaced (e.g. manual pin fix) — re-hash and update if the file bytes differ.
4. **Local path overrides:** Any `pnpm`/npm **link**, `**overrides`**, or `**file:**` resolution that changes which `tree-sitter-typescript` tree is installed — **re-run the digest check** (recompute hash from the resolved on-disk `parser.c`, update `GRAMMAR_DIGEST_V0` if bytes differ, same breaking snapshot semantics).

## Blob externalization (v1)

**Date (normative for this repo):** 2026-04-12

**Default:** `inline_threshold_bytes = 8192` (UTF-8). Passed as an optional argument to `**materializeSnapshot`**; callers may raise it per request to force inlining of larger unit spans.

**Cache location:** Under the **snapshot workspace root** (the same absolute directory passed to `**materializeSnapshot({ rootPath })`** and `**applyBatch({ snapshotRootPath })**`):  
`**<snapshotRoot>/.cache/blobs/**`  
(`join(snapshotRoot, ".cache", "blobs")`, resolved to absolute paths in APIs). This directory is created on demand when at least one logical unit is externalized. It is listed in `**WorkspaceSummary.blob_cache_path**` so agents know where local `**sha256:**` payloads are stored.

**Ref and file naming (normative):**

- Wire `**blob_ref`** strings are `**sha256:**` followed by **64 lowercase hexadecimal** digits (the SHA-256 digest of the unit’s UTF-8 bytes, same bytes as the logical span in canonical LF source).
- On disk, each blob is a single file whose name is the **64-character lowercase hex digest** (no `sha256:` prefix, no extension): `**<blob_cache_path>/<64-hex>`**. File contents are UTF-8 text bytes identical to the logical unit span in canonical LF source.

**Eviction / GC:** **None in v1.** The cache **grows** with materialization; no automatic deletion. Documented limitation until a later version adds policy.

**Cache miss:** `**fetchBlobText(blobRef, snapshotRootPath)`** throws `**BlobNotFoundError**`. The `**message**` includes `**[blob_unavailable]**` and states that the blob is **not in local cache** and that the agent should **re-materialize the snapshot to rebuild** blobs. On apply, `**ValidationReport.entries[]`** uses the same wording for `**blob_unavailable**` (warning when the op can still proceed using on-disk file bytes for splice/parse). `**omitted_due_to_size**` MUST still list externalized refs (reason `**inline_threshold**`); if a fetch fails, the same ref may also appear with reason `**unavailable**` per spec `**OmittedBlob.reason**`.

`**inline_threshold_exceeded` on success:** If the **post-apply** snapshot still externalizes any unit, `**ValidationReport.outcome === "success"`** remains valid **but agents MUST inspect** `**entries[]`** for `**inline_threshold_exceeded**` and `**omitted_due_to_size**`. Success does **not** imply that all unit payloads were inlined or that nothing was omitted.

**Read path honesty — `WorkspaceSummary.omitted_due_to_size`:** Lists every `**sha256:`** payload not inlined in `**LogicalUnit**` records (`source_text === null`, `**blob_ref`/`blob_bytes` set**). The field is **always present** on the wire as an array, including `**[]`** when nothing was externalized — **never absent** in JSON (so “missing field” is not confused with “nothing omitted”).

**Invariant (LogicalUnit):** `**source_text`** and `**blob_ref**` are never both non-null. Inline mode: `**source_text**` is a string (possibly empty), `**blob_ref**` and `**blob_bytes**` are `**null**`. Externalized mode: `**source_text**` is `**null**`, `**blob_ref**` is a `**sha256:**` string, `**blob_bytes**` is the UTF-8 byte length of that payload.

---

## Generated file provenance (v1)

**Date (normative for this repo):** 2026-04-12

**Wire shape:** Every `**SnapshotFile`** and `**LogicalUnit**` carries `**provenance**`, always set — never omitted on the wire. `**{ kind: "authored" }**` is explicit (not “absence of generated”). When `**kind === "generated"**`, `**detected_by**` is **required** and names the rule that matched so operators and agents can audit classification.

**Scope — file-level only:** Classification is **per source file** (path + file header). `**LogicalUnit.provenance`** is inherited from the file and does not reflect symbol-level or cross-file facts. Tracking whether an individual export is “generated” while the file is mixed-authored, or correlating generated symbols across files, is **out of scope** for pattern-based v1 and is a **v2+** concern if added.

**Strategy:** Pattern-based detection only in v1. The adapter inspects **repo-relative POSIX paths** and the **first five lines** of the canonical LF file text (the same string used for hashing and parsing — **no second `readFile`**). **No manifest** is required for detection.

**Rules (apply in order; first match wins):**

1. **Header keywords:** Among the first five newline-delimited lines, scan **top to bottom**. The first line that contains `**@generated`** (case-insensitive) → `**kind: "generated"**`, `**detected_by: "header:@generated"**`. Else the first line that contains `**DO NOT EDIT**` (case-insensitive) → `**detected_by: "header:do-not-edit"**`. Covers protobuf/GraphQL headers and common “do not edit” banners.
2. **Path segments:** Split the relative path on `**/`**. If any segment equals `**__generated__**` → `**detected_by: "path:segment:__generated__"**`. Else if any segment equals `**generated**` → `**detected_by: "path:segment:generated"**`. (Whole segment match — not a substring of a longer segment name.)
3. **Extensions:** If the basename ends with `**.generated.ts`** or `**.generated.d.ts**` → `**detected_by: "ext:.generated.ts"**` or `**"ext:.generated.d.ts"**` as appropriate.
4. **Protobuf-style:** If the basename ends with `**.pb.ts`** or `**.pb.d.ts**` → `**detected_by: "path:*.pb.ts"**` or `**"path:*.pb.d.ts"**`.

If no rule matches: `**{ kind: "authored" }**` (no `**detected_by**`).

**Rationale:** Header and path heuristics match widespread tooling without repo-specific config. Segment `**generated/`** catches common `src/generated/...` layouts; `**__generated__/**` matches GraphQL and similar. Extension and `**.pb.***` rules catch filename conventions when headers are missing. Ordered rules keep `**snapshot_id**` deterministic.

**Apply-time behavior (spec section 11):** Ops that target a `**LogicalUnit`** with `**provenance.kind === "generated"**` are rejected with `**illegal_target_generated**` unless the file path is on the **generated edit allowlist** (see below). The message includes `**[gate:illegal_target_generated]`** and the unit’s `**detected_by**` value.

**Generated edit allowlist:** Optional key `**generated_edit_allowlist`** in `**agent-ir.manifest.json**`: a JSON **array of strings** — repo-relative POSIX paths. A path matches if it **equals** an entry **or** is under a directory entry: an entry **ending with `/**`** matches that prefix (e.g. `**"src/generated/**"**` matches `**src/generated/foo.ts**`). Invalid entries are ignored. This is **not** manifest-declared **provenance** (that is a separate follow-up); it only gates **whether direct edits to generated units are considered** for the §11 allowlist escape.

**Typed workflow assertions on ops:** An op MAY include `**generator_will_not_run: true`** and/or `**generator_inputs_patched**` (non-empty array of unit id strings). At least one assertion MUST be present to use the allowlist escape. If the target is generated, allowlisted, and asserted → batch MAY proceed; the adapter still emits `**allowlist_without_generator_awareness**` as a **warning** for auditability. If the target is generated, allowlisted, and **not** asserted → `**allowlist_without_generator_awareness`** with severity from `**WorkspaceSummary.policies.generated_allowlist_insufficient_assertions**` (`**getGeneratedAllowlistPolicy()**`), default `**error**`.

**Read path:** `**WorkspaceSummary.generated_file_count`** counts `**SnapshotFile**` entries with `**provenance.kind === "generated"**`. `**WorkspaceSummary.has_generated_files**` is `**true**` iff that count is **> 0** (cheap boolean for conditioning). Agents **must** still inspect `**SnapshotFile.provenance`** and `**LogicalUnit.provenance**` per target — the count and boolean only mean “something in this snapshot was classified generated,” not which units are safe to edit.

**Follow-up (not v1 — tracked separately):** **Manifest-declared provenance override** (option 1): e.g. `**generated_paths`** (globs or explicit paths) in `**agent-ir.manifest.json**` so non-standard repos can mark files `**generated**` when patterns miss. **Manifest wins over pattern match** when both apply. Implementation is deferred to a dedicated issue.

---

## Canonical bytes and line endings

Snapshot materialization hashes file contents **after normalizing line endings to LF** (`\n`): convert `\r\n` and standalone `\r` to `\n` before SHA-256. Paths are compared using POSIX-style relative paths sorted lexicographically for deterministic ordering.

**Parse failures (v1):** If **Tree-sitter** throws while parsing a tracked `.ts` file (rare on real monorepos), that file is **omitted** from `files[]` / `units[]` for that materialization — deterministic skip, no partial snapshot row for that path. Each omitted path is recorded in **`WorkspaceSnapshot.skipped_ts_parse_throw`** as `{ file_path, reason: "parse_throw" }` (sorted by `file_path`) so the omission is explicit on the wire and included in **`snapshot_id`** hashing.

## TSX and non-`.ts` sources

`**.tsx` files are never parsed with the v0 TypeScript grammar** (that would be silently wrong). The snapshot step **does not** include them in `files[]` or `units[]`. Instead, every materialization **discovers** every `.tsx` file under the root (recursive; excluding `node_modules`) and records each path in `**WorkspaceSnapshot.skipped_tsx_paths`** (repo-relative, sorted) so the omission is **explicit on the wire**, not an invisible gap. Parsing a `.tsx` path through the `.ts` parser is forbidden.

**TSX / JSX (documented deferred to v2):** Full `.tsx` support requires a **separate grammar digest constant** (the sibling `tsx/src/parser.c` artifact) and versioning strategy; that work is **out of scope for v1**. **`skipped_tsx_paths` is the permanent v1 posture** — operators rely on explicit omission on the wire rather than silent wrong parses.

**Future skip categories:** If a **second** skip reason besides TSX appears, **migrate** `skipped_tsx_paths` to a single wire field `**skipped_paths: Array<{ path: string; reason: string }>`** (sorted by `path`, then `reason`) instead of adding parallel string arrays per category.

## Tier I unit ids and `rename_symbol` / `id_resolve` delta

Opaque unit `**id**` (v0): SHA-256 (hex) over a stable UTF-8 string: grammar digest, resolved snapshot root, POSIX relative file path, `startIndex`, `endIndex` (Tree-sitter byte offsets in **canonical LF** source), and node kind (`function_declaration` | `method_definition`). Initial `**id_resolve`** is the identity map on unit ids.

`**relocate_unit` (spec section 4.3):** Not implemented as a separate op in v1 — behavior is covered by `**move_unit`**; treating `**relocate_unit**` as an alias is a **v2** documentation/compat candidate.

For `**replace_unit`** and `**rename_symbol**`, `**id_resolve_delta**` remains **empty** on success unless a batch also contains `**move_unit`** (which emits non-identity deltas).

## move_unit (v1)

**Date (normative for this repo):** 2026-04-12

**Spec:** Tier I auditable state transition (sections 4.3, 8, 12.1). `**move_unit`** is not a silent Tier II identity change; `**id_resolve_delta**` on `**ValidationReport**` is the batch audit trail, and the snapshot header’s `**id_resolve**` carries the flattened forward map.

### Scope — cross-file only

**In scope:** Move a logical unit’s **source bytes** from one **tracked** `.ts` file to another **repo-relative POSIX path** (may be a new file).

**Out of scope (v1) — same-file “reorder”:** Reordering units within a single file does **not** change module path or Tier I addressing in a way `**move_unit`** is meant to model; it has **no** semantic cross-file address change. Callers should use `**replace_unit`** on the file (or other edits) if reordering is required. Reject same source/destination path with `**lang.ts.move_unit_same_file**`.

**Out of scope (v1) — import / export reference rewriting:** `**move_unit`** only moves the unit’s text into the destination file. It does **not** rewrite `**import` / `export`** statements in **other** files that may still reference the old location. Updating those references is the **agent’s** responsibility. This must remain true in `**apply.ts`** (comments) so future work does not “helpfully” add cross-file refactors without an explicit spec and op vocabulary.

**Out of scope — `relocate_unit` as a distinct op:** Same as `**move_unit`** for v1; a separate opcode is deferred (alias candidate for v2).

**Out of scope — Tier II:** Cross-session / cross-branch durable identity is unchanged (spec section 4.2).

### Wire shape

- `**MoveUnitOp`:** `{ "op": "move_unit", "target_id": string, "destination_file": string, "insert_after_id"?: string }` plus optional §11 workflow fields (`**generator_will_not_run`**, `**generator_inputs_patched**`) consistent with other unit-targeting ops.
- `**destination_file`:** Repo-relative **POSIX** path (forward slashes).
- `**insert_after_id`:** Optional; if omitted, the unit is **appended** to the end of the destination file. If present, it must resolve (via `**id_resolve`**) to a **live** unit in `**destination_file`**; insertion is after that unit’s span.

**Type export name:** The union of batch ops remains exported as `**V0Op`** for backward compatibility; `**MoveUnitOp**` is added. An alias `**export type Op = V0Op**` may be exported for readability — same underlying type.

### `id_resolve` forward map (flattened)

- **Snapshot header (`WorkspaceSnapshot.id_resolve`):** `**old_id → new_id`** edges are **transitively closed** (single hop to the **current** live id for a moved logical line of identity). If `**A`** was previously mapped to `**B**`, and `**B**` is later moved to `**C**`, the flattened map stores `**A → C**` (not `**A → B**` with a second hop).
- **Invariant timing:** The flattened shape holds **after every successful `applyBatch` commit** (end of batch), not only across separate HTTP/tool calls. A **single** batch that chains supersession (e.g. `**move_unit`** **A→B** then `**move_unit`** **B→C**) must leave `**id_resolve[A] = C`**, not `**A → B**` with a second hop still required — the running snapshot inside `**applyBatch**` updates `**id_resolve**` after each op so later ops in the same batch resolve correctly (see conformance: intra-batch move then edit).
- **Per-batch audit (`ValidationReport.id_resolve_delta`):** Only the **edges produced by this batch** (e.g. `**old_id → new_id`** for the move just applied), not the full history. The snapshot header holds the full flattened map after apply.

**Merge / rematerialize:** When `**materializeSnapshot`** is called with optional `**previousSnapshot**` (see snapshot implementation), `**id_resolve**` entries whose keys are not current live unit ids are **merged** so that superseded ids still forward — including **ghost** edges where the resolved id is **not** live after disk changes — so `**applyBatch`** can emit `**ghost_unit**` per spec section 8.

**Callers must pass `previousSnapshot` after moves:** Integrators that invoke `**materializeSnapshot`** on disk that was changed using `**move_unit**` (or any op that emits non-identity `**id_resolve_delta**`) **must** pass `**previousSnapshot: <last WorkspaceSnapshot the agent used>`** on the next materialization. If `**previousSnapshot**` is omitted, superseded-id rows are not merged from history; `**applyBatch**` may return `**unknown_or_superseded_id**` in cases where `**ghost_unit**` would apply if forward edges had been preserved — **ghost detection silently degrades** to “unknown” from the agent’s perspective.

### Auto-resolve with warning (Option C)

When an op’s `**target_id`** is **not** a live unit id but `**snapshot.id_resolve[target_id]`** is defined:

1. The adapter resolves `**target_id → resolved_id**` using the **flattened** map (single lookup on the snapshot).
2. The op runs against `**resolved_id`**’s live unit (same as if the agent had sent `**resolved_id**`).
3. The `**ValidationReport**` includes a `**id_superseded**` **warning** entry (section 12.1–style code `**id_superseded`**, `**severity: warning**`, `**target_id**` = the **original** id, `**evidence.resolved_to`** = `**resolved_id**`) so resolution is **never silent**.

### `ghost_unit` vs `unknown_or_superseded_id`

- `**unknown_or_superseded_id`:** `**target_id`** is **not** a live unit id and has **no** entry in `**id_resolve`** (fully unknown / obsolete handle not known to this snapshot).
- `**ghost_unit`:** `**target_id`** **is** in `**id_resolve`**, but `**id_resolve[target_id]**` does **not** refer to a **live** unit in `**snapshot.units`** (moved then deleted, or snapshot/disk severely stale). Hard reject; **no** mutation.

### Destination file behavior

1. **Destination path not in snapshot but file exists on disk:** `**snapshot_content_mismatch`** (or equivalent stale manifest) — re-materialize before apply.
2. **Destination does not exist:** Create the file containing the moved unit’s canonical source text (LF); then re-materialize.
3. **Destination exists (tracked):** Insert the unit after `**insert_after_id`** or append; then re-materialize **source and destination** (and any other changed paths).
4. **Name conflict:** If the destination file already contains a **logical unit** with the same **declared** function/method name as the moved unit, reject with `**lang.ts.move_unit_name_conflict`** before any write.
5. **Source file after removal:** If the source file has **no** remaining logical units, the adapter **keeps** the file (may be empty). **v1 does not delete** source files.

### Atomicity

`**move_unit`** touches **two** files. `**applyBatch`** extends the same **process-lifetime** backup/restore model as v0: both paths are backed up before mutation (including a destination path that exists but was not previously tracked — read from disk at backup time), and both are restored on failure. No crash-safe WAL.

### `lang.*` extensions (this feature)


| Code                                  | Severity | Meaning                                                                                  |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `**lang.ts.move_unit_name_conflict`** | error    | Destination file already has a unit with the same declared name.                         |
| `**lang.ts.move_unit_same_file**`     | error    | `destination_file` equals the source file (same-file reorder / no-op move out of scope). |


## Apply path — §9 gates (Task 7)

On each `**applyBatch**` attempt, in order **before** reading files or expanding ops:

1. `**assertGrammarDigestPinned()`** — on-disk grammar artifact matches `**GRAMMAR_DIGEST_V0**`; else `**grammar_mismatch**` with message prefix `**[gate:runtime_grammar_artifact]**` (runtime / lockfile install vs checked-in constant).
2. `**snapshot.grammar_digest === GRAMMAR_DIGEST_V0**` — snapshot header matches applying grammar; else `**grammar_mismatch**` with prefix `**[gate:snapshot_grammar_digest]**` (stale or foreign snapshot vs current adapter). Operators should distinguish these in telemetry.
3. `**snapshot.adapter**` must match the applying adapter fingerprint (`**V0_ADAPTER_FINGERPRINT**` in `snapshot.ts`); else `**adapter_version_unsupported**`. `**max_batch_ops**` is part of that equality: changing it is a **breaking** adapter version bump for interchange (same as name/semver drift), not an independent knob.
4. `**ops.length <= snapshot.adapter.max_batch_ops`**; else `**batch_size_exceeded**` (no mutation, no backup).
5. **On-disk file bytes vs snapshot manifest (v1, pre-splice):** Immediately when `**applyBatch`** reads each tracked `**WorkspaceSnapshot.files[]**` path for its in-memory backup (before any op splice), it canonicalizes to LF and compares **SHA-256** to `**files[].sha256`**. If any path differs → `**snapshot_content_mismatch**` with message prefix `**[gate:snapshot_content_mismatch]**`, **no writes** to tracked files in that batch attempt. **Rationale:** prevents silent Tier I corruption when disk drifted after materialization (hand edits, formatter, VCS partial state, tool races) while `**WorkspaceSnapshot`** still advertises stale hashes — the same class of risk **§7** calls out for identity drift, in a new form once ops expand using snapshot-derived spans.

Also call `**assertGrammarDigestPinned()`** from parser construction paths as today; do not rely on a prior call alone.

## Apply batch atomicity (v0)

**Process-lifetime only:** `applyBatch` backs up canonical file text in memory, restores on failure, and is **best-effort atomic** for the **current Node process**. There is **no** crash-safe journal, WAL, or post-crash recovery in v0 — a kill mid-batch can leave the workspace partially mutated.

## `replace_unit` caller sharp edge (`export`)

If `**new_text`** includes a leading `**export**` while the logical unit span starts at `**function**` (common for `export function …`), the splice can yield `**export export function**` and a `**parse_error**`. v0 does **not** validate `new_text` shape beyond parse — **callers** must supply text consistent with the unit byte range (see op JSON notes below). Regression coverage: `**packages/ts-adapter/src/apply.test.ts`** (`replace_unit: leading export in new_text duplicates export and fails parse`), and `**packages/conformance/src/golden.test.ts**` (Tier I edit-shift golden: correct `new_text` without duplicating `export` for the middle stacked unit).

## Pinned OSS monorepo for A/B harness (Task 9)

**Pinned repository (v0):** `**https://github.com/colinhacks/zod`** at commit `**c7805073fef5b6b8857307c3d4b3597a70613bc2**` (see `**packages/ab-harness/.pinned-rev**`). **Rationale:** mid-sized TypeScript monorepo; at this pin the dependency graph does **not** pull a conflicting **tree-sitter** major alongside the adapter’s `**tree-sitter@0.21.1`**, keeping the harness + adapter install story predictable.

Before changing the pin, re-check the candidate revision’s **lockfile** for **tree-sitter** / **web-tree-sitter** versions that could force duplicate native builds or resolution surprises; document any intentional conflict and mitigation.

When `**packages/ab-harness/README.md`** documents baseline-vs-IR scenarios, **link** the **scoped rename / homonym** story to the adapter test `**packages/ts-adapter/src/apply.test.ts`** (`rename_symbol` keeps string literals intact while renaming identifiers) so the A/B narrative stays traceable to code.

### tRPC demo harness (demo run)

**Date:** 2026-04-13

**Pinned revision:** `https://github.com/trpc/trpc` at commit `**c188dab0822caf3615199e4ac95147bc7560d26f`** (see `**packages/ab-harness/.pinned-rev-trpc**`). **Verification before pin:** `git ls-remote` on `refs/heads/main` matched this tip; all `package.json` files under the checkout were scanned for `**tree-sitter`** / `**web-tree-sitter**` — **no matches**, so the install graph does not conflict with the adapter’s `**tree-sitter@0.21.1`**.

**Rationale:** Live A/B demo for stakeholders (failed patch rate, full-file reads, round trips) on a real TypeScript monorepo with `**packages/server`** and `**packages/client**`, without changing the Zod harness pin or scenarios.

**Clone path:** `**.cache/ab-trpc/`** (concrete directory: `**<repo>/.cache/ab-trpc/trpc/**` after clone). **Metrics output:** `**packages/ab-harness/ab-metrics-trpc.json`** (default), with `**demo_run: true**` in the JSON. **Profile:** `pnpm --filter ab-harness start --profile trpc` (or `**AB_PROFILE=trpc`**).

**Scope:** Demo-only tasks (cross-package `callProcedure` rename with probe literal, `isObject` replace, `inputWithTrackedEventId` move) use **staged copies** of a few real files under `**__agent_ir_trpc__/{a,b,c}/`** inside the clone so runs stay fast and deterministic; the pin is still the real tRPC tree at the SHA above.

## Read path — `WorkspaceSummary` vs `AdapterFingerprint` (v0)

`**max_batch_ops` duplication:** On `WorkspaceSummary`, `**max_batch_ops`** repeats the same value as `**AdapterFingerprint.max_batch_ops**` on the snapshot/report. That duplication is **intentional for v0** so agents read the batch limit on the cheap read path (spec section 6) without unpacking the full fingerprint. **Changing `max_batch_ops` constitutes a breaking adapter version bump** because apply-time fingerprint equality includes it. If `**AdapterFingerprint`** grows with more capability fields that also belong on the read path, **prefer** exposing the **full `AdapterFingerprint` struct** on `WorkspaceSummary` (or a shared `adapter_capabilities` object) instead of duplicating additional fields one-by-one.

## Conformance goldens (Task 8)

**Edit-shift id golden (plan Step 4):** MUST **apply a real edit** (e.g. `**replace_unit`** on the lower stacked unit in a multi-unit file), then **re-materialize** the snapshot. Assert: edited unit’s id **changes**; unit **above** the edit **unchanged**; unit **below** (if any) **changed** — per `units.ts` header. **Do not** substitute a **second identical materialization** of the same unchanged sources as the edit-shift test; that only proves determinism, not Tier I id semantics after mutation.

## Manifest discovery (spec section 16)

**Chosen mechanism (v0):** A single file `**agent-ir.manifest.json`** at the **snapshot workspace root** — the same absolute directory passed to `**materializeSnapshot({ rootPath })`** and to `**applyBatch({ snapshotRootPath })**`. Discovery is `**existsSync`/`stat`-style** on that path only (no crawl of nested packages).

**Rationale:** One unambiguous location in monorepos (no “which `package.json`?” rule), easy to document and test, matches the plan’s first suggested option, and keeps the read path O(1).

**Alternatives not used:** A custom field under `**package.json`** (e.g. `"agentIr": { … }`) was rejected for v0 because workspaces often have many `**package.json**` files; picking a single convention without extra hierarchy would be arbitrary.

`**WorkspaceSummary.manifest_url`:** If `**agent-ir.manifest.json`** exists and is a regular file, set `**manifest_url**` to its absolute `**file:**` URL (Node `**pathToFileURL(absolutePath).href**`). If the file is absent, `**manifest_url**` is `**null**`. This satisfies the standalone-locator rule: agents can open the manifest without implicit repo-root context.

**Manifest body:** If the file is missing, the adapter treats the manifest as **empty** — logically `**{}`** — and performs **no network fetch**. v0 does not resolve `**https:`** or other remote URLs from the manifest; only `**file:**` (via the resolved on-disk path above) is supported for the summary field. If the file exists but contains invalid JSON, v0 returns `**{}**` for parsed content (**lenient behavior is explicit in v0**) so the read path does not throw. **Strict mode (v1)** adds opt-in validation and `**lang.ts.manifest_parse_error`** warnings — see **Manifest strict mode (v1)** below; deeper JSON Schema for nested keys remains **v2+**.

`**buildWorkspaceSummary`:** The function is `**async`**. All current in-repo call sites `**await**` it (unit tests only as of Task 11); integrators must not call it synchronously.

### Manifest strict mode (v1)

**Date (normative for this repo):** 2026-04-12

**Purpose:** v0 **lenient** parsing (missing file → logical `**{}`**, invalid JSON or non-object root → `**{}**` on the read path) stays the **default** so existing integrations do not break. **Strict** mode is **opt-in** for callers that want machine-readable surfacing before manifest-driven policy is trusted.

**Two modes**


| Mode                     | Activation                                                                                                             | Invalid JSON                                                                                                                                                                                            | Non-object JSON root (`[]`, `"x"`, `null`, …)                                                                                         | Missing `agent-ir.manifest.json`                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Lenient (v0 default)** | `readAgentIrManifest(root, { strict?: false })` (default); `buildWorkspaceSummary(snapshot, root)` without strict flag | Parsed content treated as `**{}`** (unchanged v0 behavior)                                                                                                                                              | `**{}**`                                                                                                                              | `**{}**`, `**manifest_url**` `**null**`                                                                           |
| **Strict (opt-in v1)**   | `readAgentIrManifest(root, { strict: true })`; `buildWorkspaceSummary(snapshot, root, { strictManifest: true })`       | `**ManifestParseError`** (throw from `readAgentIrManifest`); on the summary path, a `**lang.ts.manifest_parse_error**` **warning** on `**WorkspaceSummary.manifest_warnings`** (summary still returned) | Same as invalid JSON for strict `**readAgentIrManifest**` (`**reason: non_object_root**`); summary path surfaces the same **warning** | **Not an error:** parsed manifest is `**{}`**, `**manifest_url**` is `**null**`, `**manifest_warnings**` `**[]**` |


**Schema validation boundary (v1 vs v2):** In strict mode, the adapter validates only that the manifest **root** is a plain **JSON object** (`{}` and object literals — not an array, string, number, boolean, or `**null`**). **Deeper** schema (required keys, types of nested values, allowlist shape, etc.) is **out of scope for v1** and remains a **v2+** concern unless specified later.

**WorkspaceSummary fields**

- `**manifest_strict`:** `**boolean`** — `**true**` iff this summary was built with `**strictManifest: true**`; `**false**` by default (lenient).
- `**manifest_warnings`:** `**ValidationEntry[]`** — in strict mode, parse/shape failures add `**lang.ts.manifest_parse_error**` entries here; **always present on the wire**, `**[]`** when there are no issues. Callers must not treat a **missing** field as equivalent to “no warnings” (same “never silent omission” rule as `**omitted_due_to_size`**).

**Non-atomic reads (v1):** Strict mode performs two reads — URL resolution and validation — which are not atomic; v2 should unify into a single read.

`**readAgentIrManifest`:** Second argument `**{ strict?: boolean }`**. Default `**false**` preserves v0. `**strict: true**` throws `**ManifestParseError**` on invalid JSON or non-object root; missing file still resolves to `**{}**` without throwing.

**Rejection / report code (`lang.*` extension)**


| Code                               | Severity on `WorkspaceSummary` | Meaning                                                                                                                                                                      |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**lang.ts.manifest_parse_error`** | **warning**                    | Strict manifest read failed: invalid JSON (`**reason: invalid_json`**) or root is not an object (`**reason: non_object_root**`). Not a hard apply reject; the agent decides. |


**Normative message shape (reference adapter):**  
`[lang.ts.manifest_parse_error] agent-ir.manifest.json could not be parsed: <detail> (path: <absolute path>)`

**Normative evidence:** `{ path: string, reason: "invalid_json" | "non_object_root", raw_error?: string }` — `**raw_error`** present when the underlying `**JSON.parse**` failure message is available.

**Apply path:** `**applyBatch`** continues to use **lenient** `**readAgentIrManifest`** (default options) so batch behavior stays aligned with v0 unless callers change that contract explicitly in a future revision.

**Follow-up (v2+):** Full JSON Schema (or equivalent) validation of manifest contents beyond root-is-object.

## Op JSON shape (v0 subset: `replace_unit`, `rename_symbol`; v1: `move_unit`)

- `**replace_unit`:** `{ "op": "replace_unit", "target_id": string, "new_text": string }` — replaces the **entire** logical unit span `[start_byte, end_byte)` (canonical LF source) with `new_text`, then re-parses and re-snapshots. For `export function …`, the Tree-sitter `**function_declaration`** range usually starts at the `function` keyword (the `export`  prefix sits outside that node); `**new_text**` must splice valid source for that span (often `function name() { … }` without duplicating `export`).
- `**rename_symbol`:** `{ "op": "rename_symbol", "target_id": string, "new_name": string, "cross_file"?: boolean }` — `**cross_file`** defaults `**false**`. `**function_declaration**` and `**method_definition**`; same-file scope rules and optional cross-file identifier scan per **rename_symbol expansion (v1)**. Emits `**rename_surface_report`** on success (name-independent unit **ids**; `**id_resolve_delta`** empty on success unless combined with other ops).
- `**move_unit` (v1):** `{ "op": "move_unit", "target_id": string, "destination_file": string, "insert_after_id"?: string }` — cross-file move of the unit’s canonical span; optional §11 workflow fields allowed. See **move_unit (v1)** above.

## `rename_symbol` scope (v0)

**Same-file, `function_declaration` only** (no `method_definition`, no cross-file). Identifiers matching the old name **inside** that declaration subtree are rewritten (declaration name, calls, nested identifiers with that spelling). `**id_resolve`** does not encode symbol names — renames do **not** emit `id_resolve_delta` entries in v0.

---

## `rename_symbol` expansion (v1)

**Date (normative for this repo):** 2026-04-12

This section supersedes the bounded **rename_symbol scope (v0)** description above for the reference adapter: `**function_declaration` and `method_definition`**, optional **cross-file** best-effort reference rewriting, and a **normative `rename_surface_report`** on every successful `rename_symbol` apply.

### Supported declaration kinds


| Kind                       | Same-file behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**function_declaration**` | Lexical-scope–aware rename of the declared name: walk the **entire** file AST (not only the declaration subtree). Rewrite `**identifier`** occurrences that resolve to the target binding; apply homonym / skip rules below. Do **not** rewrite `**property_identifier`** nodes for function targets (treats dotted access `obj.foo` as out of scope for this op — avoids silent reshaping of unrelated members during best-effort cross-file scans).                                                                                                                                                                                                                |
| `**method_definition**`    | The declared name is the Tree-sitter `**property_identifier**` child (via `name` field), not the `function_declaration` `**identifier**` pattern. Same-file rewrites are limited to the **enclosing class body** of the target method (the `class_body` of the containing `class_declaration` / `class` expression) plus the method’s own header: `**identifier`** and `**property_identifier**` nodes matching the old name are candidates, subject to homonym rules. **Scope isolation:** another class in the same file may declare the same method name; that class’s declarations and internal references **must not** change when renaming one class’s method. |


**Unsupported** Tier-I units (or future node kinds) are rejected with `**lang.ts.rename_unsupported_node_kind`** (not `**op_vocabulary_unsupported**`) when the resolved target is not a `function_declaration` or `method_definition`.

### Homonym and skip rules (same file)

The following **must not** be rewritten (record each in `**rename_surface_report.skipped`** with a stable `**reason**` string):

- `**string_literal**` / template content: identifiers appearing only as part of string text are untouched (string literals are never traversed for identifier substitution; naive string replace would hit these — IR must not).
- **Type positions:** `type_identifier` and identifier-like nodes in type-only positions (type annotations, type arguments) — **not** value identifiers.
- **Property keys / member access (narrow reading):** `**property_identifier`** nodes that are **object literal** keys or **shorthand** keys in object patterns where the name is a **key**, not the method-declaration header — skipped. For `**function_declaration`**, `**property_identifier**` nodes are skipped in general (see table above). For `**method_definition**`, `**property_identifier**` nodes **inside the target class body** are rewritten when they refer to the target method (e.g. `this.m`, `other.m` within the class); keys in object literals inside that class are still skipped.
- **Cross-scope homonyms:** Identifiers that resolve to a **different** lexical binding of the same spelling (nested `function foo`, parameters, inner declarations) are skipped with a homonym / shadowing reason.

### Cross-file reference rewriting (`cross_file`)

**Wire shape:** `rename_symbol` accepts an optional boolean `**cross_file`** (default `**false**` — preserves v0 behavior: only the file containing the declaration is considered).


| Value       | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**false**` | Safe / narrow: same-file rewrite only; no other files are scanned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `**true**`  | After a successful same-file rename, scan **every other** tracked `.ts` file in the snapshot (full snapshot, all `.ts` files in `WorkspaceSnapshot.files`). **Best-effort:** rewrite `**identifier`** nodes whose text equals the old name, using string/template and type-position skips. `**export { oldName as alias }**` and other **export-clause** value identifiers are rewritten when matched (no export-clause skip). Identifiers under `**import_statement`** (import specifiers) are **skipped** with `**skip:import_specifier`** — the adapter does not model module resolution; callers may need to align imports manually after a cross-file rename. **No** whole-project TypeScript checker — two modules may each export a function `get`; **both** may be rewritten outside import lines. Agents **must** treat `**found` / `rewritten` / `skipped`** as **best-effort** signal, not soundness. |


**Limitation (loud):** Cross-file rename **does not** prove that a matching identifier refers to the renamed symbol. Common names (`**get`**, `**id**`, `**run**`) may match many unrelated identifiers; agents should inspect `**rename_surface_report**` and prefer `**cross_file: false**` when a narrow same-file edit suffices.

**Declaration move / path change** is out of scope — that is `**move_unit`**. This op only renames the **symbol spelling** in place.

### `rename_surface_report` (normative for this adapter)

On **every** successful `**rename_symbol`** batch step, the adapter emits a `**rename_surface_report**` attached to the corresponding `**ValidationReport.entries[]**` item (spec section 5.1 shape), **never `null`** for this opcode.

Shape:

```typescript
{
  found: number;       // candidate nodes matching old name in the applied search scope (see below)
  rewritten: number;   // nodes actually replaced
  skipped: Array<{
    unit_id: string | null;  // smallest enclosing Tier I `LogicalUnit` for this reference site, or `null`
    reason: string;          // machine-readable skip reason, or `no_enclosing_unit` when `unit_id` is null
    file: string;            // repo-relative POSIX path of the file containing the skipped occurrence
  }>;
}
```

- `**found**` counts nodes that matched the old name and were classified (rewritten or skipped), aggregated across files touched by the op (same-file only when `cross_file: false`).
- `**skipped[].unit_id`:** the **smallest** (tightest span) Tier I unit in the same file whose byte range **encloses** the skipped identifier span. When no `LogicalUnit` encloses the reference (e.g. some top-level script between units), `**unit_id` is `null`** and `**reason` is exactly `no_enclosing_unit**` (granular skip reasons apply only when an enclosing unit exists).
- `**skipped[].file**` is always set so agents can locate occurrences (same-file uses that file; cross-file uses each other file’s path).
- **Best-effort:** for cross-file scans, `**skipped`** may be empty even when false positives exist — we only list **intentional** skips (homonym rules), not “unknown semantic mismatch.”
- `**export { foo as bar }` / named re-exports:** identifiers in the `**export` clause** that the TypeScript binder resolves to the same symbol as the renamed declaration are **rewritten** to `**new_name`** (same as other value identifiers). No separate “skip export list” limitation in the reference adapter for this pattern.

### Warnings (section 12.1)

- Emit `**rename_surface_skipped_refs**` (warning) when `**skipped.length > 0**` so agents are alerted without comparing counts manually.
- Emit `**lang.ts.cross_file_rename_broad_match**` (warning) when `**cross_file: true**` and `**rename_surface_report.found**` is **strictly greater than** `**CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD`** (**10** in this repo). This is the primary guardrail when a best-effort cross-file scan touches many name matches — `**rename_surface_skipped_refs`** alone does not signal mass rewrite risk (skipped can be empty while `**found**` is large). Integrators may treat the threshold as a tunable constant in code; document changes here when bumped.
- `**parse_scope_file**` info entry remains; cross-file edits still do not imply project-wide semantic correctness.

### Atomicity

Cross-file rename may touch many files. `**applyBatch**` already backs up **all** tracked snapshot files before any mutation; extended rename **must not** write until same-file success is known, then perform cross-file rewrites, then re-snapshot. On `**parse_error`** or any failure after partial writes, **restore all** backed-up paths (same process-lifetime model as `**move_unit`**).

### `lang.*` extensions (rename)


| Code                                        | Severity | Meaning                                                                                                                                                                                 |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**lang.ts.rename_unsupported_node_kind**`  | error    | Target unit’s AST node is not `function_declaration` or `method_definition` (e.g. future unit kinds).                                                                                   |
| `**lang.ts.cross_file_rename_broad_match**` | warning  | `**cross_file: true**` and `**rename_surface_report.found` > 10** (default threshold); many textual matches — high false-positive risk before commit. Evidence: `{ found, threshold }`. |


---

## v0 vs locked spec — deferred behavior and v1 gaps

Closing alignment pass (reference stack complete). The v0 adapter meets the **core contract** (Tier I identity, normative codes on implemented paths, apply-time gates, harness). The locked spec is **wider** than v0 on purpose: table entries and optional report fields exist so v1 can grow without a spec rewrite. This section records **what v0 deliberately does not do** and a **prioritized gap table** for v1 implementers.

### Optional `ValidationReport` extensions (spec section 5.1, pass-2 / ghost-bytes)

Fields such as `**export_surface_delta`**, `**coverage_hint**`, `**declaration_peers_unpatched**` remain **optional** in the locked spec (“implementations MAY include them”). **As of v1**, the reference adapter **emits** all three on every `**applyBatch**` `**ValidationEntry**` with semantics in **Ghost-bytes report fields (v1)**. `**rename_surface_report`** is **optional** in the locked spec text but **normative for this repo** on every successful `**rename_symbol`** — see **rename_symbol expansion (v1)**.

### Formatter drift (spec section 7)

v0 **canonicalization is LF line-ending normalization only** before hash and parse. **v1** adds **Formatter pinning (v1)** (manifest `**formatter.profile**`, optional `**format_drift`** warnings). Pure v0 snapshots did not use formatter profiles or emit `**format_drift**`.

### Blob / inline threshold (spec section 10)

**v1:** Implemented per **Blob externalization (v1)** (this file): `**materializeSnapshot`** externalizes unit spans above the threshold into `**<root>/.cache/blobs/**`, `**LogicalUnit.blob_ref` / `omitted_due_to_size**`, and `**fetchBlobText**`. **v0** did not externalize (always inlined; `**omitted_due_to_size`** empty).

### Generated files and provenance (spec section 11)

**v1:** Implemented per **Generated file provenance (v1)** (this file): pattern-based `**provenance`** on `**SnapshotFile**` / `**LogicalUnit**`, `**illegal_target_generated**`, manifest `**generated_edit_allowlist**` + op assertions, and `**allowlist_without_generator_awareness**` per §6.1. **v0** did not classify files or emit those gates.

### `id_resolve` supersession (spec section 8)

The **flattened forward map** is satisfied **trivially** in v0 (identity only; no moves). **v1** implements `**move_unit`** (see **move_unit (v1)** below): non-identity `**id_resolve`**, `**id_resolve_delta**` on success, `**id_superseded**` warnings on auto-resolve, `**ghost_unit**` / `**unknown_or_superseded_id**` on invalid targets, and conformance goldens for chains and ghosts.

### Rejection codes: in spec section 12.1 table, **never emitted** by the reference adapter (v0 list)

The following normative codes appear in the locked table for completeness; the **v0** adapter did not emit them on any path (stubs / future use). **As of v1 provenance**, `**illegal_target_generated`** and `**allowlist_without_generator_awareness**` are removed from this list — the reference adapter emits them when §11 conditions apply. `**snapshot_content_mismatch**` is still handled separately below — it is **not** one of these “never emitted” codes.

**2026-04-13 audit:** List reflects v1 state post ghost-bytes, formatter, and supersession work (audit of `applyBatch`, `rename_symbol`, `move_unit`, provenance, and report builders).

`reanchored_span` · `surface_changed` · `declaration_peer_unpatched` · `coverage_unknown` · `coverage_miss` · `partial_apply_not_permitted`

**Correction (2026-04-13):** `**rename_surface_skipped_refs**` was removed from this backtick list — the reference adapter **does** emit it when a successful `**rename_symbol**` has one or more intentional skips (see **rename_symbol expansion (v1)**).

**Note (v1):** `**format_drift**` is emitted by the reference adapter as a **warning** under **Formatter pinning (v1)** when drift is detected under the `**lf-only`** profile (portable §12.1 table lists **E**; normative downgrade sentence added to the locked spec **2026-04-13**).

Codes **not** in this list may still be **rare** in v0 (e.g. only on specific apply failures). `**lang.*`** subcodes are modeled in types; **v0 emits none**.

`**snapshot_content_mismatch` — emitted by the reference adapter (v1, pre-splice, §9 gate 5):** `**applyBatch`** emits `**snapshot_content_mismatch**` when canonical LF SHA-256 of on-disk bytes for a tracked file **≠** `**WorkspaceSnapshot.files[].sha256`** (see gate 5 above). This code was **never** in the “never emitted” backtick list; documenting it here prevents readers from treating drift detection as a bug.

### v1 gap table (prioritized)


| Priority | Area                          | Gap                                                                                                                                                                                                                    | Spec (section) |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| High     | Blob externalization          | **Done (v1):** `.cache/blobs/`, `inline_threshold_bytes` on `materializeSnapshot`, `omitted_due_to_size`, `blob_unavailable` on cache miss                                                                             | 10             |
| High     | Generated provenance          | **Done (v1):** pattern `**provenance`**, `illegal_target_generated`, manifest allowlist + assertions, `WorkspaceSummary.generated_file_count`                                                                          | 11             |
| High     | `move_unit` / `relocate_unit` | **Done (v1):** cross-file `move_unit` per **move_unit (v1)** below; `relocate_unit` still not a separate op (alias candidate for v2)                                                                                   | 4.3, 8         |
| Medium   | Formatter pinning             | **Done (v1):** manifest `**formatter.profile**` (`**lf-only`** default; `**prettier`** stub); `**format_drift`** warning on unexpected CR; see **Formatter pinning (v1)**                                                                                                                               | 7              |
| Medium   | Ghost-bytes report fields     | **Done (v1):** `**export_surface_delta**` (Tree-sitter export-name digest), `**coverage_hint**` null placeholders, `**declaration_peers_unpatched**` (same-dir `**basename.d.ts**`); see **Ghost-bytes report fields (v1)**                                                                              | 5.1            |
| Medium   | `rename_symbol` scope         | **Done (v1 rename expansion):** `function_declaration` + `method_definition`; optional `cross_file`; normative `rename_surface_report`; see **rename_symbol expansion (v1)**                                           | Ops            |
| Medium   | Manifest strict mode          | **Done (v1):** opt-in `**strictManifest`** / `**readAgentIrManifest({ strict: true })**`, root-is-object check, `**lang.ts.manifest_parse_error**` on `**WorkspaceSummary.manifest_warnings**`; deeper schema deferred | 16             |
| Low      | TSX grammar                   | **Documented deferred (v2):** `skipped_tsx_paths` is permanent v1 posture; full TSX requires separate grammar constant                                                                                                  | 4.1            |
| Low      | Unemitted table codes         | **Audited (2026-04-13):** see “never emitted” list above (**excludes** `snapshot_content_mismatch`, emitted by §9 gate 5 v1)                                                                                            | 12.1           |
| Low      | Supersession tests            | **Done (v1):** `packages/conformance/src/golden.test.ts` — **v1 — supersession conformance (section 8)**                                                                                                                | 8              |


## Ghost-bytes report fields (v1)

**Date (normative for this repo):** 2026-04-13

This section closes the Medium-priority gap **Ghost-bytes report fields** from the v1 gap table (spec section 5.1, pass 2). Fields are attached to `ValidationEntry` records on the apply path; see **Formatter pinning (v1)** for `format_drift`.

### `export_surface_delta`

**Severity of meaning:** Informational attachment on success-path entries; not a substitute for the separate **`surface_changed`** warning code (spec section 12.1), which remains **not emitted** in v1 — that pass-2 warning is deferred until a later release ties digest deltas to explicit `surface_changed` emission (even when `export_surface_delta === "changed"`).

**Values:** `"unchanged"` \| `"changed"` \| `"unknown"`.

**Algorithm (reference adapter, v1):** After a successful op that mutates source, compare a **pre-op** and **post-op** digest of the **exported value surface** for each primary edited file (see below). If digests are equal → `"unchanged"`; if unequal → `"changed"`. If the Tree-sitter parse used for extraction has errors, or surface extraction throws → `"unknown"`.

**Digest:** SHA-256 (lowercase hex) of the UTF-8 encoding of **sorted unique exported declaration names** joined by U+000A (`\n`), with no trailing newline after the last name. Names are collected only from the Tree-sitter parse of canonical LF source — **no TypeScript compiler API** (no `tsc`) in v1.

**What counts as an exported name (approximation):** Walk **top-level** `export_statement` nodes in the program. Skip re-exports (`export … from '…'`). For `export_clause` without `from`, use each `export_specifier`’s **exported** identifier (the last identifier for `foo as bar`). For inline exports (`export function` / `export class` / `export const` / `export enum` / `export namespace` / `export default` with a named declaration), collect the declaration’s exported binding name. **omit** type-only exports (`export type`, `export interface`, and type-only positions). This is a **best-effort syntactic surface**, not module-resolution–aware export graph semantics; **barrel re-exports and `export *` are out of scope for v1** (documented limitation).

**Multi-file ops:** For `rename_symbol` with `cross_file: true`, the adapter compares the **declaration file’s** surface before and after the op (the file containing the renamed declaration). For `move_unit`, if either source or destination **tracked** `.ts` path’s surface digest changes, the reported delta for that step is `"changed"`.

### `coverage_hint`

**v1:** Always **`{ "covered": null, "coverage_source": null }`** on every `ValidationEntry` produced by `applyBatch` (typed nulls — **not** field absence). **V8/Istanbul** (or any runtime coverage) integration is **out of scope** for v1; the field exists so agents and conformance can rely on a stable wire shape and future wiring without a schema bump.

### `declaration_peers_unpatched`

**v1:** After resolving the target unit’s **`file_path`**, compute the **same-directory** peer path **`basename.d.ts`** where `basename` is the edited file’s basename **without** the **`.ts`** extension (e.g. `src/foo.ts` → `src/foo.d.ts`). If **`WorkspaceSnapshot.files`** contains that path, set **`declaration_peers_unpatched`** to the sorted list of **all `LogicalUnit.id`** values for units whose **`file_path`** equals that peer path (order: ascending by `unit_id` string). If the peer file is **not** in the snapshot, set **`[]`**. **Never omit** the field.

**Cross-directory or multiple declaration peers** (e.g. `types` packages, composite projects) are **out of scope for v1** — only the single same-directory **`basename.d.ts`** rule above.

### `declaration_peer_unpatched` (spec section 12.1 normative code)

The locked §12.1 table includes a validation **`code`** `declaration_peer_unpatched` (distinct from the **`declaration_peers_unpatched`** field name on `ValidationEntry`). **v1 does not emit** a separate report row with `code: "declaration_peer_unpatched"` — peer awareness is carried **only** via the populated **`declaration_peers_unpatched`** string array on each apply entry (possibly non-empty when a same-directory `*.d.ts` peer is tracked). Emitting the normative **code** as its own `ValidationEntry` for non-empty arrays is **deferred to v2+** unless integrators require redundant branching alongside the field.

---

## Formatter pinning (v1)

**Date (normative for this repo):** 2026-04-13

This section closes the Medium-priority gap **Formatter pinning** from the v1 gap table (spec section 7 vs §12.1 `format_drift`).

### Baseline canonicalization (unchanged)

Snapshot and apply paths still normalize to **LF** only (`\r\n` / `\r` → `\n`) before hash and parse, per **Canonical bytes and line endings** above. That remains the **default** formatter profile behavior.

### Manifest field

Optional object on **`agent-ir.manifest.json`**:

```json
"formatter": { "profile": "lf-only" }
```

or `"profile": "prettier"`. **Default** when the manifest is missing, invalid as JSON (lenient read), or **`formatter` / `profile` is absent:** **`"lf-only"`** — matches historical behavior.

### `format_drift` severity and behavior (reference adapter)

The locked spec §12.1 lists `format_drift` as **E** in the portable table; **this repo’s reference adapter treats `format_drift` as a **warning** in v1** when the configured profile detects drift — the batch **still succeeds** (no hard reject). Rationale: v1 does not run a full pinned formatter binary; emitting **warning**-level drift preserves auditability without blocking edits under partial formatter integration.

**`lf-only` profile:** Drift is detected if post-canonicalization source still contains **`\\r\\n`** or standalone **`\\r`** (internal consistency / unexpected bytes). If so, emit one **`format_drift`** warning entry per affected check (see apply implementation). Normal LF-only content after canonicalization does **not** drift.

**`prettier` profile (v1 stub):** The adapter **does not** invoke the Prettier CLI or API. **`checkFormatDrift`** does not report byte drift; it returns a documented **non-drift** result with reason **`prettier_not_wired_v1`** so callers can tell the profile is active but not enforced. **No silent success** when operators explicitly select `prettier` — see **`lang.ts.formatter_prettier_stub_v1`** below.

### `lang.*` extensions (formatter)

| Code | Severity | Meaning |
| ---- | -------- | ------- |
| `**lang.ts.formatter_prettier_stub_v1**` | **warning** | `**formatter.profile**` is **`prettier`** but Prettier is not wired in v1 — no format round-trip check. Emitted **at most once per successful batch** (first mutating op). Evidence may include `{ reason: "prettier_not_wired_v1" }`. |

### Known limitations (v1)

- **Prettier binary / library integration** is **not** wired; **`prettier`** profile is explicitly stubbed as above.
- **`format_drift` as error (spec table E)** is **not** implemented for v1 in this repo; consumers that require reject-on-drift must enforce policy outside the adapter or wait for a future version that runs a pinned formatter and upgrades severity.


---

## Expanded benchmark (v1)

**Date:** 2026-04-13

### Repo selection (three repos)

| Repo | Pin file | Role / diversity |
| ---- | -------- | ---------------- |
| **Zod** (existing) | `packages/ab-harness/.pinned-rev` | Mid-sized **TypeScript** monorepo baseline; Tree-sitter units; no change to the classic Zod harness profile. |
| **Prettier** | `packages/ab-harness/.pinned-rev-prettier` | Large **TypeScript** ecosystem (formatter, plugins, generated output). Exercises **format_drift** / provenance / generated-file story against real layout. **Pinned:** `https://github.com/prettier/prettier` at `refs/heads/main` tip at implementation time (`git ls-remote … HEAD`). |
| **Ruff** | `packages/ab-harness/.pinned-rev-ruff` | **Rust** repo with abundant **Python** sources; benchmark samples **`.py` files only**. **Pinned:** `https://github.com/astral-sh/ruff` at `refs/heads/main` tip at implementation time. |

**Clone caches (gitignored):** `.cache/ab-target/` (Zod), `.cache/ab-prettier/`, `.cache/ab-ruff/`.

**Not in this benchmark:** the tRPC demo profile remains **unchanged** (hand-authored tasks); expanded runs **Zod + Prettier + Ruff** only.

### Python grammar stub (Ruff only)

- **Location:** `packages/ts-adapter/src/grammars/python-stub.ts`.
- **Behavior:** Regex-based detection of **top-level** `def` / `class` blocks (column 0); **not** Tree-sitter, **not** production quality.
- **`grammar_digest`:** SHA-256 (hex, lowercase) of the UTF-8 source of that file **after removing** the `PYTHON_STUB_GRAMMAR_DIGEST` export block, so the pin does not recurse on the hex string. Documented as **stub** behavior; full Python adapter is **out of scope**.
- **IR path:** Harness applies splices / scoped rename, then re-materializes stub snapshots. **Every** successful stub `ValidationReport` path is expected to carry **`parse_scope_file`** (honest file-only scope — no cross-file or parser guarantee).
- **Logical unit kinds** for Python align with sampler vocabulary: `function_declaration` (from `def`), `class_declaration` (from `class`).

### Seeded sampling

- **Seed:** `42` (checked in, `BENCHMARK_SEED` in `packages/ab-harness/src/sample-tasks.ts`).
- **PRNG:** **mulberry32** (integer seed → uniform float in `[0,1)`); no `Math.random()` / `Date.now()` in sampling.
- **Per repo:** up to **20** tasks: **12** `replace_unit`, **8** `rename_symbol` (if fewer eligible units exist, all are used; replace/rename split keeps the 12:8 proportion via `ceil`/`floor` on the actual count).
- **Eligible units:** Tree-sitter snapshot: `function_declaration` only (adapter does not emit top-level `class_declaration` in TS). Python stub: `function_declaration` and `class_declaration`.
- **Shuffle:** Fisher–Yates with the seeded PRNG; deterministic for a fixed seed + pin.
- **Rename homonym:** Resample up to **3** times per rename task to prefer a symbol whose name appears inside a **string literal or comment** (heuristic scanner for `//`, `/* */`, `#`, single/double quotes, and backticks). **`has_homonym`** recorded on `TaskDescriptor`.
- **Artifacts:** `ab-tasks-<repo>.json` (e.g. `ab-tasks-zod.json`) next to metrics — **reproducibility record** (same seed + pin ⇒ same task list).

### Baseline scripted edits

- **`replace_unit`:** Naive splice at snapshot byte offsets; **30%** of replace tasks (deterministic seeded draw) use an **off-by-one** on the closing `}` (TypeScript) or truncated stub (Python) to induce **parse failures** where applicable.
- **`rename_symbol`:** Global `\b` regex replace of the symbol in the **full file** (brittle; may hit string literals).

### Metric additions

- **`task_category`:** `replace_unit` \| `rename_symbol`.
- **`repo`:** short id (`zod`, `prettier`, `ruff`).
- **`language`:** `typescript` \| `python_stub`.
- **`false_positive_count` (per task row):** Count of outcomes where the edit **did not** fail the cheap parse/stub check but is **semantically wrong** (e.g. baseline rename corrupted a string-literal homonym; baseline replace parsed but wrong shape). **IR path:** expected **0** everywhere; if not, treat as a harness bug.
- **Aggregate `ci_95_lower` / `ci_95_upper`:** **Wilson score interval** (95%, \(z = 1.96\)) on **failed_patch_rate** (proportion of tasks with `failed_patches === 1`) for that **repo + approach** block. **`null`** if \(n < 10\) tasks (implementation: `wilsonCI` in `packages/ab-harness/src/stats.ts`).

**Wilson formula** (for \(k\) failures in \(n\) trials, \(\hat p = k/n\)):

\[
\frac{\hat p + z^2/(2n) \pm z\sqrt{(\hat p(1-\hat p) + z^2/(4n))/n}}{1 + z^2/n}
\]

### `skipped_files` (repo-level audit)

- **Field:** Each repo block includes **`skipped_files`**: an array of `{ "file_path": "<repo-relative POSIX>", "reason": "parse_throw" }` copied from **`WorkspaceSnapshot.skipped_ts_parse_throw`** on the TypeScript materialization path (same omission list as the adapter). **Python stub** repos use **`[]`** (no Tree-sitter `.ts` parse in that path).
- **Purpose:** Makes parse-throw omissions **auditable** in published metrics instead of only inferring them from missing units.
- **Rationale:** Aligns expanded benchmark transparency with the wire snapshot field without recomputing hashes in the harness.

### `snapshot_incomplete` (IR-only harness classification)

- **Wire:** `ApproachMetrics.failure_reason` may be **`"snapshot_incomplete"`** on the **IR** task row when the benchmark cannot resolve the sampled **`target_unit_id`** because the unit’s source file was **omitted** from the snapshot (see **parse failures** above). This is **not** an IR adapter bug or a normative **`parse_error`** from **`applyBatch`**.
- **Aggregates:** Expanded benchmark **IR** **`failed_patch_rate`**, Wilson bounds, and **`false_positive_count`** sums **exclude** tasks whose IR row has **`failure_reason === "snapshot_incomplete"`** (denominator = tasks remaining after exclusion). Baseline aggregates are unchanged (those tasks still count as **`unit_not_found`** failures where applicable).
- **Published results:** Do **not** treat **`snapshot_incomplete`** as evidence against the IR path — it is a **harness / materialization artifact** when a pinned monorepo hits Tree-sitter limits. **`prettier_rep_02`** is the canonical example at the Prettier pin.

### Expanded benchmark determinism (v1)

- **`resetGitWorkspace`:** **`git reset --hard HEAD`** then **`git clean -fdx`** on each clone root **before every task** and **once before** the initial **`materializeSnapshot` / `materializePythonStubSnapshot`** used only for **task sampling** in `runExpandedBenchmark` (so the sampled `task_id` / unit list is not affected by leftover state from a prior benchmark or manual edits). **`-x`** removes **gitignored** paths (including **`.cache/blobs`** from adapter materialization); **`clean -fd` alone** leaves those artifacts and can leak state across tasks.
- **Baseline “bad brace” draws:** Seeded **`mulberry32`** draws for the **30%** off-by-one replace baseline are **precomputed per replace `task_id`** (fixed count per run), not consumed only when the baseline replace path runs — otherwise early **`continue`** paths shift the PRNG stream and break reproducibility.

### Output

- **`packages/ab-harness/ab-metrics-expanded.json`** — schema `ab-harness.expanded.v2`; per-repo **`skipped_files`**, **`baseline`** and **`ir`** blocks with per-task rows, aggregate rates, Wilson bounds, **`false_positive_count` sums**, and **`human_summary`** (false-positive-led) for relay to Claude.


---

## MCP server (v2)

**Date (normative for this repo):** 2026-04-13

### Transport

**Choice:** **stdio only** (MCP over process stdin/stdout). **No HTTP, no SSE** in this workstream.

**Rationale:** Matches how Cursor, Claude Code, and other hosts already spawn MCP servers as subprocesses; smallest integration surface; no listener ports or auth story required for a first ship.

**Alternatives not used:** Streamable HTTP / SSE transports are deferred until a concrete multi-tenant or remote-host requirement exists.

### Package and binary

| Item | Value |
| ---- | ----- |
| **pnpm package** | `@agent86/mcp-server` at `packages/mcp-server/` |
| **CLI bin** | `agent86-mcp` → `dist/index.js` (Node entry; stdio transport) |

**Dependencies (normative):** `@modelcontextprotocol/sdk`, workspace `ts-adapter`, **`zod`** for tool argument validation at the MCP boundary.

### Tool surface (five tools)

All tools are registered on the MCP server; each delegates to the reference **`ts-adapter`** APIs. JSON shapes use **snake_case** field names at the MCP tool boundary for consistency with wire types in `WorkspaceSnapshot` / `ValidationReport`.

| Tool | Input (summary) | Output | Adapter calls |
| ---- | ----------------- | ------ | ------------- |
| **`materialize_snapshot`** | `root_path`, optional `inline_threshold_bytes` | Full **`WorkspaceSnapshot`** JSON | `materializeSnapshot({ rootPath, inlineThresholdBytes, … })` |
| **`list_units`** | `root_path`, optional `file_path` (repo-relative POSIX filter) | **`LogicalUnit[]`** | `materializeSnapshot` then filter `snapshot.units` by `file_path` when set; **sort** by `file_path` then `start_byte` |
| **`build_workspace_summary`** | `root_path` | **`WorkspaceSummary`** | `materializeSnapshot` then `buildWorkspaceSummary` |
| **`apply_batch`** | `root_path`, `snapshot`, `ops`, optional `toolchain_fingerprint_at_apply` (**`AdapterFingerprint`** object) | **`ValidationReport`** | `applyBatch({ snapshotRootPath, snapshot, ops, toolchainFingerprintAtApply, … })` — fingerprint serialized to a stable JSON string when provided; when omitted, the server uses the snapshot header’s adapter fingerprint JSON |
| **`get_session_report`** | *(none — empty object on the wire)* | Session tally JSON (see **get_session_report tool (v2)**) | *(read-only; no adapter call)* |

**Why `list_units` exists:** `materialize_snapshot` returns the full snapshot (large). Agents that only need Tier I addresses for op construction should not be forced to download and parse the entire snapshot first. **`list_units`** is a thin read helper: one root path, optional file filter, deterministic unit ordering — enough to discover **`target_id`** values before calling **`apply_batch`** with a snapshot the agent already holds (from a prior materialize or from its own cache).

### Error handling policy

1. **Normative adapter outcomes (`ValidationReport`):** Conditions that the reference adapter already expresses as **`ValidationReport`** with spec **section 12.1** codes (and `lang.*` per 12.2) — e.g. **`grammar_mismatch`**, **`batch_size_exceeded`**, **`unknown_or_superseded_id`**, **`snapshot_content_mismatch`**, apply-time gates — MUST be returned as **normal tool success** payloads containing the **`ValidationReport`** JSON ( **`outcome`**, **`entries[].code`**, etc.). Hosts MUST NOT treat these as MCP transport-level failures when the tool ran successfully.

2. **MCP tool error (`isError` / tool error result):** Used for **non-adapter-contract** failures: invalid tool arguments (Zod), I/O or unexpected throws, missing directories when the tool requires a readable root, etc. Where there is **no applicable §12.1 code**, responses use a stable **integration subcode** such as **`lang.agent86.invalid_tool_input`** or **`lang.agent86.internal_error`** with structured **`evidence`** (never prose-only branching for programmatic handling).

3. **Unhandled exceptions** inside a tool handler: catch, return an MCP tool error with **`lang.agent86.internal_error`**, and put **`message`** and **`stack`** (when available) in **`evidence`** for operator debugging.

### `lang.*` extensions (MCP server bridge)

These codes are emitted by **`@agent86/mcp-server`** on the **MCP tool boundary** (tool result **`isError: true`**, JSON body in text content). They are **not** **`ValidationReport.entries[].code`** values; they signal argument/shape failures or unexpected handler errors before a normative adapter report is produced.

| Code | Severity | Meaning |
| ---- | -------- | ------- |
| **`lang.agent86.invalid_tool_input`** | error (tool error) | Zod validation failed, **`WorkspaceSnapshot` / `ops` shape guard** failed, or otherwise malformed tool arguments at the MCP layer. **`evidence`** includes Zod **`issues`** or a **`field`** hint. |
| **`lang.agent86.internal_error`** | error (tool error) | Uncaught exception in a tool handler. **`evidence.stack`** (when available) and **`message`** aid operators; not a spec section 12.1 adapter outcome. |
| **`lang.agent86.snapshot_cache_miss`** | error (tool error) | **`apply_batch`** was called with **`snapshot_id`** but no file exists at **`<root_path>/.agent86/snapshots/<snapshot_id>.json`** (cache never written, deleted, or wrong root). Message instructs the operator to **re-run materialize_snapshot to rebuild cache** (exact normative phrase in handler text). |

### Known limitations (this session)

- **Historical note — Python in MCP:** An earlier draft said **`py-adapter`** was not wired; that is **obsolete**. **`py-adapter`** and **`js-adapter`** are both wired for mixed-language roots — see **MCP mixed-language routing (v2)** below.

- **No authentication, no rate limiting** — local stdio trust model only.

## Snapshot-by-reference cache (MCP server, v2.2)

**Date (normative for this repo):** 2026-04-16

**Problem:** MCP tool arguments cannot reliably round-trip multi-megabyte **`WorkspaceSnapshot`** JSON; agents that only hold **`snapshot_id`** from **`materialize_snapshot`** must not be forced to paste the full snapshot into **`apply_batch`**.

**Cache path (normative):** **`<root_path>/.agent86/snapshots/<snapshot_id>.json`** (UTF-8 JSON file; one file per combined snapshot id).

**Write:** On every **successful** **`materialize_snapshot`** completion, the MCP server writes the combined snapshot JSON to that path (after **`materializeCombinedSnapshot`** succeeds). Failure to write is **non-fatal** for the tool result (logged to stderr; the tool still returns the snapshot payload).

**Read:** **`apply_batch`** accepts either the full **`snapshot`** object (backward compatible) **or** **`snapshot_id`** (string). When **`snapshot_id`** is provided, the server loads the snapshot from the cache file above; **exactly one** of **`snapshot_id`** or **`snapshot`** must be supplied.

**Cache miss:** If the file is missing or not valid JSON, the tool returns an MCP tool error with code **`lang.agent86.snapshot_cache_miss`** (error severity). The **`message`** states that the snapshot was not found in cache and that the operator should **re-run materialize_snapshot to rebuild cache** (and retry **`apply_batch`** with the new id).

**Eviction:** **None in v2.2** — cache files are not deleted automatically; operators may delete **`.agent86/`** manually.

**Repo hygiene:** **`.agent86/`** is listed in the **repository** **`.gitignore`** so local caches are not committed; consumers should add the same ignore rule in application repos that use the MCP server.

## Multi-op batch ordering within a file (normative)

**Date (normative for this repo):** 2026-04-16

**Rule:** When multiple ops in a **single** **`apply_batch`** target logical units in the **same** source file, those ops **MUST** be ordered by **descending `start_byte`** for that file (edit **lower** positions in the file **first** — larger **`start_byte`** earlier in the op list).

**Rationale:** **`replace_unit`** splices bytes in canonical LF source. Each splice shifts byte offsets for units **below** the edited span. Snapshot **`start_byte` / `end_byte`** are **pre-splice** coordinates; applying a higher span first invalidates ids/offsets for lower spans.

**Adapter behavior:** The reference adapters **do not** auto-sort multi-op batches. **Caller’s responsibility** to order ops correctly.

**Failure mode:** If ops are mis-ordered, a later op may hit **`unknown_or_superseded_id`** (or equivalent) on the first op that no longer resolves after an earlier splice — treat ordering violations as caller errors, not adapter bugs.

**MCP tool copy:** The **`apply_batch`** tool description includes a one-sentence reminder to order same-file ops by descending **`start_byte`**.

## Python adapter (v2)

**Date (normative for this repo):** 2026-04-13

Workstream 2 of the v2 cycle: a real Python tree-sitter adapter (`packages/py-adapter/`) that replaces the regex stub used in the expanded benchmark for Ruff tasks. The adapter is a **drop-in compatible** replacement for `ts-adapter`'s public surface — same exported interface, same normative `ValidationReport` codes, same §9 gate sequence.

### Package identity

- **Package name:** `@agent86/py-adapter`
- **Location:** `packages/py-adapter/` (pnpm workspace member)
- **Dependencies:** `tree-sitter@0.21.1` (peer-pinned via workspace; same native binding version as `ts-adapter`), `tree-sitter-python@0.21.0`

**Binding choice:** The adapter uses the native Node.js `tree-sitter@0.21.1` bindings (the same module already installed for `ts-adapter`) rather than `web-tree-sitter`. Rationale: native bindings are already pinned and tested in this workspace; `web-tree-sitter` adds async WASM initialization complexity with no benefit in a server-side Node.js context. The grammar digest discipline (SHA-256 of the artifact) is identical regardless.

### Grammar digest (py-adapter, normative)

**Artifact:** SHA-256 (lowercase hex) of the file `src/parser.c` as installed from the pnpm-lockfile-pinned npm package `tree-sitter-python@0.21.0`. Same discipline as `ts-adapter`'s `GRAMMAR_DIGEST_V0`.

**Pinned npm version:** `tree-sitter-python@0.21.0`

**Checked-in constant:** `PY_GRAMMAR_DIGEST` in `packages/py-adapter/src/grammar.ts`

**Computed digest:** `00461a24da2781da9be50b547f1710f9d22c3da102c60f250d8668fd46166191` — confirmed by running `computePyGrammarDigestFromArtifact()` against the installed `src/parser.c` at `tree-sitter-python@0.21.0_tree-sitter@0.21.1`.

**Gate discipline:** Same as ts-adapter:
1. `assertPyGrammarDigestPinned()` — on-disk `src/parser.c` from installed `tree-sitter-python` must match `PY_GRAMMAR_DIGEST` before any apply.
2. `snapshot.grammar_digest === PY_GRAMMAR_DIGEST` — snapshot header must match; else `grammar_mismatch`.

**Bump triggers (normative for py-adapter):** Same as ts-adapter triggers documented above (lockfile version change; artifact path change; intentional grammar bump; local path overrides).

### LogicalUnit kinds for Python (v1)

| Kind | Tree-sitter node | Scope |
| ---- | ---------------- | ----- |
| `function_definition` | `function_definition` | Top-level **and** direct child of a class `block` (methods, including `async def`) |
| `class_definition` | `class_definition` | Top-level only |

**Note on `async def`:** In `tree-sitter-python@0.21.0`, `async def foo():` parses as a `function_definition` node with an `async` keyword child — there is **no** separate `async_function_definition` node type in this grammar version. Both `def` and `async def` are `function_definition` and are collected identically.

**Rationale:** These two kinds cover the primary patch targets in real Python repos. Methods (function/async inside a class body) are direct children of the class `block` node — not nested arbitrarily — so depth-limited detection is unambiguous. Inner functions (closures, nested defs inside methods) are **not** Tier I units in v1; they fall below the top-level or class-method boundary. This is consistent with ts-adapter's choice of `function_declaration` and `method_definition` as the unit boundary.

**Unit id formula:** Same as ts-adapter — SHA-256 of `|`-joined string: `grammarDigest | snapshotRootResolved | filePathPosix | startByte | endByte | kind`.

**Wire kind strings:** `function_definition`, `class_definition` — these are the values in `LogicalUnit.kind` and `ExtractedUnitSpan.kind` for the py-adapter. The py-adapter defines its own types module; no shared kind union with ts-adapter.

### rename_symbol scope (py-adapter, v1)

- **Same-file scope:** Walk file AST; rename `identifier` nodes matching the old name within the declaration's scope.
- **Homonym prevention:** Occurrences inside `string` (single/double quoted), `comment`, and f-string content nodes are **skipped** with a stable reason code. Same false-positive prevention discipline as ts-adapter.
- **`cross_file: true`:** Scan all other tracked `.py` files; skip string and comment contexts; emit `lang.py.cross_file_rename_broad_match` warning when `found > 10`.
- **`id_resolve_delta`:** Empty on successful rename (unit ids are name-independent).
- **Emit `rename_surface_report`** on every successful rename.
- **Emit `rename_surface_skipped_refs`** warning when `skipped.length > 0`.

### move_unit scope (py-adapter, v1)

- **Cross-file only.** Same-file reorder is rejected with `lang.py.move_unit_same_file`.
- **Import rewriting:** Out of scope. Same as ts-adapter v1 — callers must update imports after a move.
- **Name conflict:** Destination file already contains a unit with the same declared name → reject with `lang.py.move_unit_name_conflict`.
- **Atomicity:** Same process-lifetime backup/restore model as ts-adapter.

### `lang.*` extensions (py-adapter)

| Code | Severity | Meaning |
| ---- | -------- | ------- |
| `lang.py.rename_unsupported_node_kind` | error | Target unit's kind is not `function_definition` or `class_definition`. |
| `lang.py.cross_file_rename_broad_match` | warning | cross_file rename matched many name occurrences in Python source (default threshold: 10); review all touched files before commit — many may be false positives. |
| `lang.py.move_unit_name_conflict` | error | Destination file already has a unit with the same declared name. |
| `lang.py.move_unit_same_file` | error | destination_file equals the source file (same-file reorder out of scope). |

### §9 apply-time gates (py-adapter)

Same sequence as ts-adapter:
1. `assertPyGrammarDigestPinned()` — on-disk `src/parser.c` matches `PY_GRAMMAR_DIGEST`
2. `snapshot.grammar_digest === PY_GRAMMAR_DIGEST`
3. `snapshot.adapter` matches `PY_ADAPTER_FINGERPRINT`
4. `ops.length <= max_batch_ops` (50)
5. On-disk SHA-256 of canonical LF bytes matches `WorkspaceSnapshot.files[].sha256` for all tracked `.py` files

### Benchmark integration

After py-adapter is green (all 8+ conformance tests pass):
- Update `packages/ab-harness/src/run-expanded.ts` to use `py-adapter`'s `materializeSnapshot` and `applyBatch` for Ruff tasks; remove Python stub import for Ruff.
- Re-run `pnpm ab:bench:expanded` three consecutive times with the same seed (42).
- Confirm IR false positives still 0 across all three runs.
- Task counts for Ruff may change (real grammar detects more method-level units than top-level-only stub) — expected and honest; document the change in the commit message.
- If IR false positives > 0: stop and report to human before committing. Do not commit a degraded artifact.
- Updated canonical artifact: `packages/ab-harness/ab-metrics-expanded.json` with `language: "python"` for Ruff tasks (replacing `python_stub`).

---

## MCP mixed-language routing (v2)

**Date (normative for this repo):** 2026-04-14 (updated 2026-04-14 — JavaScript routing)

### Routing rule

**Extension only — no content sniffing, no shebang detection.** The MCP server decides which reference adapter materializes or applies to a path using the filename only (POSIX path semantics after normalizing separators).

| Extension | Adapter |
| --------- | ------- |
| **`.ts`** (but not **`.tsx`**) | `ts-adapter` |
| **`.py`** | `py-adapter` |
| **`.js`**, **`.mjs`**, **`.cjs`** | `js-adapter` (`@agent86/js-adapter`) |

**`.tsx`:** Unchanged — never parsed as TypeScript by `ts-adapter`; paths are listed in **`skipped_tsx_paths`** on the TypeScript materialization leg only.

**`.jsx`:** Never parsed as plain JavaScript by `js-adapter`; paths are listed in **`skipped_jsx_paths`** on the combined **`WorkspaceSnapshot`** (from the js-adapter materialization leg). See **JavaScript adapter (js-adapter, v1)** below.

**Unsupported paths:** If a tool must route a concrete path (e.g. optional **`file_path`** on **`list_units`**, or a **`LogicalUnit.file_path`** for an op target) and the extension is not routable (**`.ts`**, **`.py`**, **`.js`**, **`.mjs`**, **`.cjs`**), the MCP tool boundary returns **`isError: true`** with code **`lang.agent86.unsupported_file_extension`**. The **`message`** lists supported extensions **`.ts`**, **`.py`**, **`.js`**, **`.mjs`**, and **`.cjs`**.

### Combined snapshot shape (MCP wire)

A single invocation still returns **one** JSON object shaped like **`WorkspaceSnapshot`**, with these **MCP v2 extensions**:

1. **`grammar_digests`:** **`{ "ts": "<hex>", "py": "<hex>", "js": "<hex>" }`** — always present on **`materialize_snapshot`** and **`build_workspace_summary`** from this server. Values are the pinned constants (**`GRAMMAR_DIGEST_V0`**, **`PY_GRAMMAR_DIGEST`**, **`JS_GRAMMAR_DIGEST`**) for each adapter.

2. **`grammar_digest` (singular, backward compatibility):** **`grammar_digests.ts`** when **`files[]`** includes any **`.ts`** path; else **`grammar_digests.py`** when any **`.py`**; else **`grammar_digests.js`** when any **`.js` / `.mjs` / `.cjs`**; else nominal **`grammar_digests.ts`**. Prefer **`grammar_digests`** for new integrations.

3. **`units[]` ordering:** **ts-adapter** units first, then **py-adapter**, then **js-adapter** (each in that adapter’s deterministic order). **`files[]`** is the **sorted union** of all three adapters’ **`files[]`**.

4. **`snapshot_id` (combined):** Let **`ts_id`**, **`py_id`**, and **`js_id`** be each adapter’s standalone **`snapshot_id`** for the same root and options. Sort the three strings lexicographically (UTF-8), join with **`\n`** between consecutive strings (no trailing newline), UTF-8-encode, **`combined_snapshot_id = SHA-256`** (lowercase hex).

5. **`id_resolve`:** Shallow merge **`{ ...ts, ...py, ...js }`** (disjoint keys in normal operation).

6. **`skipped_tsx_paths`:** From **ts-adapter** only.

7. **`skipped_jsx_paths`:** From **js-adapter** leg only (sorted).

8. **`skipped_ts_parse_throw`:** Concatenation of all three adapters’ lists, sorted by **`file_path`**.

9. **`adapter` (combined header fingerprint):** **`V0_ADAPTER_FINGERPRINT`** if any **`.ts`** file; else **`PY_ADAPTER_FINGERPRINT`** if any **`.py`**; else **`JS_ADAPTER_FINGERPRINT`** if any **`.js` / `.mjs` / `.cjs`**; else **`V0_ADAPTER_FINGERPRINT`** (empty default).

### `apply_batch` dispatch (MCP)

Owning adapter from **`file_path`**: **`.ts`** → ts-adapter, **`.py`** → py-adapter, **`.js` / `.mjs` / `.cjs`** → js-adapter. Ops are partitioned into **three** batches. **Call order:** **ts-adapter** **`applyBatch`**, then **py-adapter**, then **js-adapter** (each skipped if empty).

**`ValidationReport` merge:** **`entries`** concatenated in that same order. **`id_resolve_delta`** shallow-merged (**js** keys last). **`next_snapshot_id`:** after **all invoked** adapter calls succeed, the server re-materializes the combined snapshot; on any failure **`next_snapshot_id`** is **`null`**.

Subset snapshots, unknown targets, **`ghost_unit`**, and **`max_batch_ops`** semantics are unchanged from the prior two-adapter description.

### Cross-adapter atomicity (known limitation)

There is **no** cross-adapter rollback across the three batches. If an earlier language batch succeeds and a later one **fails**, disk may reflect partial writes. Full atomicity across languages is **out of scope**.

### Tier I `target_id` collision guarantee

Distinct per-language **`grammar_digest`** constants (**ts**, **py**, **js**) plus **`file_path`** in the unit id preimage prevent cross-language id collisions. See **JavaScript adapter (js-adapter, v1)** for the js-adapter preimage shape.

### `lang.*` extension (MCP tool boundary)

| Code | Severity | Meaning |
| ---- | -------- | ------- |
| **`lang.agent86.unsupported_file_extension`** | error (tool error) | Path extension is not routable; **`evidence.supported_extensions`** lists **`.ts`**, **`.py`**, **`.js`**, **`.mjs`**, **`.cjs`**. |

### `list_units`

**No handler shape change required:** **`list_units`** continues to materialize internally and return **`snapshot.units`** with the same sort rule. After **`materialize_snapshot`** uses the combined builder, **`list_units`** automatically returns the **union** of units (subject to optional **`file_path`** filter).

**Note:** **`list_units`** with **`file_path`** set validates the filter path with the same extension routing; unsupported extensions fail at the tool boundary with **`lang.agent86.unsupported_file_extension`**.

---

## JavaScript adapter (js-adapter, v1)

**Date (normative for this repo):** 2026-04-14

### Package identity

| Item | Value |
| ---- | ----- |
| **Package name** | `@agent86/js-adapter` |
| **Location** | `packages/js-adapter/` |
| **Adapter fingerprint** | `name: "js-adapter"`, `semver: "0.0.0"` (see `JS_ADAPTER_FINGERPRINT` in `packages/js-adapter/src/snapshot.ts`) |
| **Dependencies** | `tree-sitter@0.21.1`, `tree-sitter-javascript@0.23.1` (same native binding major as other adapters) |

### Grammar digest (normative)

**Artifact:** SHA-256 (lowercase hex) of the file **`src/parser.c`** from the pnpm-lockfile-pinned npm package **`tree-sitter-javascript@0.23.1`**.

**Strategy:** Identical to **`ts-adapter`** / **`py-adapter`**: hash the **on-disk parser source bytes** at the resolved install path — **not** the npm version string alone.

**Checked-in constant:** `**JS_GRAMMAR_DIGEST**` in `**packages/js-adapter/src/grammar.ts**`.

**Computed digest (verified once against installed artifact):** `**1150721590eca3c7b6623c7dc3498184f3e22c5d895a08b4806ebf5804f817c3**` — from  
`node_modules/.pnpm/tree-sitter-javascript@0.23.1_tree-sitter@0.21.1/node_modules/tree-sitter-javascript/src/parser.c`  
(resolution path may vary with pnpm layout; `**computeJsGrammarDigestFromArtifact()**` resolves via `**tree-sitter-javascript/package.json**`).

**Bump policy:** Same triggers as documented for **`GRAMMAR_DIGEST_V0`** / **`PY_GRAMMAR_DIGEST`** (lockfile version change, artifact path change, overrides, etc.).

### LogicalUnit kinds (v1, conservative)

| Wire `kind` | Tree-sitter / rule | Rationale |
| ----------- | ------------------ | --------- |
| `**function_declaration**` | `function_declaration` at **program** scope (including under `export_statement` declaration) | Top-level named functions; primary patch target. |
| `**class_declaration**` | `class_declaration` at program scope (including exported) | Top-level classes. |
| `**method_definition**` | `method_definition` direct children of a class `**class_body**` | Instance/static methods inside class bodies. |
| `**arrow_function**` | `**variable_declarator**` whose `**value**` child is an `**arrow_function**`, when the declarator appears in a **top-level** `**lexical_declaration**` or `**variable_declaration**` (direct program statement or inside `**export_statement**` wrapping that declaration) | Captures common `const foo = () => {}` module pattern at Tier I without walking nested function bodies. **Not** extracted for arrow functions nested inside other functions or non–top-level blocks (`if`, loops, etc.) — judgment call for v1 to avoid closure noise. |

**Out of scope v1:** `**export default**` anonymous `function_expression` / `class` / `arrow_function` (different AST shapes); inner functions; **`.jsx`** (see below).

### File extensions

**In scope:** **`.js`**, **`.mjs`**, **`.cjs`** — walked, parsed, and materialized like other adapters.

**Explicitly skipped — `.jsx`:** Same rationale as **`.tsx`** vs plain TypeScript: JSX is a **superset** surface and would require a different grammar / digest contract. Every materialization discovers **`.jsx`** files under the root (excluding `**node_modules**`) and records each path in **`WorkspaceSnapshot.skipped_jsx_paths`** (repo-relative POSIX, sorted) on the **js-adapter** snapshot wire shape, analogous to **`skipped_tsx_paths`** on **`ts-adapter`**. Parsing `.jsx` with the plain JavaScript grammar is **forbidden**.

### `lang.js.*` codes (normative for js-adapter)

| Code | Severity | Meaning |
| ---- | -------- | ------- |
| `**lang.js.cross_file_rename_broad_match**` | warning | Same semantics as **`lang.ts.cross_file_rename_broad_match`** / **`lang.py.cross_file_rename_broad_match`**: `**cross_file: true**` rename and `**rename_surface_report.found**` strictly greater than the default threshold (**10**). |
| `**lang.js.move_unit_name_conflict**` | error | Destination file already contains a logical unit with the same declared name. |
| `**lang.js.move_unit_same_file**` | error | `**destination_file**` equals the source file (same-file reorder out of scope). |
| `**lang.js.rename_unsupported_node_kind**` | error | Target unit kind is not one of the supported rename/move kinds for v1 (`**function_declaration**`, `**class_declaration**`, `**method_definition**`, `**arrow_function**`). |

### Tier I id collision across adapters

Unit ids are SHA-256 over a pipe-delimited preimage that includes **`grammarDigest`**, resolved snapshot root, **`file_path`**, byte range, and **`kind`** (same shape as **`py-adapter`** `**computeUnitId**`). Distinct grammar digest constants (**`GRAMMAR_DIGEST_V0`**, **`PY_GRAMMAR_DIGEST`**, **`JS_GRAMMAR_DIGEST`**) plus **unique repo-relative paths per file** ensure **`.ts`**, **`.py`**, and **`.js`** / **`.mjs`** / **`.cjs`** unit ids do not collide within one workspace root.

### get_session_report tool (v2)

**Date (normative for this repo):** 2026-04-14

- **Session state scope:** Tallies are **process-lifetime** only. Each MCP server OS process starts with zeroed counters (except **`session_start_iso`** set at process start). **Restarting the server** clears all tallies — there is **no** disk persistence.

- **`false_positives_prevented` (normative definition):** The count of **`apply_batch`** invocations that returned **`ValidationReport.outcome === "failure"`** where **at least one** `entries[]` item has **`severity: "error"`**. Each such invocation is one batch the IR **blocked before writing** (no successful adapter commit for that batch outcome) — the closest measurable proxy for “corruption prevented.” This definition is **conservative** (it does not count batches that failed only with warnings or info rows) and **honest** (it does not claim to know what a baseline agent would have written without the IR).

- **No persistence rationale:** The server uses **stdio**; typical hosts (e.g. Cursor) spawn **one process per editor session**. Process exit is the natural reset boundary; persisting tallies would not reflect “session” semantics and would add sync and privacy concerns without a stated product requirement.

- **Wire schema:** Tool name **`get_session_report`**. Arguments are the **empty object `{}`** on the MCP tool boundary (**snake_case** field names on other tools remain unchanged). The tool result is **JSON text** mirroring the in-memory **`SessionState`** object (same snake_case keys as the wire tally), including **`js_units_seen`** (count of logical units whose **`file_path`** ends with **`.js`**, **`.mjs`**, or **`.cjs`** after each **`materialize_snapshot`**).
