import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { buildWorkspaceSummary, materializeSnapshot } from "ts-adapter";

import { jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { buildWorkspaceSummaryInputSchema } from "../schemas.js";

export function registerTool(server: McpServer): void {
  server.registerTool(
    "build_workspace_summary",
    {
      description:
        "Build WorkspaceSummary (read path) for a workspace root by materializing then summarizing.",
      inputSchema: buildWorkspaceSummaryInputSchema,
    },
    async (raw: unknown) => {
      const parsed = buildWorkspaceSummaryInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => {
        const root = resolve(parsed.data.root_path);
        const snap = await materializeSnapshot({ rootPath: root });
        const summary = await buildWorkspaceSummary(snap, root);
        return jsonToolSuccess(summary);
      });
    },
  );
}
