## [Unreleased]

- MCP stdio server (@agent86/mcp-server): four tools
  (materialize_snapshot, list_units, build_workspace_summary,
  apply_batch); Cursor and Claude Code integration via stdio
- Python tree-sitter adapter (@agent86/py-adapter): in progress

## [v1.0.0] — 2026-04-13

- v1 reference stack complete: blob externalization, generated
  file provenance, move_unit, ghost-bytes report fields,
  formatter pinning, cross-file rename_symbol, manifest strict
  mode, expanded multi-repo benchmark (Zod, Prettier, Ruff),
  deterministic seeded task sampling, Wilson CI metrics
- Canonical benchmark artifact: commit e8583c92
  - IR false positives: 0 / ~60 tasks
  - Baseline false positives: 27 total
- Writeup: docs/writeup/false-positive-problem.md

## [v0.0.0] — 2026-04-12

- Initial v0 reference stack: TypeScript adapter (Tree-sitter),
  replace_unit, rename_symbol, conformance goldens,
  A/B harness (Zod and tRPC profiles)
- Locked spec: docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md
