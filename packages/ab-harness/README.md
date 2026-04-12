# A/B harness (Task 9)

Baseline string-edit loop vs IR-backed loop against a pinned OSS TypeScript monorepo. Full harness design, env vars, and failure scenarios land per the [implementation plan](../docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md) (Task 9).

## Traceability — homonym / scoped rename

The **scoped rename vs naive string replace** scenario (baseline false-positive on homonyms, IR `rename_symbol` succeeding) should stay aligned with the reference adapter test in **[`../ts-adapter/src/apply.test.ts`](../ts-adapter/src/apply.test.ts)** — see the case that renames a function while preserving a `"victim"` string literal.
