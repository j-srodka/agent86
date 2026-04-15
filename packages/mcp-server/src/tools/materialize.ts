import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";

import { materializeCombinedSnapshot } from "../combined-snapshot.js";
import { jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { materializeSnapshotInputSchema } from "../schemas.js";
import { recordMaterialize } from "../session.js";

export function registerTool(server: McpServer): void {
  server.registerTool(
    "materialize_snapshot",
    {
      description:
        "ALWAYS call this tool at the start of any coding session before reading, editing, or analyzing .ts, .js, .mjs, .cjs, or .py files. Builds a content-addressed WorkspaceSnapshot of root_path required by all other Agent86 tools. Call once per session; re-call only if files change outside of apply_batch. Required input: root_path (absolute path to the project directory you are editing).",
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
        recordMaterialize(snap);
        return jsonToolSuccess(snap);
      });
    },
  );
}
