# Cross-rename demo (Agent86)

Small TypeScript tree used to **reproduce** and **recover from** a high-volume cross-file rename:

1. **`rename_surface_report.found` > 10** with `cross_file: true` on `rename_symbol` → the adapter emits **`lang.ts.cross_file_rename_broad_match`** (warning) when the match count exceeds the threshold in `packages/ts-adapter/src/ops/rename_symbol.ts` (`CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD`).

2. **Narrowing** when planning follow-up automation: Tier I **`search_units`** today supports **`path_prefix`**, **`name`**, and **`kind`** (see `docs/impl/v0-decisions.md`). A future read-path upgrade will honor **`imported_from`** for `kind: "reference"` so agents can express “only refs whose import path matches `./services/user`” — this repo’s layout uses **`src/services/user.ts`** as the shared module so that string is the natural **`imported_from`** target once wired.

## Layout

- `src/services/user.ts` — exports **`authenticate`** (rename this symbol to stress-test).
- `src/consumers/consumer_01.ts` … **`consumer_11.ts`** — each imports **`authenticate`** from **`../services/user`**. Eleven call sites gives **> 10** cross-file references for **`cross_file: true`** renames.

Regenerate consumers (optional):

```bash
pnpm gen
```

## Agent86 workflow (sketch)

From the Agent86 monorepo root, point **`materialize_snapshot`** / **`apply_batch`** at **this directory** as `root_path`. Resolve the **`authenticate`** unit id, then run **`rename_symbol`** with **`cross_file: true`**. Inspect **`ValidationReport.entries`** for **`lang.ts.cross_file_rename_broad_match`** when **`rename_surface_report.found`** is large.

**SDK (`@agent86/sdk`):** thread **`UnitRef.snapshot_id`** into every op as **`source_snapshot_id`** and match **`.apply({ snapshot_id })`** — see the root README quickstart.

## Not a standalone package

This folder is **not** part of the root pnpm workspace; it is a **fixture-style** demo you can copy or open as a workspace root for MCP sessions.
