# Agent IR v0 — TypeScript Reference Adapter, Conformance, and A/B Harness

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a v0 **TypeScript reference adapter** (Tree-sitter) that materializes snapshots, assigns stable **Tier I** unit ids, applies **`replace_unit`** and **`rename_symbol`**, emits **§5.1 `ValidationReport`**, passes **conformance goldens** (template literals + decorators), and runs an **A/B harness** (baseline string-edit loop vs IR-backed loop) on a **mid-sized OSS TypeScript monorepo** with published metrics.

**Architecture:** Single **pnpm/npm workspace** with three packages: **`ts-adapter`** (library + CLI entry for snapshot/apply), **`conformance`** (golden fixtures + runner that asserts parse-stable ids and `ValidationReport` shape), **`ab-harness`** (clones or submodules a pinned OSS repo, runs two agent loops against the same tasks, records failed patch rate / full-file reads / round trips to green). Snapshot materialization walks TS sources with **tree-sitter-typescript**, defines **LogicalUnit** as top-level function-like declarations (v0 scope), builds **content-addressed snapshot id** and **`id_resolve`**. Apply path runs **§9 grammar-digest gate** then expands ops to edits, re-parses, emits report. **§16 open items** (manifest URL shape, full op schema beyond v0 subset, extended golden list, exact repo) are **decided in-repo during implementation** and documented in `docs/` or package README—not spec blockers.

**Tech stack:** Node 22+, TypeScript 5.x, **tree-sitter** + **tree-sitter-typescript** (or `web-tree-sitter` WASM if native binding friction), **Vitest** (or `node:test`) for conformance, **pnpm** workspaces. Optional **tsc** for optional validation entries later; v0 can be parse-only for `replace_unit`/`rename_symbol` expansion.

**Spec anchor:** [docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md](../specs/2026-04-12-agent-ir-and-ai-language-design.md)

**Risk to instrument (§9):** Same **`grammar_digest`**, different **`adapter.name`/semver**—goldens and CI MUST pin **`AdapterFingerprint`** on snapshots and reject fingerprint drift even when digest matches, or explicitly document when digest-only snapshots are used for local dev.

**Amendments (pre-scaffold, 2026-04-12 — resolve before costly rework):**

1. **`grammar_digest` is pinned to one algorithm** before Task 2 writes code (see Task 2): hash of **tree-sitter-typescript** WASM **or** `parser.c` at a **pinned npm version**, constant checked into repo—not npm version string alone.
2. **Snapshot determinism + id semantics** are tested in conformance (Task 8) and documented in **`units.ts`** header (Task 3); includes re-snapshot after edit behavior for ids.
3. **A/B baseline must be designed to fail** sometimes: failure scenarios documented in **`packages/ab-harness/README.md`** before Task 9 Step 3 (any harness code).
4. **`manifest_url: string | null`** on **`WorkspaceSummary`** (Task 4); Task 10 resolves the file/URL and summary emits it on the read path.

**Execution order note:** Tasks **0** and **1** proceed unchanged. Tasks **2, 3, 6, 9** incorporate the amendments **before their previous “Step 1”** (new blocking steps inserted as Step 1; renumber subsequent steps).

---

## File structure (target)

