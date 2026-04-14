# @agent86/mcp-server

This package exposes the Agent86 reference TypeScript adapter (`ts-adapter`) over the **Model Context Protocol (MCP)** using **stdio** only: materialize snapshots, list addressable logical units, read workspace summaries, and apply validated op batches with structured `ValidationReport` outcomes. Hosts such as Cursor or Claude Code can spawn `agent86-mcp` as a subprocess and call tools without custom glue code.

## Cursor

Add a server entry to your MCP configuration (for example `~/.cursor/mcp.json` or project-local `.cursor/mcp.json`). Cursor typically nests servers under `mcpServers`; the **server definition** for this repo is:

```json
{
  "agent86": {
    "command": "node",
    "args": ["./packages/mcp-server/dist/index.js"],
    "type": "stdio"
  }
}
```

Use the path to **built** `dist/index.js` from your clone; adjust `args` to an absolute path if the config file is not at the repository root. Run `pnpm build:mcp` (or `pnpm --filter @agent86/mcp-server build`) before starting the editor.

## Claude Code

Add the same `command` / `args` / `type` block under `.claude/mcp.json` (or the MCP config path your Claude Code build expects), pointing at this package’s `dist/index.js`.

## Tools

| Tool | Input | Output |
| ---- | ----- | ------ |
| `materialize_snapshot` | `{ root_path: string, inline_threshold_bytes?: number }` | `WorkspaceSnapshot` |
| `list_units` | `{ root_path: string, file_path?: string }` | `LogicalUnit[]` |
| `build_workspace_summary` | `{ root_path: string }` | `WorkspaceSummary` |
| `apply_batch` | `{ root_path: string, snapshot: WorkspaceSnapshot, ops: V0Op[], toolchain_fingerprint_at_apply?: AdapterFingerprint }` | `ValidationReport` |

`AdapterFingerprint` is `{ name, semver, grammar_digest, max_batch_ops }`. When `toolchain_fingerprint_at_apply` is omitted, the server audits using the snapshot header adapter.

## Example: list units then rename

1. Call `list_units` with `{ "root_path": "/abs/path/to/repo" }` and read `LogicalUnit[]` (each entry has `id`, `file_path`, `kind`, …).
2. Pick a function unit and call `apply_batch` with the **same** `WorkspaceSnapshot` you will use for the write (from a prior `materialize_snapshot` call, or materialize again and ensure `snapshot_id` matches your planning cycle).

```json
{
  "name": "list_units",
  "arguments": { "root_path": "/path/to/repo" }
}
```

```json
{
  "name": "apply_batch",
  "arguments": {
    "root_path": "/path/to/repo",
    "snapshot": { "...": "WorkspaceSnapshot from materialize_snapshot" },
    "ops": [
      {
        "op": "rename_symbol",
        "target_id": "<id from list_units>",
        "new_name": "renamedFn"
      }
    ]
  }
}
```

Inspect the returned `ValidationReport`: on success `outcome === "success"` and `entries` may still carry warnings (for example rename surface skips). On failure, branch on `entries[].code` (normative section 12.1 codes and `lang.*` subcodes), not on free-form `message` text alone.

## Errors

- **Adapter-level rejections** (`grammar_mismatch`, `unknown_or_superseded_id`, `batch_size_exceeded`, …) are returned **inside** a successful tool payload as a `ValidationReport` JSON object.
- **Bad tool arguments** or unexpected server failures use MCP tool error results with codes such as `lang.agent86.invalid_tool_input` or `lang.agent86.internal_error` and structured `evidence`.
