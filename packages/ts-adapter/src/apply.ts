import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertGrammarDigestPinned, GRAMMAR_DIGEST_V0 } from "./grammar_meta.js";
import { resolveLogicalUnit } from "./id_resolve.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol } from "./ops/rename_symbol.js";
import { canonicalizeSourceForSnapshot, V0_ADAPTER_FINGERPRINT } from "./snapshot.js";
import { buildFailureReport, buildSuccessReport } from "./report.js";
import type { AdapterFingerprint, ValidationEntry, ValidationReport, V0Op, WorkspaceSnapshot } from "./types.js";

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
          });
        }
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
          });
        }
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
      });
    }

    return buildSuccessReport({
      snapshot_id: snapshot.snapshot_id,
      next_snapshot_id: current.snapshot_id,
      adapter: applyingAdapterFingerprint(),
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      id_resolve_delta: mergedDelta,
      entries: [
        {
          code: "parse_scope_file",
          severity: "info",
          message: "Parse check ran on edited file(s) only.",
          op_index: null,
          target_id: null,
          check_scope: "file",
          confidence: "canonical",
          evidence: null,
        },
      ],
    });
  } catch (e) {
    await restoreDisk();
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [entry("parse_error", String(e), null, null)],
    });
  }
}
