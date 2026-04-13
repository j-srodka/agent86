import { resolve } from "node:path";

import { getBlobCachePath } from "./blobs.js";
import { ghostUnknownPeers } from "./ghost_bytes.js";
import { ManifestParseError, readAgentIrManifest, resolveManifestUrl } from "./manifest.js";
import { omittedBlobsFromExternalizedUnits } from "./snapshot.js";
import type { ValidationEntry, WorkspaceSnapshot, WorkspaceSummary } from "./types.js";

export interface BuildWorkspaceSummaryOptions {
  /**
   * When `true`, invalid manifest JSON or a non-object root surfaces as `lang.ts.manifest_parse_error`
   * on `manifest_warnings` (summary still returns). Default `false` matches v0 lenient behavior.
   */
  strictManifest?: boolean;
}

function manifestParseWarningEntry(err: ManifestParseError): ValidationEntry {
  const p = err.manifestPath;
  const detail =
    err.reason === "non_object_root"
      ? "non-object root"
      : err.rawError !== undefined && err.rawError !== ""
        ? err.rawError
        : "invalid JSON";
  return {
    code: "lang.ts.manifest_parse_error",
    severity: "warning",
    message: `[lang.ts.manifest_parse_error] agent-ir.manifest.json could not be parsed: ${detail} (path: ${p})`,
    op_index: null,
    target_id: null,
    check_scope: "project",
    confidence: "canonical",
    evidence: {
      path: p,
      reason: err.reason,
      ...(err.rawError !== undefined ? { raw_error: err.rawError } : {}),
    },
    ...ghostUnknownPeers(),
  };
}

/**
 * Read-path **`WorkspaceSummary`** (spec section 6) derived from a materialized snapshot.
 * **`manifest_url`** is resolved from **`agent-ir.manifest.json`** at **`snapshotRootPath`** (Task 10).
 */
export async function buildWorkspaceSummary(
  snapshot: WorkspaceSnapshot,
  snapshotRootPath: string,
  options?: BuildWorkspaceSummaryOptions,
): Promise<WorkspaceSummary> {
  const manifest_strict = options?.strictManifest === true;
  const manifest_url = await resolveManifestUrl(snapshotRootPath);
  const rootResolved = resolve(snapshotRootPath);
  const generated_file_count = snapshot.files.filter((f) => f.provenance.kind === "generated").length;

  let manifest_warnings: ValidationEntry[] = [];
  if (manifest_strict) {
    try {
      await readAgentIrManifest(snapshotRootPath, { strict: true });
    } catch (e) {
      if (e instanceof ManifestParseError) {
        manifest_warnings = [manifestParseWarningEntry(e)];
      } else {
        throw e;
      }
    }
  }

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
    manifest_strict,
    manifest_warnings,
  };
}
