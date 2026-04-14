import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { applyBatch as pyApplyBatch } from "@agent86/py-adapter";
import type { ValidationEntry, ValidationReport, V0Op, WorkspaceSnapshot } from "ts-adapter";
import {
  applyBatch as tsApplyBatch,
  type AdapterFingerprint,
  buildFailureReport,
  ghostUnknownPeers,
  omittedBlobsFromExternalizedUnits,
  resolveOpTarget,
} from "ts-adapter";

import {
  buildPyApplySubset,
  buildTsApplySubset,
  materializeCombinedSnapshot,
  type CombinedWorkspaceSnapshot,
} from "../combined-snapshot.js";
import { jsonToolError, jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { assertSupportedLanguage, languageForPath } from "../router.js";
import { applyBatchInputSchema } from "../schemas.js";
import { recordApplyBatch } from "../session.js";
import { isV0OpArray, isWorkspaceSnapshot } from "../snapshot-guards.js";

function fingerprintToAuditString(fp: AdapterFingerprint): string {
  return JSON.stringify({
    grammar_digest: fp.grammar_digest,
    max_batch_ops: fp.max_batch_ops,
    name: fp.name,
    semver: fp.semver,
  });
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

function remapOpIndices(entries: ValidationEntry[], batchIndexToOriginal: number[]): ValidationEntry[] {
  return entries.map((e) => {
    if (e.op_index === null) return e;
    const mapped = batchIndexToOriginal[e.op_index];
    if (mapped === undefined) return e;
    return { ...e, op_index: mapped };
  });
}

function mergeOmitted(
  a: ValidationReport["omitted_due_to_size"],
  b: ValidationReport["omitted_due_to_size"],
): ValidationReport["omitted_due_to_size"] {
  return [...a, ...b].sort((x, y) =>
    x.ref.localeCompare(y.ref) || x.bytes - y.bytes || x.reason.localeCompare(y.reason),
  );
}

function isCombinedSnapshotInput(v: unknown): v is CombinedWorkspaceSnapshot {
  if (!isWorkspaceSnapshot(v)) return false;
  const o = v as unknown as Record<string, unknown>;
  if (o.grammar_digests === undefined) return true;
  if (typeof o.grammar_digests !== "object" || o.grammar_digests === null) return false;
  const g = o.grammar_digests as Record<string, unknown>;
  return typeof g.ts === "string" && typeof g.py === "string";
}

function applyBatchToolSuccess(report: ValidationReport, opCount: number): CallToolResult {
  recordApplyBatch(report, opCount);
  return jsonToolSuccess(report);
}

export function registerTool(server: McpServer): void {
  server.registerTool(
    "apply_batch",
    {
      description:
        "Apply a batch of v0/v1 ops against a caller-supplied WorkspaceSnapshot. Returns ValidationReport JSON; normative adapter failures use report outcome and entries[].code (not MCP transport errors).",
      inputSchema: applyBatchInputSchema,
    },
    async (raw: unknown) => {
      const parsed = applyBatchInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => {
        const { root_path, snapshot, ops, toolchain_fingerprint_at_apply } = parsed.data;
        if (!isCombinedSnapshotInput(snapshot)) {
          return jsonToolError({
            code: "lang.agent86.invalid_tool_input",
            message: "snapshot is not a valid WorkspaceSnapshot shape.",
            evidence: { field: "snapshot" },
          });
        }
        const combined = snapshot as CombinedWorkspaceSnapshot;
        if (!isV0OpArray(ops)) {
          return jsonToolError({
            code: "lang.agent86.invalid_tool_input",
            message: "ops must be an array of supported op objects (replace_unit, rename_symbol, move_unit).",
            evidence: { field: "ops" },
          });
        }

        const typedOps = ops as V0Op[];
        const toolchain =
          toolchain_fingerprint_at_apply !== undefined
            ? fingerprintToAuditString(toolchain_fingerprint_at_apply)
            : fingerprintToAuditString(combined.adapter);

        if (typedOps.length > combined.adapter.max_batch_ops) {
          return applyBatchToolSuccess(
            buildFailureReport({
              snapshot_id: combined.snapshot_id,
              adapter: combined.adapter,
              toolchain_fingerprint_at_apply: toolchain,
              entries: [
                {
                  code: "batch_size_exceeded",
                  severity: "error",
                  message: `op batch length ${typedOps.length} exceeds max_batch_ops ${combined.adapter.max_batch_ops}`,
                  op_index: null,
                  target_id: null,
                  check_scope: "file",
                  confidence: "canonical",
                  evidence: null,
                  ...ghostUnknownPeers(),
                },
              ],
              omitted_due_to_size: omittedBlobsFromExternalizedUnits(combined),
            }),
            typedOps.length,
          );
        }

        const snapView = combined as unknown as WorkspaceSnapshot;

        for (let opIndex = 0; opIndex < typedOps.length; opIndex++) {
          const op = typedOps[opIndex]!;
          const tr = resolveOpTarget(snapView, op.target_id);
          if (tr.kind === "ghost" || tr.kind === "unknown") {
            return applyBatchToolSuccess(
              buildFailureReport({
                snapshot_id: combined.snapshot_id,
                adapter: combined.adapter,
                toolchain_fingerprint_at_apply: toolchain,
                entries: [resolveFailureEntry(tr, opIndex)],
                omitted_due_to_size: omittedBlobsFromExternalizedUnits(combined),
              }),
              typedOps.length,
            );
          }
          assertSupportedLanguage(tr.unit.file_path);
        }

        const tsOps: { op: V0Op; originalIndex: number }[] = [];
        const pyOps: { op: V0Op; originalIndex: number }[] = [];
        for (let i = 0; i < typedOps.length; i++) {
          const op = typedOps[i]!;
          const tr = resolveOpTarget(snapView, op.target_id);
          if (tr.kind !== "live") continue;
          const lang = languageForPath(tr.unit.file_path);
          if (lang === "ts") tsOps.push({ op, originalIndex: i });
          else if (lang === "py") pyOps.push({ op, originalIndex: i });
        }

        const tsSubset = buildTsApplySubset(combined);
        const pySubset = buildPyApplySubset(combined);

        const allEntries: ValidationEntry[] = [];
        let mergedOmitted = omittedBlobsFromExternalizedUnits(combined);
        let mergedDelta: Record<string, string> = {};
        let anyFailure = false;

        if (tsOps.length > 0) {
          const tsReport = await tsApplyBatch({
            snapshotRootPath: resolve(root_path),
            snapshot: tsSubset,
            ops: tsOps.map((o) => o.op),
            toolchainFingerprintAtApply: toolchain,
          });
          allEntries.push(
            ...remapOpIndices(
              tsReport.entries,
              tsOps.map((o) => o.originalIndex),
            ),
          );
          mergedOmitted = mergeOmitted(mergedOmitted, tsReport.omitted_due_to_size);
          mergedDelta = { ...mergedDelta, ...tsReport.id_resolve_delta };
          if (tsReport.outcome !== "success") anyFailure = true;
        }

        if (!anyFailure && pyOps.length > 0) {
          const pyReport = await pyApplyBatch({
            snapshotRootPath: resolve(root_path),
            snapshot: pySubset,
            ops: pyOps.map((o) => o.op),
            toolchainFingerprintAtApply: toolchain,
          });
          allEntries.push(
            ...remapOpIndices(
              pyReport.entries,
              pyOps.map((o) => o.originalIndex),
            ),
          );
          mergedOmitted = mergeOmitted(mergedOmitted, pyReport.omitted_due_to_size);
          mergedDelta = { ...mergedDelta, ...pyReport.id_resolve_delta };
          if (pyReport.outcome !== "success") anyFailure = true;
        }

        let nextId: string | null = null;
        if (!anyFailure) {
          const nextCombined = await materializeCombinedSnapshot({
            rootPath: resolve(root_path),
          });
          nextId = nextCombined.snapshot_id;
        }

        const report: ValidationReport = {
          snapshot_id: combined.snapshot_id,
          adapter: combined.adapter,
          outcome: anyFailure ? "failure" : "success",
          next_snapshot_id: nextId,
          id_resolve_delta: mergedDelta,
          entries: allEntries,
          omitted_due_to_size: mergedOmitted,
          toolchain_fingerprint_at_apply: toolchain,
        };

        return applyBatchToolSuccess(report, typedOps.length);
      });
    },
  );
}
