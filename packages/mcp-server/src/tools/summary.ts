import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import {
  buildWorkspaceSummary as buildPyWorkspaceSummary,
  materializeSnapshot as materializePySnapshot,
} from "@agent86/py-adapter";
import { buildWorkspaceSummary as buildTsWorkspaceSummary, materializeSnapshot as materializeTsSnapshot } from "ts-adapter";

import {
  buildPyApplySubset,
  buildTsApplySubset,
  materializeCombinedSnapshot,
} from "../combined-snapshot.js";
import { jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { buildWorkspaceSummaryInputSchema } from "../schemas.js";
import { languageForPath } from "../router.js";

export function registerTool(server: McpServer): void {
  server.registerTool(
    "build_workspace_summary",
    {
      description:
        "Build WorkspaceSummary (read path) for a workspace root by materializing (.ts + .py) then summarizing.",
      inputSchema: buildWorkspaceSummaryInputSchema,
    },
    async (raw: unknown) => {
      const parsed = buildWorkspaceSummaryInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => {
        const root = resolve(parsed.data.root_path);
        const combined = await materializeCombinedSnapshot({ rootPath: root });

        const hasTs = combined.files.some((f) => languageForPath(f.path) === "ts");
        const hasPy = combined.files.some((f) => languageForPath(f.path) === "py");

        const tsSnapForSummary = hasTs ? buildTsApplySubset(combined) : await materializeTsSnapshot({ rootPath: root });
        const pySnapForSummary = hasPy ? buildPyApplySubset(combined) : await materializePySnapshot({ rootPath: root });

        const tsSummary = await buildTsWorkspaceSummary(tsSnapForSummary, root);
        const pySummary = await buildPyWorkspaceSummary(pySnapForSummary, root);

        const generated_file_count = tsSummary.generated_file_count + pySummary.generated_file_count;
        const has_generated_files = tsSummary.has_generated_files || pySummary.has_generated_files;
        const omitted_due_to_size = [...tsSummary.omitted_due_to_size, ...pySummary.omitted_due_to_size].sort((a, b) =>
          a.ref.localeCompare(b.ref),
        );

        const merged = {
          snapshot_id: combined.snapshot_id,
          grammar_digest: combined.grammar_digest,
          grammar_digests: combined.grammar_digests,
          max_batch_ops: tsSummary.max_batch_ops,
          generated_file_count,
          has_generated_files,
          manifest_url: tsSummary.manifest_url,
          policies: tsSummary.policies,
          blob_cache_path: tsSummary.blob_cache_path,
          omitted_due_to_size,
          manifest_strict: tsSummary.manifest_strict,
          manifest_warnings: [...tsSummary.manifest_warnings, ...pySummary.manifest_warnings],
        };

        return jsonToolSuccess(merged);
      });
    },
  );
}
