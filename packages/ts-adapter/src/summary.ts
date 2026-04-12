import type { WorkspaceSnapshot, WorkspaceSummary } from "./types.js";

/**
 * Read-path **`WorkspaceSummary`** (spec section 6) derived from a materialized snapshot.
 * `manifest_url` is `null` until Task 10 resolves a manifest on disk.
 */
export function buildWorkspaceSummary(snapshot: WorkspaceSnapshot): WorkspaceSummary {
  return {
    snapshot_id: snapshot.snapshot_id,
    grammar_digest: snapshot.grammar_digest,
    max_batch_ops: snapshot.adapter.max_batch_ops,
    manifest_url: null,
    policies: {
      generated_allowlist_insufficient_assertions: "error",
    },
  };
}