| Path | Responsibility |
|------|----------------|
| `package.json` | Workspace root, scripts: `build`, `test`, `conformance`, `ab:bench` |
| `pnpm-workspace.yaml` | `packages/*` |
| `packages/ts-adapter/package.json` | Adapter library |
| `packages/ts-adapter/src/snapshot.ts` | Walk repo, canonical bytes policy hook, compute manifest + `grammar_digest` + `AdapterFingerprint` |
| `packages/ts-adapter/src/units.ts` | Tree-sitter query for logical units; stable id = hash(snapshot_root, file_path, node_range, grammar_digest) v0 |
| `packages/ts-adapter/src/id_resolve.ts` | Flattened map materialization + delta from `rename_symbol` / future `move_unit` |
| `packages/ts-adapter/src/ops/replace_unit.ts` | Replace body or whole unit text; re-parse; reject on parse_error |
| `packages/ts-adapter/src/ops/rename_symbol.ts` | Scoped rename within file (v0: same-file symbol only to bound scope) |
| `packages/ts-adapter/src/apply.ts` | Batch apply, §9 gate, atomic default, `ValidationReport` builder |
| `packages/ts-adapter/src/report.ts` | `ValidationReport` / `ValidationEntry` types mirroring spec §5.1 |
| `packages/ts-adapter/src/summary.ts` | `WorkspaceSummary` builder: `max_batch_ops`, **`manifest_url`** (`string \| null`, §6 read path), §6.1 policy field (default `error`) |
| `packages/conformance/fixtures/*.ts` | Golden sources: **template-literal** stress, **decorator** stress |
| `packages/conformance/src/golden.test.ts` | Determinism golden (double snapshot), template/decorator tests, **edit-shift id** assertions |
| `packages/ab-harness/src/baseline.ts` | Naive read-modify-write (whole file or string replace) |
| `packages/ab-harness/src/ir-loop.ts` | summary → units → ops via adapter |
| `packages/ab-harness/src/metrics.ts` | Counters + JSON artifact |
| `packages/ab-harness/README.md` | **Before harness code:** baseline vs IR **failure scenarios** for meaningful A/B metrics (Task 9) |
| `docs/impl/v0-decisions.md` | **First entry before Task 2:** locked `grammar_digest` algorithm + bump policy; then §16 resolutions (manifest, repo pin, op schema) |

---

### Task 0: Workspace scaffold

