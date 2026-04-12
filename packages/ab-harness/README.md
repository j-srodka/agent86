# A/B harness (Task 9)

Baseline (brittle string edit) vs IR-backed (`WorkspaceSummary` → units → `replace_unit` / `rename_symbol` → `ValidationReport`) on a **pinned** OSS TypeScript monorepo. Design follows the [implementation plan](../../docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md) (Task 9).

## Pin and environment

| Input | Default |
| --- | --- |
| **`TARGET_REPO_URL`** | `https://github.com/colinhacks/zod.git` |
| **`TARGET_REPO_REV`** | First line of **`packages/ab-harness/.pinned-rev`** (full commit SHA) |

Optional:

| Input | Meaning |
| --- | --- |
| **`AB_METRICS_OUT`** | Write JSON metrics to this path (default: `./ab-metrics.json` in the current working directory). |
| **`AB_SKIP_CLONE`** | If `1`, assume repo already present at **`AB_CLONE_DIR`** (advanced). |

The harness clones to **`<repo-root>/.cache/ab-target/<repo-name>/`**. That path is gitignored.

**Why Zod at this pin:** Mid-sized TS monorepo, widely used, and **no `tree-sitter` dependency** in Zod’s install graph at the pinned revision — avoids native binding conflicts with the adapter’s **`tree-sitter@0.21.1`**. The pin is recorded in **`v0-decisions.md`** and **`.pinned-rev`**.

## Failure scenarios (informative A/B)

Metrics are only meaningful if the baseline **sometimes fails** while the IR path **succeeds** on the same task.

### Example A — scoped rename vs homonym (baseline false positive)

**Task:** Rename a function **`victim`** → **`renamedFn`** in one file.

**Baseline:** Naive **global substring replace** of `victim` with `renamedFn` in the file (mimics a brittle agent).

**Expected:** Baseline **corrupts** a `"victim"` string literal (or other incidental occurrence), producing **invalid or wrong** source; a parse check fails or semantics diverge.

**IR:** `rename_symbol` on the **`function_declaration`** unit — renames identifiers **inside that declaration subtree** only; the string literal **stays** `"victim"`.

**Traceability**

- Reference adapter test: **`packages/ts-adapter/src/apply.test.ts`** — test *“rename_symbol renames function and identifier calls; naive string replace would break a string literal”* (uses `homonym.ts`-shaped source).
- This package’s fixture copy: **`packages/ab-harness/fixtures/homonym.ts`**.

### Example B — `replace_unit` / `export` sharp edge (baseline parse_error)

**Task:** Replace the second stacked **`export function victim`** with an updated body.

**Baseline:** Mimics a caller error: replacement text includes a leading **`export`** while the logical unit span starts at **`function`**, yielding **`export export function`** → **`parse_error`** after splice.

**IR:** `replace_unit` with **`new_text`** that matches the unit span (typically `function victim …` **without** duplicating `export`).

**Traceability**

- **`packages/ts-adapter/src/apply.test.ts`** — *“replace_unit: leading export in new_text duplicates export and fails parse”*.
- **`packages/conformance/src/golden.test.ts`** — Tier I edit-shift golden (middle unit; correct `new_text`; stable id only for the strictly-above unit).

### Example C — stacked middle edit (Tier I id shift)

**Task:** Same as conformance **edit-shift**: three functions in one file; replace the **middle** function’s body; re-snapshot; ids above/below behave per **`packages/ts-adapter/src/units.ts`**.

**Baseline:** Same class of bug as Example B (bad `export` duplication in the splice) so the baseline patch **fails parse**.

**IR:** `replace_unit` on the middle unit with span-consistent `new_text`, then re-materialize.

**Fixture:** **`packages/ab-harness/fixtures/stacked.ts`** (aligned with **`packages/conformance/fixtures/edit_shift.ts`**).

## What the runner does (implementation)

1. Resolve **`TARGET_REPO_URL`** / **`TARGET_REPO_REV`**.
2. **Clone** (shallow fetch of the pinned commit) into **`.cache/ab-target/`** when needed.
3. Copy **`fixtures/*.ts`** into **`<clone>/__agent_ir_ab__/`** (isolated snapshot root so runs stay fast; the clone still satisfies “pinned monorepo” context).
4. For each deterministic task, run **baseline** then **IR** on that directory, counting file reads, parse/outcome, and rounds (v0: one round per task).
5. Emit **`metrics.json`** (schema version + per-task counters).

Optional full **`pnpm test`** at the Zod root is **not** run by default (slow); v0 uses **Tree-sitter parse** success as the green path. Set **`AB_RUN_ZOD_TESTS=1`** in a future revision if you want end-to-end test verification.

## Commands

```bash
# From repo root (after pnpm install / build)
pnpm build
pnpm --filter ab-harness start
# or
TARGET_REPO_URL=https://github.com/colinhacks/zod.git TARGET_REPO_REV=<sha> pnpm --filter ab-harness start
```
