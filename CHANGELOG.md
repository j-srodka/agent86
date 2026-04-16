## [Unreleased]

## [2.2.0] — 2026-04-16

- Snapshot-by-reference cache: materialize_snapshot writes snapshot to
  `<root_path>/.agent86/snapshots/<snapshot_id>.json`; apply_batch now
  accepts snapshot_id instead of full snapshot object, eliminating MCP
  payload size limits on large workspaces
- lang.agent86.snapshot_cache_miss error code when snapshot_id not found
  in cache
- Multi-op batch ordering documented: ops on the same file must be
  ordered by descending start_byte
- .agent86/ added to .gitignore

## [2.1.0] — 2026-04-14

- Added packages/js-adapter/ — JavaScript adapter for .js, .mjs, .cjs
  files using tree-sitter-javascript; same op surface as ts-adapter
  and py-adapter
- MCP server now routes .js/.mjs/.cjs through js-adapter;
  grammar_digests response includes js key
- get_session_report now tracks js_units_seen
- .jsx files are skipped and reported in skipped_jsx_paths on the
  combined snapshot (analogous to .tsx/skipped_tsx_paths)
- cross_file rename in js-adapter scoped to JS extensions only

## [2.0.0] — 2026-04-14

- MCP stdio server (@agent86/mcp-server): four tools
  (materialize_snapshot, list_units, build_workspace_summary,
  apply_batch); Cursor and Claude Code integration via stdio
- Python tree-sitter adapter (@agent86/py-adapter): Tree-sitter
  Python grammar, Tier I units, replace_unit / rename_symbol /
  move_unit, grammar digest gate, and expanded A/B harness Ruff
  profile wired off the regex stub (IR false positives 0 on
  canonical three-run benchmark)

## [v1.0.0] — 2026-04-13

- v1 reference stack complete: blob externalization, generated
  file provenance, move_unit, ghost-bytes report fields,
  formatter pinning, cross-file rename_symbol, manifest strict
  mode, expanded multi-repo benchmark (Zod, Prettier, Ruff),
  deterministic seeded task sampling, Wilson CI metrics
- Canonical benchmark artifact: commit 1346ae1
  - IR false positives: 0 / ~60 tasks
  - Baseline false positives: 27 total
- Writeup: docs/writeup/false-positive-problem.md

## [v0.0.0] — 2026-04-12

- Initial v0 reference stack: TypeScript adapter (Tree-sitter),
  replace_unit, rename_symbol, conformance goldens,
  A/B harness (Zod and tRPC profiles)
- Locked spec: docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md
