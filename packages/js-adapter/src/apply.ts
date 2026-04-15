import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BlobNotFoundError, fetchBlobText } from "./blobs.js";
import { assertJsGrammarDigestPinned, JS_GRAMMAR_DIGEST } from "./grammar.js";
import { resolveOpTarget } from "./id_resolve.js";
import { applyMoveUnit } from "./ops/move_unit.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol, CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD } from "./ops/rename_symbol.js";
import { buildFailureReport, buildSuccessReport, ghostUnknownPeers } from "./report.js";
import {
  canonicalizeSourceForSnapshot,
  omittedBlobsFromExternalizedUnits,
  sha256HexOfCanonicalSource,
  JS_ADAPTER_FINGERPRINT,
} from "./snapshot.js";
import type {
  AdapterFingerprint,
  LogicalUnit,
  OmittedBlob,
  ValidationEntry,
  ValidationReport,
  V0Op,
  WorkspaceSnapshot,
} from "./types.js";

function posixNormalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

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
    ...ghostUnknownPeers(),
  };
}

function mergeOmitted(a: OmittedBlob[], b: OmittedBlob[]): OmittedBlob[] {
  return [...a, ...b].sort((x, y) =>
    x.ref.localeCompare(y.ref) || x.bytes - y.bytes || x.reason.localeCompare(y.reason),
  );
}

function applyingAdapterFingerprint(): AdapterFingerprint {
  return { ...JS_ADAPTER_FINGERPRINT };
}

/**
 * Atomic v0 apply for JavaScript: validate §9 gates, then run ops sequentially;
 * on any failure, restore original file bytes from before the batch.
 */
