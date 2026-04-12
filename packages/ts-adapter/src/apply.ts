import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assertGrammarDigestPinned } from "./grammar_meta.js";
import { resolveLogicalUnit } from "./id_resolve.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol } from "./ops/rename_symbol.js";
import { canonicalizeSourceForSnapshot } from "./snapshot.js";
import { buildFailureReport, buildSuccessReport } from "./report.js";
import type { ValidationEntry, ValidationReport, V0Op, WorkspaceSnapshot } from "./types.js";

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

/**
 * Atomic v0 apply: validate digest gate, then run ops sequentially; on any failure,
 * restore original file bytes from before the batch.
 */
export async function applyBatch(input: ApplyBatchInput): Promise<ValidationReport> {
  const { snapshot, ops, snapshotRootPath, toolchainFingerprintAtApply } = input;
  const adapter = snapshot.adapter;

  try {
    assertGrammarDigestPinned();
  } catch (e) {
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [
        entry("grammar_mismatch", String(e), null, null),
      ],
    });
  }

  // Task 7: add grammar_mismatch (snapshot vs adapter runtime digest compare), batch_size_exceeded,
  // adapter name / semver fingerprint checks here — same entry point, before op expansion.

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
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [entry(code, r.message, opIndex, op.target_id)],
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
        entries: [entry("op_vocabulary_unsupported", "unknown op shape", opIndex, null)],
      });
    }

    return buildSuccessReport({
      snapshot_id: snapshot.snapshot_id,
      next_snapshot_id: current.snapshot_id,
      adapter,
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
