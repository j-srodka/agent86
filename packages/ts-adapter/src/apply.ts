import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BlobNotFoundError, fetchBlobText } from "./blobs.js";
import { assertGrammarDigestPinned, GRAMMAR_DIGEST_V0 } from "./grammar_meta.js";
import { resolveLogicalUnit } from "./id_resolve.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol } from "./ops/rename_symbol.js";
import { buildFailureReport, buildSuccessReport } from "./report.js";
import { canonicalizeSourceForSnapshot, omittedBlobsFromExternalizedUnits, V0_ADAPTER_FINGERPRINT } from "./snapshot.js";
import type {
  AdapterFingerprint,
  LogicalUnit,
  OmittedBlob,
  ValidationEntry,
  ValidationReport,
  V0Op,
  WorkspaceSnapshot,
} from "./types.js";

export interface ApplyBatchInput {
  snapshotRootPath: string;
  snapshot: WorkspaceSnapshot;
  ops: V0Op[];
  toolchainFingerprintAtApply: string;
}

function entry(
  code: ValidationEntry["code"],
  message: string,
  opIndex: number | null,
  targetId: string | null,
): ValidationEntry {
  return {
    code,
    severity: "error",
    message,
    op_index: opIndex,
    target_id: targetId,
    check_scope: "file",
    confidence: "canonical",
    evidence: null,
  };
}

function mergeOmitted(a: OmittedBlob[], b: OmittedBlob[]): OmittedBlob[] {
  return [...a, ...b].sort((x, y) =>
    x.ref.localeCompare(y.ref) || x.bytes - y.bytes || x.reason.localeCompare(y.reason),
  );
}

function applyingAdapterFingerprint(): AdapterFingerprint {
  return { ...V0_ADAPTER_FINGERPRINT };
}

/**
 * Atomic v0 apply: validate §9 gates, then run ops sequentially; on any failure,
 * restore original file bytes from before the batch.
 */