export async function applyBatch(input: ApplyBatchInput): Promise<ValidationReport> {
  const { snapshot, ops, snapshotRootPath, toolchainFingerprintAtApply } = input;
  const adapter = snapshot.adapter;

  const omittedOnInput = (): OmittedBlob[] => omittedBlobsFromExternalizedUnits(snapshot);

  // Gate 1: on-disk grammar artifact digest.
  try {
    assertJsGrammarDigestPinned();
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

  // Gate 2: snapshot grammar digest must match applying adapter.
  if (snapshot.grammar_digest !== JS_GRAMMAR_DIGEST) {
    return buildFailureReport({
      snapshot_id: snapshot.snapshot_id,
      adapter,
      toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
      entries: [
        entry(
          "grammar_mismatch",
          `[gate:snapshot_grammar_digest] WorkspaceSnapshot.grammar_digest (${snapshot.grammar_digest}) does not match applying adapter (${JS_GRAMMAR_DIGEST}); snapshot may be stale or produced by a different toolchain.`,
          null,
          null,
        ),
      ],
      omitted_due_to_size: omittedOnInput(),
    });
  }

  // Gate 3: adapter fingerprint match.
  const expected = JS_ADAPTER_FINGERPRINT;
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
          "AdapterFingerprint on snapshot does not match applying js-adapter build (v0); use a snapshot from this adapter or upgrade.",
          null,
          null,
        ),
      ],
      omitted_due_to_size: omittedOnInput(),
    });
  }

  // Gate 4: batch size.
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

  // Gate 5: snapshot_content_mismatch — verify on-disk files match snapshot SHA.
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
  const renameSurfaceEntries: ValidationEntry[] = [];
  const fetchUnavailableOmitted: OmittedBlob[] = [];
  const blobPrefetchWarnings: ValidationEntry[] = [];
  const parseScopeEntries: ValidationEntry[] = [];

  function failureOmitted(): OmittedBlob[] {
    return mergeOmitted(omittedOnInput(), fetchUnavailableOmitted);
  }

  async function prefetchExternalizedBlob(unit: LogicalUnit, opIndex: number): Promise<void> {
    if (unit.blob_ref == null) return;
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
          ...ghostUnknownPeers(),
        });
        if (unit.blob_bytes != null) {
          fetchUnavailableOmitted.push({ ref: unit.blob_ref, bytes: unit.blob_bytes, reason: "unavailable" });
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
        ...ghostUnknownPeers(),
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
      ...ghostUnknownPeers(),
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
            message: `[id_superseded] op target ${tr.supersededFrom} was resolved to ${tr.unit.id} via id_resolve; verify op intent`,
            op_index: opIndex,
            target_id: tr.supersededFrom,
            check_scope: "file",
            confidence: "canonical",
            evidence: { resolved_to: tr.unit.id },
            ...ghostUnknownPeers(),
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
        parseScopeEntries.push({
          code: "parse_scope_file",
          severity: "info",
          message: "Parse check ran on edited file only.",
          op_index: opIndex,
          target_id: op.target_id,
          check_scope: "file",
          confidence: "canonical",
          evidence: null,
          ...ghostUnknownPeers(),
        });
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
            message: `[id_superseded] op target ${tr.supersededFrom} was resolved to ${tr.unit.id} via id_resolve; verify op intent`,
            op_index: opIndex,
            target_id: tr.supersededFrom,
            check_scope: "file",
            confidence: "canonical",
            evidence: { resolved_to: tr.unit.id },
            ...ghostUnknownPeers(),
          });
        }
        const unit = tr.unit;
        await prefetchExternalizedBlob(unit, opIndex);
        const r = await applyRenameSymbol({
          snapshotRootPath,
          snapshot: current,
          unit,
          newName: op.new_name,
          cross_file: op.cross_file,
          materialize: { previousSnapshot: current },
        });
        if (!r.ok) {
          await restoreDisk();
          const code: ValidationEntry["code"] =
            r.code === "lang.js.rename_unsupported_node_kind"
              ? "lang.js.rename_unsupported_node_kind"
              : "parse_error";
          return buildFailureReport({
            snapshot_id: snapshot.snapshot_id,
            adapter,
            toolchain_fingerprint_at_apply: toolchainFingerprintAtApply,
            entries: [entry(code, r.message, opIndex, op.target_id)],
            omitted_due_to_size: failureOmitted(),
          });
        }
        current = r.nextSnapshot;
        Object.assign(mergedDelta, r.id_resolve_delta);
        const rs = r.rename_surface_report;
        const scope: ValidationEntry["check_scope"] = op.cross_file ? "project" : "file";
        renameSurfaceEntries.push({
          code: "parse_scope_file",
          severity: "info",
          message: "rename_symbol completed; see rename_surface_report for found/rewritten/skipped.",
          op_index: opIndex,
          target_id: op.target_id,
          check_scope: scope,
          confidence: "canonical",
          evidence: null,
          rename_surface_report: rs,
          ...ghostUnknownPeers(),
        });
        if (op.cross_file && rs.found > CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD) {
          renameSurfaceEntries.push({
            code: "lang.js.cross_file_rename_broad_match",
            severity: "warning",
            message: `cross_file rename matched many name occurrences (found=${rs.found}, threshold=${CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD}); review all touched files before commit — many may be false positives.`,
            op_index: opIndex,
            target_id: op.target_id,
            check_scope: "project",
            confidence: "canonical",
            evidence: { found: rs.found, threshold: CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD },
            ...ghostUnknownPeers(),
          });
        }
        if (rs.skipped.length > 0) {
          renameSurfaceEntries.push({
            code: "rename_surface_skipped_refs",
            severity: "warning",
            message:
              "rename_symbol skipped one or more matching identifiers (string/comment context); inspect rename_surface_report.skipped.",
            op_index: opIndex,
            target_id: op.target_id,
            check_scope: scope,
            confidence: "canonical",
            evidence: null,
            ...ghostUnknownPeers(),
          });
        }
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
            message: `[id_superseded] op target ${tr.supersededFrom} was resolved to ${tr.unit.id} via id_resolve; verify op intent`,
            op_index: opIndex,
            target_id: tr.supersededFrom,
            check_scope: "file",
            confidence: "canonical",
            evidence: { resolved_to: tr.unit.id },
            ...ghostUnknownPeers(),
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
                ...ghostUnknownPeers(),
              },
            ],
            omitted_due_to_size: failureOmitted(),
          });
        }
        current = r.nextSnapshot;
        Object.assign(mergedDelta, r.id_resolve_delta);
        parseScopeEntries.push({
          code: "parse_scope_file",
          severity: "info",
          message: "move_unit completed; parse check file scope.",
          op_index: opIndex,
          target_id: op.target_id,
          check_scope: "file",
          confidence: "canonical",
          evidence: null,
          ...ghostUnknownPeers(),
        });
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

    const omittedFinal = mergeOmitted(
      omittedBlobsFromExternalizedUnits(current),
      fetchUnavailableOmitted,
    );

    const successEntries: ValidationEntry[] = [
      ...idSupersededWarnings,
      ...parseScopeEntries,
      ...renameSurfaceEntries,
    ];

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
        ...ghostUnknownPeers(),
      });
    }
    successEntries.push(...blobPrefetchWarnings);

    const hasParseScopeFile =
      parseScopeEntries.some((e) => e.code === "parse_scope_file") ||
      renameSurfaceEntries.some((e) => e.code === "parse_scope_file");
    if (!hasParseScopeFile) {
      successEntries.push({
        code: "parse_scope_file",
        severity: "info",
        message: "Parse check ran on edited file(s) only.",
        op_index: null,
        target_id: null,
        check_scope: "file",
        confidence: "canonical",
        evidence: null,
        ...ghostUnknownPeers(),
      });
    }

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
