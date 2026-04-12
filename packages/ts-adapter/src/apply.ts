import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BlobNotFoundError, fetchBlobText } from "./blobs.js";
import { assertGrammarDigestPinned, GRAMMAR_DIGEST_V0 } from "./grammar_meta.js";
import { resolveOpTarget } from "./id_resolve.js";
import { readAgentIrManifest } from "./manifest.js";
import { applyMoveUnit } from "./ops/move_unit.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol } from "./ops/rename_symbol.js";
import { getGeneratedAllowlistPolicy } from "./policies.js";
import { fileMatchesGeneratedEditAllowlist } from "./provenance.js";
import { buildFailureReport, buildSuccessReport } from "./report.js";
import {
  canonicalizeSourceForSnapshot,
  omittedBlobsFromExternalizedUnits,
  sha256HexOfCanonicalSource,
  V0_ADAPTER_FINGERPRINT,
} from "./snapshot.js";
import type {
  AdapterFingerprint,
  LogicalUnit,
  OmittedBlob,
  ValidationEntry,
  ValidationReport,
  V0Op,
  WorkspaceSnapshot,
  WorkspaceSummary,
} from "./types.js";

/**
 * `move_unit` does not rewrite `import` / `export` references in other files; callers must fix cross-file
 * edges themselves (`docs/impl/v0-decisions.md` — move_unit v1).
 */

function posixNormalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface ApplyBatchInput {
  snapshotRootPath: string;
  snapshot: WorkspaceSnapshot;
  ops: V0Op[];
  toolchainFingerprintAtApply: string;
  /**
   * When provided, `policies.generated_allowlist_insufficient_assertions` is used for §11 allowlist
   * gates. When omitted, the fail-safe `"error"` effective policy applies (section 6.1), and
   * `allowlist_without_generator_awareness` error entries state that `WorkspaceSummary` was not
   * provided (distinguishable from an explicit read-path `"error"` policy).
   */
  workspaceSummary?: WorkspaceSummary;
}

function allowlistInsufficientAssertionsErrorMessage(workspaceSummary: WorkspaceSummary | undefined): string {
  const core =
    "Op targets an allowlisted generated unit without generator_will_not_run or non-empty generator_inputs_patched.";
  if (workspaceSummary === undefined) {
    return `${core} Policy defaulted to error: WorkspaceSummary not provided to applyBatch (section 6.1 fail-safe).`;
  }
  return `${core} WorkspaceSummary was provided; generated_allowlist_insufficient_assertions is "error" or omitted with effective "error" (section 6.1).`;
}

