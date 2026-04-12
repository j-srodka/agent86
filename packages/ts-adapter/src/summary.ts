import { resolve } from "node:path";

import { getBlobCachePath } from "./blobs.js";
import { resolveManifestUrl } from "./manifest.js";
import { omittedBlobsFromExternalizedUnits } from "./snapshot.js";
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
  const rootResolved = resolve(snapshotRootPath);
  const generated_file_count = snapshot.files.filter((f) => f.provenance.kind === "generated").length;
  return {
    snapshot_id: snapshot.snapshot_id,
    grammar_digest: snapshot.grammar_digest,
    max_batch_ops: snapshot.adapter.max_batch_ops,
    generated_file_count,
    has_generated_files: generated_file_count > 0,
    manifest_url,
    policies: {
      generated_allowlist_insufficient_assertions: "error",
    },
    blob_cache_path: getBlobCachePath(rootResolved),
    omitted_due_to_size: omittedBlobsFromExternalizedUnits(snapshot) ?? [],
  };
}
