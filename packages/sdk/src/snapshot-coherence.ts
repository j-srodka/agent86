import { buildFailureReport, ghostUnknownPeers } from "ts-adapter";
import type { AdapterFingerprint, ValidationEntry, ValidationReport } from "ts-adapter";

/** Synthetic adapter fingerprint when the SDK rejects a batch before MCP (not an adapter failure). */
export const SDK_COHERENCE_ADAPTER: AdapterFingerprint = {
  name: "@agent86/sdk",
  semver: "0.0.0",
  grammar_digest: "0".repeat(64),
  max_batch_ops: 0,
};

export type SnapshotIdMismatchReason =
  | "apply_mismatch"
  | "builder_multi_snapshot"
  | "incomplete_source_snapshot_ids";

/**
 * Local-only `ValidationReport` when `.apply({ snapshot_id })` disagrees with
 * `source_snapshot_id` lines on queued ops. No MCP round trip.
 */
export function buildSnapshotIdMismatchReport(input: {
  apply_snapshot_id: string;
  builder_snapshot_ids: string[];
  reason: SnapshotIdMismatchReason;
}): ValidationReport {
  const message =
    input.reason === "apply_mismatch"
      ? "Op batch was built against a different snapshot_id than apply(); align apply.snapshot_id with each op's source_snapshot_id (e.g. from UnitRef.snapshot_id)."
      : input.reason === "builder_multi_snapshot"
        ? "Op batch mixes target_ids resolved from more than one snapshot_id; rebuild the batch from a single snapshot."
        : "When any op sets source_snapshot_id, every op in the batch must set source_snapshot_id.";

  const entry: ValidationEntry = {
    code: "lang.agent86.snapshot_id_mismatch",
    severity: "error",
    message,
    op_index: null,
    target_id: null,
    check_scope: "none",
    confidence: "canonical",
    evidence: {
      apply_snapshot_id: input.apply_snapshot_id,
      builder_snapshot_ids: input.builder_snapshot_ids,
      reason: input.reason,
    },
    ...ghostUnknownPeers(),
  };

  return buildFailureReport({
    snapshot_id: input.apply_snapshot_id,
    adapter: SDK_COHERENCE_ADAPTER,
    toolchain_fingerprint_at_apply: "sdk:snapshot_coherence",
    entries: [entry],
  });
}