function opHasGeneratorWorkflowAssertion(op: V0Op): boolean {
  if ("generator_will_not_run" in op && op.generator_will_not_run === true) {
    return true;
  }
  if (
    "generator_inputs_patched" in op &&
    Array.isArray(op.generator_inputs_patched) &&
    op.generator_inputs_patched.length > 0
  ) {
    return true;
  }
  return false;
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
  const { snapshot, ops, snapshotRootPath, toolchainFingerprintAtApply, workspaceSummary } = input;
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

  const manifest = await readAgentIrManifest(snapshotRootPath);
  const allowlistPolicy = getGeneratedAllowlistPolicy(workspaceSummary?.policies ?? {});
  const allowlistAuditWarnings: ValidationEntry[] = [];

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex]!;
    const tr = resolveOpTarget(snapshot, op.target_id);
    if (tr.kind !== "live" || tr.unit.provenance.kind !== "generated") {
      continue;
    }
    const unit = tr.unit;
    const prov = unit.provenance;
    if (prov.kind !== "generated") {
      continue;
    }
    const onAllowlist = fileMatchesGeneratedEditAllowlist(unit.file_path, manifest);
    const asserted = opHasGeneratorWorkflowAssertion(op);
    if (!onAllowlist) {
      const detectedBy = prov.detected_by;
      return buildFailureReport({
        snapshot_id: snapshot.snapshot_id,
        adapter,
        toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
        entries: [
          entry(
            "illegal_target_generated",
            `[gate:illegal_target_generated] op targets a generated unit (detected_by: ${detectedBy}); patch the generator inputs instead`,
            opIndex,
            op.target_id,
          ),
        ],
        omitted_due_to_size: omittedOnInput(),
      });
    }
    if (!asserted) {
      if (allowlistPolicy === "error") {
        return buildFailureReport({
          snapshot_id: snapshot.snapshot_id,
          adapter,
          toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
          entries: [
            {
              code: "allowlist_without_generator_awareness",
              severity: "error",
              message: allowlistInsufficientAssertionsErrorMessage(workspaceSummary),
              op_index: opIndex,
              target_id: op.target_id,
              check_scope: "file",
              confidence: "canonical",
              evidence: null,
            },
          ],
          omitted_due_to_size: omittedOnInput(),
        });
      }
      allowlistAuditWarnings.push({
        code: "allowlist_without_generator_awareness",
        severity: "warning",
        message:
          "Op targets an allowlisted generated unit without generator_will_not_run or generator_inputs_patched; proceeding under policies.generated_allowlist_insufficient_assertions=warning.",
        op_index: opIndex,
        target_id: op.target_id,
        check_scope: "file",
        confidence: "canonical",
        evidence: null,
      });
      continue;
    }
    allowlistAuditWarnings.push({
      code: "allowlist_without_generator_awareness",
      severity: "warning",
      message:
        "[gate:allowlist_without_generator_awareness] allowlisted edit to generated unit with workflow assertion recorded (audit).",
      op_index: opIndex,
      target_id: op.target_id,
      check_scope: "file",
      confidence: "canonical",
      evidence: null,
    });
  }

  const pathsToBackup = new Set<string>();
  for (const f of snapshot.files) {
    pathsToBackup.add(f.path);
  }
  for (const op of ops) {
    if (op.op === "move_unit") {
      pathsToBackup.add(posixNormalizePath(op.destination_file));
    }
  }

  const backup = new Map<string, string | null>();
  for (const rel of [...pathsToBackup].sort((a, b) => a.localeCompare(b))) {
    const abs = join(snapshotRootPath, ...rel.split("/"));
    const inManifest = snapshot.files.find((f) => f.path === rel);
    if (!existsSync(abs)) {
      if (inManifest) {
        return buildFailureReport({
          snapshot_id: snapshot.snapshot_id,
          adapter,
          toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
          entries: [
            entry(
              "snapshot_content_mismatch",
              `[gate:snapshot_content_mismatch] tracked file "${rel}" is missing on disk; refresh or re-materialize snapshot before apply.`,
              null,
              null,
            ),
          ],
          omitted_due_to_size: omittedOnInput(),
        });
      }
      backup.set(rel, null);
      continue;
    }
    const raw = await readFile(abs, "utf8");
    const canonical = canonicalizeSourceForSnapshot(raw);
    if (!inManifest) {
      return buildFailureReport({
        snapshot_id: snapshot.snapshot_id,
        adapter,
        toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
        entries: [
          entry(
            "snapshot_content_mismatch",
            `[gate:snapshot_content_mismatch] unexpected file "${rel}" exists on disk but is not in WorkspaceSnapshot.files; re-materialize snapshot before apply.`,
            null,
            null,
          ),
        ],
        omitted_due_to_size: omittedOnInput(),
      });
    }
    const sha = sha256HexOfCanonicalSource(canonical);
    if (sha !== inManifest.sha256) {
      return buildFailureReport({
        snapshot_id: snapshot.snapshot_id,
        adapter,
        toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
        entries: [
          entry(
            "snapshot_content_mismatch",
            `[gate:snapshot_content_mismatch] on-disk content for "${rel}" does not match WorkspaceSnapshot.files[].sha256; refresh or re-materialize snapshot before apply.`,
            null,
            null,
          ),
        ],
        omitted_due_to_size: omittedOnInput(),
      });
    }
    backup.set(rel, canonical);
  }

  async function restoreDisk(): Promise<void> {
    for (const [rel, content] of backup) {
      const abs = join(snapshotRootPath, ...rel.split("/"));
      if (content === null) {
        if (existsSync(abs)) {
          await unlink(abs);
        }
      } else {
        await writeFile(abs, content, "utf8");
      }
    }
  }

  let current: WorkspaceSnapshot = snapshot;
  const mergedDelta: Record<string, string> = {};
  const idSupersededWarnings: ValidationEntry[] = [];
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
          message: `[blob_unavailable] blob not in local cache — re-materialize snapshot to rebuild (ref=${unit.blob_ref})`,
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

  function resolveFailureEntry(
    r: Extract<ReturnType<typeof resolveOpTarget>, { kind: "ghost" | "unknown" }>,
    opIndex: number,
  ): ValidationEntry {
    if (r.kind === "ghost") {
      return {
        code: "ghost_unit",
        severity: "error",
        message: `[ghost_unit] id_resolve maps "${r.target_id}" to "${r.resolved_to}", which is not a live unit`,
        op_index: opIndex,
        target_id: r.target_id,
        check_scope: "file",
        confidence: "canonical",
        evidence: { resolved_to: r.resolved_to },
      };
    }
    return {
      code: "unknown_or_superseded_id",
      severity: "error",
      message: "target_id not in snapshot domain",
      op_index: opIndex,
      target_id: r.target_id,
      check_scope: "file",
      confidence: "canonical",
      evidence: null,
    };
  }

  try {
    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
      const op = ops[opIndex]!;

      if (op.op === "replace_unit") {
        const tr = resolveOpTarget(current, op.target_id);
        if (tr.kind !== "live") {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [resolveFailureEntry(tr, opIndex)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        if (tr.supersededFrom != null) {
          idSupersededWarnings.push({
            code: "id_superseded",
            severity: "warning",
            message: `[id_superseded] op target ${tr.supersededFrom} was resolved to ${tr.unit.id} via id_resolve (unit was moved); verify op intent`,
            op_index: opIndex,
            target_id: tr.supersededFrom,
            check_scope: "file",
            confidence: "canonical",
            evidence: { resolved_to: tr.unit.id },
          });
        }
        const unit = tr.unit;
        await prefetchExternalizedBlob(unit, opIndex);
        const r = await applyReplaceUnit({
          snapshotRootPath,
          unit,
          newText: op.new_text,
          materialize: { previousSnapshot: current },
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
        const tr = resolveOpTarget(current, op.target_id);
        if (tr.kind !== "live") {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [resolveFailureEntry(tr, opIndex)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        if (tr.supersededFrom != null) {
          idSupersededWarnings.push({
            code: "id_superseded",
            severity: "warning",
            message: `[id_superseded] op target ${tr.supersededFrom} was resolved to ${tr.unit.id} via id_resolve (unit was moved); verify op intent`,
            op_index: opIndex,
            target_id: tr.supersededFrom,
            check_scope: "file",
            confidence: "canonical",
            evidence: { resolved_to: tr.unit.id },
          });
        }
        const unit = tr.unit;
        await prefetchExternalizedBlob(unit, opIndex);
        const r = await applyRenameSymbol({
          snapshotRootPath,
          unit,
          newName: op.new_name,
          materialize: { previousSnapshot: current },
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

      if (op.op === "move_unit") {
        const tr = resolveOpTarget(current, op.target_id);
        if (tr.kind !== "live") {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [resolveFailureEntry(tr, opIndex)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        if (tr.supersededFrom != null) {
          idSupersededWarnings.push({
            code: "id_superseded",
            severity: "warning",
            message: `[id_superseded] op target ${tr.supersededFrom} was resolved to ${tr.unit.id} via id_resolve (unit was moved); verify op intent`,
            op_index: opIndex,
            target_id: tr.supersededFrom,
            check_scope: "file",
            confidence: "canonical",
            evidence: { resolved_to: tr.unit.id },
          });
        }
        const unit = tr.unit;
        await prefetchExternalizedBlob(unit, opIndex);
        const r = await applyMoveUnit({
          snapshotRootPath,
          snapshot: current,
          unit,
          destinationFilePosix: op.destination_file,
          insertAfterId: op.insert_after_id,
          materialize: { previousSnapshot: current },
        });
        if (!r.ok) {
          await restoreDisk();
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [
              {
                code: r.code as ValidationEntry["code"],
                severity: "error",
                message: r.message,
                op_index: opIndex,
                target_id: op.target_id,
                check_scope: "file",
                confidence: "canonical",
                evidence: null,
              },
            ],
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

    const successEntries: ValidationEntry[] = [...allowlistAuditWarnings, ...idSupersededWarnings];
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
