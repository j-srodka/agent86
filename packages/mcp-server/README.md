# @agent86/mcp-server

This package exposes the Agent86 reference adapters over the **Model Context Protocol (MCP)** using **stdio** only: materialize snapshots, list addressable logical units, read workspace summaries, and apply validated op batches with structured `ValidationReport` outcomes. **`ts-adapter`** handles **`.ts`** sources and **`@agent86/py-adapter`** handles **`.py`** sources (see **Mixed-language workspaces** below). Hosts such as Cursor or Claude Code can spawn `agent86-mcp` as a subprocess and call tools without custom glue code.

## Cursor

Add a server entry to your MCP configuration (for example `~/.cursor/mcp.json` or project-local `.cursor/mcp.json`). Example with the **`mcpServers`** wrapper Cursor expects:

```json
{
  "mcpServers": {
    "agent86": {
      "command": "node",
      "args": ["./packages/mcp-server/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

Use the path to **built** `dist/index.js` from your clone; adjust `args` to an absolute path if the config file is not at the repository root. Run `pnpm build:mcp` (or `pnpm --filter @agent86/py-adapter build && pnpm --filter @agent86/mcp-server build`) before starting the editor.

## Mixed-language workspaces

- **Supported tracked sources:** **`.ts`** (TypeScript grammar via `ts-adapter`) and **`.py`** (Python grammar via `@agent86/py-adapter`).
- **Routing:** By **file extension only** (no content sniffing): each tool resolves ops and units using the unit’s **`file_path`** suffix.
- **Combined snapshot:** `materialize_snapshot` merges TypeScript and Python materializations into one **`WorkspaceSnapshot`** (ts units first, then py units) and adds **`grammar_digests: { ts, py }`** alongside the legacy **`grammar_digest`** string. See `docs/impl/v0-decisions.md` (**MCP mixed-language routing (v2)**) for the combined **`snapshot_id`** formula and wire details.
- **Which grammar field to read:** When both are present, treat **`grammar_digests`** as authoritative for per-language pins. **`grammar_digest`** (singular) is retained for older single-language consumers: it mirrors **`grammar_digests.ts`** if the snapshot includes any **`.ts`** file, otherwise **`grammar_digests.py`** if only Python is tracked, otherwise **`grammar_digests.ts`** as the nominal empty-workspace default.
- **Cross-adapter atomicity:** A single **`apply_batch`** call may run the TypeScript batch and then the Python batch. **There is no cross-language rollback:** if the Python step fails after the TypeScript step succeeded, **TypeScript file changes from that call are already on disk**. Treat multi-language batches accordingly (smaller batches, or separate calls per language, if you need a simpler failure surface).
- **`.tsx` files:** Still **not** parsed as TypeScript; paths are recorded in **`skipped_tsx_paths`** on the snapshot (same as `ts-adapter` alone).

## Scoping and exclusions

The MCP server snapshots **all** `.ts` and `.py` files found under `root_path`, including subdirectories not tracked by git (e.g. benchmark caches, git worktrees, build outputs). It does **not** currently read `.gitignore` or apply any exclusion list.

**Recommendation:** point `root_path` at the package or subdirectory you want to edit, not at a monorepo or workspace root that contains large non-source trees. For example, if you are editing `packages/my-lib/`, use:

```json
{ "root_path": "/absolute/path/to/packages/my-lib" }
```

rather than the workspace root.

**Known side effect of broad root_path:** `rename_symbol` with `cross_file: true` will match identifiers in all scanned files, including cached or generated trees. The `lang.ts.cross_file_rename_broad_match` warning (threshold: 10 occurrences) exists specifically to surface this risk — if you see that warning on a common-name rename, inspect `rename_surface_report.skipped` and `rename_surface_report.rewritten` before committing.

**Real-world example:** after a `rename_symbol` op with `cross_file: true`, cached files under `.cache/` were rewritten but not restored by `git checkout -- .`. A subsequent `apply_batch` using the original snapshot failed with `snapshot_content_mismatch` on a `.cache/` path — not the intended target file. Re-materialize the snapshot after any operation that touches files outside version control.

**`build_workspace_summary` / `omitted_due_to_size`:** Note: the same `ref` may appear more than once if multiple units share identical content and both exceed the inline threshold. This is expected — entries are per-unit, not per unique blob.

**v3 roadmap:** `.gitignore`-aware file walking and optional `.agent86ignore` exclusion file.

## Session report

Call `get_session_report` at any time to see what the IR has done since the server started:

```json
{
  "ops_submitted": 42,
  "ops_succeeded": 39,
  "ops_rejected": 3,
  "batches_submitted": 8,
  "batches_succeeded": 7,
  "batches_rejected": 1,
  "false_positives_prevented": 1,
  "rejection_codes": { "snapshot_content_mismatch": 1 },
  "warnings_emitted": { "lang.ts.cross_file_rename_broad_match": 2 },
  "snapshots_materialized": 4,
  "ts_units_seen": 61,
  "py_units_seen": 24,
  "session_start_iso": "2026-04-14T..."
}
```

**`false_positives_prevented`** is the count of rejected batches where at least one entry had `severity: "error"` — the IR blocked those writes before any file was touched. This is the conservative "gain" signal: it does not claim to know what the agent would have written without IR, only that a gate fired and no mutation occurred.

State resets when the server process restarts (i.e. when Cursor restarts or you restart the MCP server manually).

## Claude Code

Add the same `command` / `args` / `type` block under `.claude/mcp.json` (or the MCP config path your Claude Code build expects), pointing at this package’s `dist/index.js`.

## Tools

| Tool | Input | Output |
| ---- | ----- | ------ |
| `materialize_snapshot` | `{ root_path: string, inline_threshold_bytes?: number }` | `WorkspaceSnapshot` (combined `.ts` + `.py`; includes `grammar_digests`) |
| `list_units` | `{ root_path: string, file_path?: string }` | `LogicalUnit[]` |
| `build_workspace_summary` | `{ root_path: string }` | `WorkspaceSummary` (adds `grammar_digests`; `manifest_url` from ts read path) |
| `apply_batch` | `{ root_path: string, snapshot: WorkspaceSnapshot, ops: V0Op[], toolchain_fingerprint_at_apply?: AdapterFingerprint }` | `ValidationReport` |
| `get_session_report` | `{}` | Session tally JSON (`ops_submitted`, `batches_*`, `false_positives_prevented`, `rejection_codes`, `warnings_emitted`, unit counts, `session_start_iso`) |

`AdapterFingerprint` is `{ name, semver, grammar_digest, max_batch_ops }`. When `toolchain_fingerprint_at_apply` is omitted, the server audits using the snapshot header adapter.

### Planning cycle and double materialization

**`list_units`** and **`build_workspace_summary`** each call **`materializeSnapshot`** internally. They do **not** return a `WorkspaceSnapshot`, so **`target_id`** values from **`list_units`** belong to that tool’s internal materialization only.

**Stale unit ids:** If the workspace on disk changes after **`list_units`** (or you call **`materialize_snapshot`** again and get a fresh tree view), ids from the earlier pass may **no longer exist** in the snapshot you pass to **`apply_batch`**. The adapter rejects those ops with **`unknown_or_superseded_id`**; if file bytes no longer match the snapshot you attached, you can also see **`snapshot_content_mismatch`**. Treat that as: **re-materialize and use `target_id` values only from `snapshot.units` on the same `WorkspaceSnapshot` object you send to `apply_batch`.**

**Recommended flow:**

1. Call **`materialize_snapshot`** once per planning cycle and keep the returned **`WorkspaceSnapshot`** object in memory (parsed JSON).
2. Choose **`target_id`** values only from **`snapshot.units`** on **that** object (filter/sort locally). Call **`apply_batch`** with **`snapshot` set to the **exact same object** from step 1 — **no second `materialize_snapshot`**, and no other tool call between materialize and apply that re-scans the tree for a new snapshot.
3. If you used **`list_units`** first because the full snapshot is too large to hold, call **`materialize_snapshot` once** after discovery, take **`target_id`** only from **`snapshot.units`** on **that** response, then call **`apply_batch`** with **that same snapshot object** — still one snapshot into apply, not ids from **`list_units`** paired with a different materialization.
4. After any external change to the tree, run a **new** **`materialize_snapshot`** and a new apply cycle; do not reuse old snapshot JSON or old ids.

## Example: materialize once, pass the same snapshot into `apply_batch`

Use two tool calls and **one** snapshot payload: the JSON returned from **`materialize_snapshot`** is passed **verbatim** as the **`snapshot`** argument to **`apply_batch`**. Do not call **`materialize_snapshot`** again between those two calls unless the disk changed and you are deliberately starting a new cycle.

1. **`materialize_snapshot`** — store the full JSON result (e.g. `snapshot` in your agent).

```json
{
  "name": "materialize_snapshot",
  "arguments": { "root_path": "/path/to/repo" }
}
```

2. Pick **`target_id`** from **`snapshot.units`** (the **same** object from step 1).

3. **`apply_batch`** — set **`snapshot`** to **that exact object** (the prior tool’s return value, unchanged — not a second fetch, not a fresh materialize).

```json
{
  "name": "apply_batch",
  "arguments": {
    "root_path": "/path/to/repo",
    "snapshot": "<the full WorkspaceSnapshot JSON returned by materialize_snapshot in step 1 — same object, unchanged>",
    "ops": [
      {
        "op": "rename_symbol",
        "target_id": "<id from snapshot.units on that same object>",
        "new_name": "renamedFn"
      }
    ]
  }
}
```

Inspect the returned `ValidationReport`: on success `outcome === "success"` and `entries` may still carry warnings (for example rename surface skips). On failure, branch on `entries[].code` (normative section 12.1 codes and `lang.*` subcodes), not on free-form `message` text alone.

## Errors

- **Adapter-level rejections** (`grammar_mismatch`, `unknown_or_superseded_id`, `batch_size_exceeded`, …) are returned **inside** a successful tool payload as a `ValidationReport` JSON object.
- **Bad tool arguments** or unexpected server failures use MCP tool error results with codes such as `lang.agent86.invalid_tool_input`, `lang.agent86.unsupported_file_extension` (non-`.ts` / non-`.py` routed paths), or `lang.agent86.internal_error` and structured `evidence`.
