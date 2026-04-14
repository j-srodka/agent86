import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { applyBatch, type AdapterFingerprint } from "ts-adapter";

import { jsonToolError, jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { applyBatchInputSchema } from "../schemas.js";
import { isV0OpArray, isWorkspaceSnapshot } from "../snapshot-guards.js";

function fingerprintToAuditString(fp: AdapterFingerprint): string {
  return JSON.stringify({
    grammar_digest: fp.grammar_digest,
    max_batch_ops: fp.max_batch_ops,
    name: fp.name,
    semver: fp.semver,
  });
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
        if (!isWorkspaceSnapshot(snapshot)) {
          return jsonToolError({
            code: "lang.agent86.invalid_tool_input",
            message: "snapshot is not a valid WorkspaceSnapshot shape.",
            evidence: { field: "snapshot" },
          });
        }
        if (!isV0OpArray(ops)) {
          return jsonToolError({
            code: "lang.agent86.invalid_tool_input",
            message: "ops must be an array of supported op objects (replace_unit, rename_symbol, move_unit).",
            evidence: { field: "ops" },
          });
        }
        const toolchain =
          toolchain_fingerprint_at_apply !== undefined
            ? fingerprintToAuditString(toolchain_fingerprint_at_apply)
            : fingerprintToAuditString(snapshot.adapter);
        const report = await applyBatch({
          snapshotRootPath: resolve(root_path),
          snapshot,
          ops,
          toolchainFingerprintAtApply: toolchain,
        });
        return jsonToolSuccess(report);
      });
    },
  );
}
