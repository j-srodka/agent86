# The false positive problem in AI code editing

## 1. The problem

Agents editing code today produce edits that look correct — no parse error, no test failure — but changed the wrong thing. We call this a false positive: the tooling reports success, but the edit was semantically wrong.

The canonical example is a symbol rename that hits a string literal. A naive string-replacement agent asked to rename a function `validate` to `validateSchema` will also rewrite any string `"validate"` in the codebase — documentation strings, test fixture strings, map keys, error messages. The file still parses. Tests may still pass if none of them exercise the changed string path. From the pipeline's perspective, the edit succeeded. From the codebase's perspective, it silently corrupted data.

This failure mode is structural, not accidental. Any agent that operates on raw text without understanding syntactic scope will produce it. The problem compounds in agentic loops where each bad edit becomes the foundation for the next one.

## 2. What we built

agent86 is a portable op vocabulary and validation layer for agent-to-code editing. Instead of giving agents raw file text and a diff, agent86 exposes a small set of structured ops — `replace_unit`, `rename_symbol`, `move_unit` — that operate on content-addressed snapshots of the workspace. Every apply attempt returns a `ValidationReport` with normative rejection codes that agents can branch on programmatically, not prose error messages they have to parse. The snapshot pins the grammar version and adapter identity so that op targets stay stable across tool calls. The result is a contract layer that sits between the agent and the code tree, replacing the implicit "I hope this string replacement is right" with explicit, auditable state transitions.

## 3. How we measured

We ran an A/B benchmark across three OSS repositories — Zod (TypeScript), Prettier (TypeScript), and Ruff (Python stub) — using seed-42 deterministic task sampling. Each repo received 20 tasks split between `replace_unit` and `rename_symbol` categories. The baseline condition used naive string operations (full-file reads, global string replace). The agent86 condition used IR-backed ops against materialized snapshots.

One caveat up front: the Ruff tasks targeted Python source files processed by a regex-based unit detector, not a full tree-sitter grammar. This is a deliberate stub — enough to demonstrate the op vocabulary is language-agnostic, not a claim about production Python support.

The canonical artifact is commit `1346ae1` (`packages/ab-harness/ab-metrics-expanded.json`). We verified determinism by running the benchmark three consecutive times with the same seed; all three runs produced byte-identical output.

## 4. Results

IR false positives: **0** across all three repos and all 60 tasks.

Baseline false positives: **27 total** — 8 in Zod, 8 in Prettier, 11 in Ruff. Every one of these was a rename task where the string-replace baseline hit a string literal that should not have been changed.

Failed patch rates with Wilson 95% confidence intervals:

| Repo | Baseline | IR | Baseline CI | IR CI |
|------|----------|----|-------------|-------|
| Zod | 15.0% | 0.0% | [5.2%, 36.0%] | [0.0%, 16.1%] |
| Prettier | 20.0% | 5.0% | [8.1%, 41.6%] | [0.9%, 23.6%] |
| Ruff | 0.0% | 0.0% | [0.0%, 16.1%] | [0.0%, 16.1%] |

The confidence intervals overlap at n=20. This is a directional signal, not a statistically significant result.

We are not claiming the failed patch rate improvement is proven at this sample size; we are claiming the false positive elimination is real because the mechanism is structural.

> **human_summary from `ab-metrics-expanded.json`:**
> Expanded A/B benchmark (seed 42, 3 repos, ~60 tasks):
> IR false positives: 0 across all repos and all tasks.
> Baseline false positives: 27 total (8 zod, 8 prettier, 11 ruff) — semantically wrong edits that passed syntax checks, the silent failure mode IR is designed to prevent.
> Failed patch rates (baseline vs IR): zod 15.0% vs 0.0% (Wilson 95% CI [5.2, 36.0] vs [0.0, 16.1]); prettier 20.0% vs 5.0% (Wilson 95% CI [8.1, 41.6] vs [0.9, 23.6]); ruff 0.0% vs 0.0% (Wilson 95% CI [0.0, 16.1] vs [0.0, 16.1]).

## 5. What this means

The false positive problem is addressable at the infrastructure layer, not by making models smarter. A rename op that is defined to operate only on symbol references in the parse tree cannot hit a string literal; that guarantee comes from the op's semantics, not from the model's judgment. The op vocabulary and `ValidationReport` are the contract — agents get machine-readable rejection codes to branch on, not prose to interpret. This means the same model, operating through a structured op layer, produces fewer silent corruptions than the same model operating through raw text. The leverage is in the contract layer, not the model.

## 6. One honest caveat

This is a reference implementation and a demo harness, not a production integration. The benchmark establishes that the ops are semantically correct and that the failure modes are real and measurable. It does not prove end-to-end agent behavior in a live editing loop. No real agent drove these tasks autonomously; the harness simulated baseline and IR conditions mechanically. Whether a full agent-in-the-loop system achieves similar false positive rates depends on how the op layer is integrated, how the agent constructs its op batches, and whether the snapshot lifecycle is managed correctly across tool calls. That work remains ahead.

## 7. Links

- **Repository:** `github.com/j-srodka/agent86` (see `README.md` for setup)
- **Locked spec:** `docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`
- **Run the benchmark:**
  ```bash
  pnpm install
  pnpm -r build
  pnpm ab:bench:expanded
  # Output: packages/ab-harness/ab-metrics-expanded.json
  ```
