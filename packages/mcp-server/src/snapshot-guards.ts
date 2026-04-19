import type { AdapterFingerprint, V0Op, WorkspaceSnapshot } from "ts-adapter";

import type { CombinedWorkspaceSnapshot } from "./combined-snapshot.js";

function isAdapterFingerprint(v: unknown): v is AdapterFingerprint {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.semver === "string" &&
    typeof o.grammar_digest === "string" &&
    typeof o.max_batch_ops === "number" &&
    Number.isInteger(o.max_batch_ops) &&
    o.max_batch_ops > 0
  );
}

export function isWorkspaceSnapshot(v: unknown): v is WorkspaceSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.snapshot_id !== "string" || typeof o.grammar_digest !== "string") return false;
  if (!isAdapterFingerprint(o.adapter)) return false;
  if (!Array.isArray(o.files) || !Array.isArray(o.units)) return false;
  if (typeof o.id_resolve !== "object" || o.id_resolve === null) return false;
  if (!Array.isArray(o.skipped_tsx_paths)) return false;
  if (!Array.isArray(o.skipped_ts_parse_throw)) return false;
  return true;
}

/**
 * Validates cached JSON from `.agent86/snapshots/<id>.json` before adapters consume it.
 * Combined MCP snapshots always include `grammar_digests` and `skipped_jsx_paths`.
 */
export function isCombinedWorkspaceSnapshot(v: unknown): v is CombinedWorkspaceSnapshot {
  if (!isWorkspaceSnapshot(v)) return false;
  const o = v as unknown as Record<string, unknown>;
  if (typeof o.grammar_digests !== "object" || o.grammar_digests === null) return false;
  const g = o.grammar_digests as Record<string, unknown>;
  if (typeof g.ts !== "string" || typeof g.py !== "string" || typeof g.js !== "string") return false;
  if (!Array.isArray(o.skipped_jsx_paths)) return false;
  if (!o.skipped_jsx_paths.every((x) => typeof x === "string")) return false;
  return true;
}

export function isV0OpArray(v: unknown): v is V0Op[] {
  if (!Array.isArray(v)) return false;
  for (const item of v) {
    if (typeof item !== "object" || item === null) return false;
    const op = (item as { op?: unknown }).op;
    if (op !== "replace_unit" && op !== "rename_symbol" && op !== "move_unit") return false;
  }
  return true;
}
