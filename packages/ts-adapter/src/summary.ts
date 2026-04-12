import { resolveManifestUrl } from "./manifest.js";
import type { WorkspaceSnapshot, WorkspaceSummary } from "./types.js";

/**
 * Read-path **`WorkspaceSummary`** (spec section 6) derived from a materialized snapshot.
 * **`manifest_url`** is resolved from **`agent-ir.manifest.json`** at **`snapshotRootPath`** (Task 10).
 */
export async function buildWorkspaceSummary(
  snapshot: WorkspaceSnapshot,
  snapshotRootPath: string,
): Promise<WorkspaceSummary> {
  const manifest_url = await resolveManifestUrl(snapshotRootPath);
  return {
    snapshot_id: snapshot.snapshot_id,
    grammar_digest: snapshot.grammar_digest,
    max_batch_ops: snapshot.adapter.max_batch_ops,
    manifest_url,
    policies: {
      generated_allowlist_insufficient_assertions: "error",
    },
  };
}
