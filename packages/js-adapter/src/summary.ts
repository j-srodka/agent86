import { resolve } from "node:path";

import { getBlobCachePath } from "./blobs.js";
import { ghostUnknownPeers } from "./report.js";
import { omittedBlobsFromExternalizedUnits } from "./snapshot.js";
import type { WorkspaceSnapshot, WorkspaceSummary } from "./types.js";

/**
 * Build a WorkspaceSummary from a materialized JavaScript snapshot.
 * js-adapter v1 has no manifest and no generated-file detection.
 */
export async function buildWorkspaceSummary(
  snapshot: WorkspaceSnapshot,
  snapshotRootPath: string,
): Promise<WorkspaceSummary> {
  const rootResolved = resolve(snapshotRootPath);

  return {
    snapshot_id: snapshot.snapshot_id,
    grammar_digest: snapshot.grammar_digest,
    max_batch_ops: snapshot.adapter.max_batch_ops,
    generated_file_count: 0,
    has_generated_files: false,
    manifest_url: null,
    policies: {
      generated_allowlist_insufficient_assertions: "error",
    },
    blob_cache_path: getBlobCachePath(rootResolved),
    omitted_due_to_size: omittedBlobsFromExternalizedUnits(snapshot) ?? [],
    manifest_strict: false,
    manifest_warnings: [],
  };
}

export { ghostUnknownPeers };
