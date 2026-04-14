import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";

import { materializeCombinedSnapshot } from "../combined-snapshot.js";
import { jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { materializeSnapshotInputSchema } from "../schemas.js";

export function registerTool(server: McpServer): void {
  server.registerTool(
    "materialize_snapshot",
    {
      description:
        "Materialize a WorkspaceSnapshot for a workspace root (ts-adapter for .ts, py-adapter for .py). Returns full snapshot JSON including grammar_digests.",
      inputSchema: materializeSnapshotInputSchema,
    },
    async (raw: unknown) => {
      const parsed = materializeSnapshotInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => {
        const snap = await materializeCombinedSnapshot({
          rootPath: resolve(parsed.data.root_path),
          inline_threshold_bytes: parsed.data.inline_threshold_bytes,
        });
        return jsonToolSuccess(snap);
      });
    },
  );
}