**Files:** Create root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore` (add `vendor/` or `.cache/repos/` for cloned OSS), `packages/ts-adapter`, `packages/conformance`, `packages/ab-harness` with package stubs.

- [ ] **Step 1:** Initialize pnpm workspace; shared `typescript` devDep; `pnpm -r build` passes empty packages.
- [ ] **Step 2:** Create **`docs/impl/v0-decisions.md`** skeleton (title + placeholder sections). **Do not** fill grammar digest yet—that is **Task 2 Step 1** (first entry must land before any `grammar_digest` implementation).
- [ ] **Step 3:** Commit `chore: scaffold agent86 v0 workspace`.

---

### Task 1: Spec-aligned types and report builder

**Files:** `packages/ts-adapter/src/report.ts`, `packages/ts-adapter/src/types.ts`

- [ ] **Step 1:** Define TypeScript interfaces matching spec **§5.1** (`ValidationReport`, `ValidationEntry`, `AdapterFingerprint` with `max_batch_ops`, `OmittedBlob`). Add **`WorkspaceSummary`** type stub including **`manifest_url: string | null`** (filled in Task 4 / Task 10).
- [ ] **Step 2:** Implement `buildFailureReport` / `buildSuccessReport` helpers that always set `toolchain_fingerprint_at_apply`, `snapshot_id`, `entries[]` with normative **codes** from **§12.1** subset (parse_error, grammar_mismatch, batch_size_exceeded, illegal_target_generated, allowlist_without_generator_awareness stub for future).
- [ ] **Step 3:** Unit test: synthetic entry round-trips JSON stringify.

---

### Task 2: Tree-sitter load + grammar digest

**Files:** `packages/ts-adapter/src/parser.ts`, `packages/ts-adapter/src/grammar_meta.ts`, `docs/impl/v0-decisions.md`

**Blocked until:** `v0-decisions.md` contains the **first** subsection (below). No parser/digest code before this lands.

- [ ] **Step 1 (gate):** Write **`docs/impl/v0-decisions.md` — § Grammar digest (v0, normative for this repo)** as the **first** committed decision entry. Lock **one** strategy (no “or” in code):
  - **Recommended (Claude):** `grammar_digest` = **SHA-256** of the **tree-sitter-typescript WASM binary** *or* **`parser.c`** (pick one artifact) **at the pinned npm package version** resolved in lockfile; store the **expected digest constant** in-repo (e.g. `GRAMMAR_DIGEST_V0` in `grammar_meta.ts` generated or hand-verified once per grammar bump).
  - **Explicit non-option:** Do **not** define digest as **npm version string alone**—patch releases can leave grammar behavior unchanged but would invalidate every snapshot.
  - Document **bump policy:** when `tree-sitter-typescript` version changes, re-hash artifact, update constant, changelog entry, and treat as breaking for snapshot compatibility.
- [ ] **Step 2:** Load `tree-sitter-typescript` (tsx grammar for `.tsx` if in scope; v0 may be `.ts` only—document in same `v0-decisions.md` section).
- [ ] **Step 3:** Implement **`grammar_digest`** exactly as documented; CI compares computed artifact hash to checked-in constant (or fails closed).
- [ ] **Step 4:** Test: digest stable across two parser loads in one process; wrong constant → test failure.

---

### Task 3: Snapshot materialization

**Files:** `packages/ts-adapter/src/snapshot.ts`, `packages/ts-adapter/src/units.ts`

- [ ] **Step 1 (contract):** At top of **`units.ts`**, add a **file header comment (normative for implementers)** documenting **Tier I id semantics:**
  - Ids are stable **only within a single materialized `WorkspaceSnapshot`** (spec §4).
  - After **`replace_unit`** (or any edit) and **re-snapshot**, the **edited** unit’s id **MUST change** (byte ranges / AST spans shift).
  - **Untouched** units **above** the edit in the same file **retain** the same ids; units **at or below** the edit **do not** retain ids (offsets shifted)—conformance asserts this (Task 8).
- [ ] **Step 2:** Given root path + glob (`**/*.ts` excluding `node_modules`), build file manifest with per-file SHA-256 (canonical: normalize line endings policy in `v0-decisions.md`—default LF).
- [ ] **Step 3:** Parse each file; assign **LogicalUnit** per **function_declaration** / **method_definition** (v0); compute **opaque id** per formula in code (aligned with header).
- [ ] **Step 4:** Emit `WorkspaceSnapshot` record: `snapshot_id`, `grammar_digest`, `adapter` fingerprint, `files[]`, `units[]`, initial **`id_resolve`** identity map.
- [ ] **Step 5:** Test on tiny in-memory fixture (two functions) → two ids, deterministic `snapshot_id`.

---

### Task 4: WorkspaceSummary (§6 + §6.1)

**Files:** `packages/ts-adapter/src/summary.ts`, `packages/ts-adapter/src/types.ts` (if shared summary type lives there from Task 1)

- [ ] **Step 1:** From snapshot, emit summary: `snapshot_id`, digests, **`max_batch_ops`** (constant e.g. 50 for v0), **`manifest_url: string | null`** (resolved `file:` URL or repo-relative path when manifest exists—**Task 10** wires resolution; **`null`** when absent), **`policies.generated_allowlist_insufficient_assertions: "error"`** default. **Rationale (amendment):** agents discover manifest location on the **same read path** as policy flags, not via a separate ad hoc lookup.
- [ ] **Step 2:** Test: summary JSON includes `manifest_url` (null ok); required policy + `max_batch_ops` present; absent-policy path defaults to `"error"` when field omitted intentionally in fixture—assert adapter apply still treats as error.

---

### Task 5: `replace_unit` op

**Files:** `packages/ts-adapter/src/ops/replace_unit.ts`, `packages/ts-adapter/src/apply.ts`

- [ ] **Step 1:** Define op payload: `{ op: "replace_unit", target_id, new_text }` (JSON shape; full schema deferred to `v0-decisions.md` + JSON Schema file when stable).
- [ ] **Step 2:** Resolve `target_id` via **`id_resolve`**; splice text by byte range from Tree-sitter node; re-parse; on failure emit **`parse_error`** and reject batch.
- [ ] **Step 3:** Success: new file SHA, new `snapshot_id`, **`id_resolve_delta`** empty, **`next_snapshot_id`** set.
- [ ] **Step 4:** Test: replace function body in fixture; snapshot hash changes; tree valid.

---

### Task 6: `rename_symbol` op (v0 bounded)

**Files:** `packages/ts-adapter/src/ops/rename_symbol.ts`, extend `apply.ts`, `id_resolve.ts`

- [ ] **Step 1:** Re-read **`units.ts`** header (Task 3): **`rename_symbol`** must not contradict Tier I id rules; prefer **name-independent ids** so rename does not spuriously rewrite `id_resolve` unless spec demands; document any delta behavior in `v0-decisions.md`.
- [ ] **Step 2:** v0 scope: **same-file**, single **function_declaration** name rename (no cross-file refs) OR document “best effort same-file occurrences only”—pick one in `v0-decisions.md` and test accordingly.
- [ ] **Step 3:** Emit **`id_resolve_delta`** if ids encode old name (if ids are name-independent, delta empty—prefer **name-independent ids**; document).
- [ ] **Step 4:** Test: rename `foo` → `bar` in fixture; references inside file updated; parse ok.
- [ ] **Step 5:** Conformance (or adapter unit test): fixture where **naive string rename** would hit a **homonym** in another scope **fails** baseline-style replace but **IR `rename_symbol`** succeeds—ties to Task 9 README scenarios; keep bounded v0 scope explicit.

---

### Task 7: §9 apply-time gate + batch limits

**Files:** `packages/ts-adapter/src/apply.ts`

- [ ] **Step 1:** Before apply, assert `current_adapter_grammar_digest === snapshot.grammar_digest`; else **`grammar_mismatch`**.
- [ ] **Step 2:** If `adapter.name`/`semver` pinned on snapshot, assert match; else skip with logged **§9 digest-only** mode (document interchangeability watch).
- [ ] **Step 3:** If `ops.length > max_batch_ops`, return **`batch_size_exceeded`** without mutation.

---

### Task 8: Conformance package — goldens

**Files:** `packages/conformance/fixtures/template_literals.ts`, `packages/conformance/fixtures/decorators.ts`, `packages/conformance/fixtures/` (determinism + edit-shift fixtures as needed), `packages/conformance/src/golden.test.ts`

- [ ] **Step 1 — Snapshot determinism golden (blocking):** In **`golden.test.ts`**, materialize the **same** fixture directory **twice** in independent processes (or two fresh builder instances with no shared caches). Assert: **`snapshot_id`** identical; **unit `id` lists** identical (order + values); **`id_resolve`** map identical. Catches **Map iteration order**, unsorted file walks, nondeterministic timestamps in hashes, etc.
- [ ] **Step 2:** **Template literals** fixture: nested templates, tagged template, `${expr}` edges.
- [ ] **Step 3:** **Decorators** fixture: class/method/parameter decorators as supported by chosen TS grammar revision.
- [ ] **Step 4 — Edit-shift id golden:** Fixture with **≥2 units** in one file (stacked vertically). Snapshot **A** → record ids. Apply **`replace_unit`** to **lower** unit only → snapshot **B**. Assert: edited unit’s id **changed**; unit **above** edit **same id**; unit **below** edit (if any) **id changed** (per **`units.ts`** contract). Documents Tier I “not stable across edits” behavior.
- [ ] **Step 5:** Tests: materialize from fixtures dir → assert no parse errors; optional trivial `replace_unit` → **`ValidationReport.outcome === "success"`**; re-parse.
- [ ] **Step 6:** CI script `pnpm --filter conformance test`.

---

### Task 9: A/B harness

**Files:** `packages/ab-harness/README.md`, `packages/ab-harness/src/`, env `TARGET_REPO_URL` + `TARGET_REPO_REV`

**Metrics prerequisite:** A/B is only informative if the **baseline fails sometimes** in ways **IR avoids**. Design those cases **before** code.

- [ ] **Step 1:** **Resolve §16 repo:** Pick one OSS TS monorepo (e.g. tRPC, Zod, or similar size); pin **commit SHA** in `ab-harness/.pinned-rev` + `v0-decisions.md`.
- [ ] **Step 2:** Write **`packages/ab-harness/README.md`** (before any `src/` harness implementation): document **≥2 task types** where the **scripted baseline is expected to fail** (parse error, test failure, or wrong program), while the **IR loop** is expected to succeed. Include at least:
  - **Example A — scoped rename / homonym:** Task = rename symbol `X` → `Y`. Baseline = **naive global string replace** in file; repo contains **another `X`** in a different scope (string, property, or shadowed binding). Baseline **false-positive** breaks parse or tests; **`rename_symbol`** (bounded scope) avoids it.
  - **Example B (suggested second):** Baseline = blind replace of a **substring inside a template literal** or **import path**; breaks compilation; IR targets **`replace_unit`** on a **LogicalUnit** only.
  - For each scenario: link to **file + line region** in pinned repo (or minimal fork patch) so implementers can verify failure is reproducible.
- [ ] **Step 3:** Clone to `.cache/ab-target/` (gitignore); shallow clone acceptable.
- [ ] **Step 4:** Define **3–5 deterministic tasks** implementing the README scenarios + shared task descriptors consumed by both loops.
- [ ] **Step 5:** **Baseline loop:** read full files, **deterministic scripted edits** per README (mimic brittle agent); count full-file reads, failed patches, rounds until `pnpm test` passes or cap.
- [ ] **Step 6:** **IR loop:** `WorkspaceSummary` (incl. **`manifest_url`**) → units → `replace_unit`/`rename_symbol` via adapter → `ValidationReport`; count reads, failures, rounds.
- [ ] **Step 7:** Emit `metrics.json` (schema version, repo, rev, baseline vs ir counters). Document human LLM variant as optional flag for local runs.

---

### Task 10: Manifest discovery (§16) — minimal v0

**Files:** `packages/ts-adapter/src/manifest.ts`, `docs/impl/v0-decisions.md`, **`packages/ts-adapter/src/summary.ts`** (wire `manifest_url`)

- [ ] **Step 1:** Choose one: e.g. **`agent-ir.manifest.json`** at repo root OR `package.json` field `"agentIr": { "langCodesUrl": "..." }` — single choice, documented in `v0-decisions.md`.
- [ ] **Step 2:** Resolve manifest location to a **`file:` URL** or stable repo-relative path string; **`WorkspaceSummary.manifest_url`** = that value, or **`null`** if absent (**Task 4** surface).
- [ ] **Step 3:** If no file present, adapter returns empty manifest; no network fetch in v0 unless URL is `file:`.

---

### Task 11: Documentation and handoff

- [ ] **Step 1:** Update root **README.md**: how to run conformance, how to run A/B harness, link to spec + plan.
- [ ] **Step 2:** Note **§9 assumption**: CI goldens pin full fingerprint; digest-only mode for dev documented in README.
- [ ] **Step 3:** Final commit message: `feat: v0 ts-adapter, conformance goldens, ab harness skeleton`.

---

## Dependency order

`Task 0` → `1` → **`Task 2 Step 1` (`v0-decisions.md` grammar digest)** → remainder of `2` → `3` → `4` ↔ **`manifest_url` completed with Task 10** (Task 4 can ship `null` first; Task 10 fills resolution) → (`5` ∥ `6` after `3`; **6** assumes **3** header + **8** determinism where noted) → `7` wraps apply → `8` needs `3–7` → **`Task 9 Step 2` (`ab-harness/README.md`) before Step 4+ code** → `9` remainder → `10` (can overlap early `4`) → `11` last.

## Verification commands (v0)

```bash
pnpm install
pnpm -r build
pnpm --filter ts-adapter test
pnpm --filter conformance test
TARGET_REPO_URL=… TARGET_REPO_REV=… pnpm --filter ab-harness start
```

## Out of scope for this plan (v1+)

- `move_unit` / `relocate_unit`, generated provenance allowlists, LSP typecheck scope entries, MCP server transport, cross-file `rename_symbol`, `lang.*` emission beyond empty manifest.

---

## Spec self-review (plan)

- [x] Maps to locked spec §5.1, §6, §8, §9, §12.1 subset.
- [x] §16 items assigned to implementation artifacts (`v0-decisions.md`, pinned rev, manifest choice).
- [x] §9 interchangeability called out as CI + digest fingerprint watch.
- [x] Amendments: **grammar_digest** single strategy + doc gate before Task 2 code; **determinism + edit-shift** conformance; **A/B baseline failure** README before harness; **`manifest_url`** on summary + Task 1 stub.
- [ ] Claude stress-test pass after Tasks **0–4** complete (per partner handoff).