export async function applyBatch(input: ApplyBatchInput): Promise<ValidationReport> {
  const { snapshot, ops, snapshotRootPath, toolchainFingerprintAtApply } = input;
  const adapter = snapshot.adapter;

  const omittedOnInput = (): OmittedBlob[] => omittedBlobsFromExternalizedUnits(snapshot);

  try {
    assertGrammarDigestPinned();
  } catch (e) {
    const msg = String(e);
    const withGate = msg.includes("[gate:runtime_grammar_artifact]")
      ? msg
      : `[gate:runtime_grammar_artifact] ${msg}`;
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [entry("grammar_mismatch", withGate, null, null)],
      omitted_due_to_size: omittedOnInput(),
    });
  }

  if (snapshot.grammar_digest !== GRAMMAR_DIGEST_V0) {
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [
        entry(
          "grammar_mismatch",
          `[gate:snapshot_grammar_digest] WorkspaceSnapshot.grammar_digest (${snapshot.grammar_digest}) does not match applying adapter (${GRAMMAR_DIGEST_V0}); snapshot may be stale or produced by a different toolchain.`,
          null,
          null,
        ),
      ],
      omitted_due_to_size: omittedOnInput(),
    });
  }

  const expected = V0_ADAPTER_FINGERPRINT;
  if (
    snapshot.adapter.name !== expected.name ||
    snapshot.adapter.semver !== expected.semver ||
    snapshot.adapter.grammar_digest !== expected.grammar_digest ||
    snapshot.adapter.max_batch_ops !== expected.max_batch_ops
  ) {
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [
        entry(
          "adapter_version_unsupported",
          "AdapterFingerprint on snapshot does not match applying ts-adapter build (v0); use a snapshot from this adapter or upgrade.",
          null,
          null,
        ),
      ],
      omitted_due_to_size: omittedOnInput(),
    });
  }

  if (ops.length > snapshot.adapter.max_batch_ops) {
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [
        entry(
          "batch_size_exceeded",
          `op batch length ${ops.length} exceeds max_batch_ops ${snapshot.adapter.max_batch_ops}`,
          null,
          null,
        ),
      ],
      omitted_due_to_size: omittedOnInput(),
    });
  }

  const backup = new Map<string, string>();
  for (const f of snapshot.files) {
    const abs = join(snapshotRootPath, ...f.path.split("/"));
    const raw = await readFile(abs, "utf8");
    backup.set(f.path, canonicalizeSourceForSnapshot(raw));
  }

  async function restoreDisk(): Promise<void> {
    for (const [rel, content] of backup) {
      const abs = join(snapshotRootPath, ...rel.split("/"));
      await writeFile(abs, content, "utf8");
    }
  }

  let current: WorkspaceSnapshot = snapshot;
  const mergedDelta: Record<string, string> = {};
  const fetchUnavailableOmitted: OmittedBlob[] = [];
  const blobPrefetchWarnings: ValidationEntry[] = [];

  function failureOmitted(): OmittedBlob[] {
    return mergeOmitted(omittedOnInput(), fetchUnavailableOmitted);
  }

  async function prefetchExternalizedBlob(unit: LogicalUnit, opIndex: number): Promise<void> {
    if (unit.blob_ref == null) {
      return;
    }
    try {
      await fetchBlobText(unit.blob_ref, snapshotRootPath);
    } catch (e) {
      if (e instanceof BlobNotFoundError) {
        blobPrefetchWarnings.push({
          code: "blob_unavailable",
          severity: "warning",
          message: e.message,
          op_index: opIndex,
          target_id: unit.id,
          check_scope: "none",
          confidence: "canonical",
          evidence: { blob_ref: unit.blob_ref },
        });
        if (unit.blob_bytes != null) {
          fetchUnavailableOmitted.push({
            ref: unit.blob_ref,
            bytes: unit.blob_bytes,
            reason: "unavailable",
          });
        }
        return;
      }
      throw e;
    }
  }

  try {
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex]!;

      if (op.op === "replace_unit") {
        const unit = resolveLogicalUnit(current, op.target_id);
        if (!unit) {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [entry("unknown_or_superseded_id", "target_id not in snapshot domain", opIndex, op.target_id)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        await prefetchExternalizedBlob(unit, opIndex);
        const r = await applyReplaceUnit({
          snapshotRootPath,
          unit,
          newText: op.new_text,
        });
        if (!r.ok) {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [entry("parse_error", r.message, opIndex, op.target_id)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        current = r.nextSnapshot;
        continue;
      }

      if (op.op === "rename_symbol") {
        const unit = resolveLogicalUnit(current, op.target_id);
        if (!unit) {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [entry("unknown_or_superseded_id", "target_id not in snapshot domain", opIndex, op.target_id)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        await prefetchExternalizedBlob(unit, opIndex);
        const r = await applyRenameSymbol({
          snapshotRootPath,
          unit,
          newName: op.new_name,
        });
        if (!r.ok) {
          await restoreDisk();
          const code = r.message.includes("v0 supports function_declaration only")
            ? "op_vocabulary_unsupported"
            : "parse_error";
          const msg =
            code === "op_vocabulary_unsupported"
              ? "rename_symbol on this unit kind is not supported in v0 (function_declaration only)"
              : r.message;
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [entry(code, msg, opIndex, op.target_id)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        current = r.nextSnapshot;
        Object.assign(mergedDelta, r.id_resolve_delta);
        continue;
      }

      await restoreDisk();
      return buildFailureReport({
        snapshot_id: snapshot.snapshot_id,
        adapter,
        toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
        entries: [
          entry("op_vocabulary_unsupported", "batch op type is not supported in v0", opIndex, null),
        ],
        omitted_due_to_size: failureOmitted(),
      });
    }

    const omittedFinal = mergeOmitted(omittedBlobsFromExternalizedUnits(current), fetchUnavailableOmitted);

    const successEntries: ValidationEntry[] = [];
    if (omittedFinal.some((o) => o.reason === "inline_threshold")) {
      successEntries.push({
        code: "inline_threshold_exceeded",
        severity: "warning",
        message: "One or more unit payloads were externalized per §10; see omitted_due_to_size.",
        op_index: null,
        target_id: null,
        check_scope: "none",
        confidence: "canonical",
        evidence: null,
      });
    }
    successEntries.push(...blobPrefetchWarnings);
    successEntries.push({
      code: "parse_scope_file",
      severity: "info",
      message: "Parse check ran on edited file(s) only.",
      op_index: null,
      target_id: null,
      check_scope: "file",
      confidence: "canonical",
      evidence: null,
    });

    return buildSuccessReport({
      snapshot_id: snapshot.snapshot_id,
      next_snapshot_id: current.snapshot_id,
      adapter: applyingAdapterFingerprint(),
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      id_resolve_delta: mergedDelta,
      entries: successEntries,
      omitted_due_to_size: omittedFinal,
    });
  } catch (e) {
    await restoreDisk();
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [entry("parse_error", String(e), null, null)],
      omitted_due_to_size: failureOmitted(),
    });
  }
}
