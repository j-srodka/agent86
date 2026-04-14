import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";

import { materializeCombinedSnapshot } from "../combined-snapshot.js";
import { jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { listUnitsInputSchema } from "../schemas.js";
import { assertSupportedLanguage } from "../router.js";

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function registerTool(server: McpServer): void {
  server.registerTool(
    "list_units",
    {
      description:
        "List Tier I LogicalUnit records for a workspace root (materializes internally). Optional file_path filters to one source file. Sorted by file_path then start_byte.",
      inputSchema: listUnitsInputSchema,
    },
    async (raw: unknown) => {
      const parsed = listUnitsInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => {
        if (parsed.data.file_path !== undefined && parsed.data.file_path !== "") {
          assertSupportedLanguage(toPosixPath(parsed.data.file_path));
        }
        const snap = await materializeCombinedSnapshot({ rootPath: resolve(parsed.data.root_path) });
        let units = snap.units;
        if (parsed.data.file_path !== undefined && parsed.data.file_path !== "") {
          const want = toPosixPath(parsed.data.file_path);
          units = units.filter((u) => u.file_path === want);
        }
        const sorted = [...units].sort((a, b) => {
          const c = a.file_path.localeCompare(b.file_path);
          if (c !== 0) return c;
          return a.start_byte - b.start_byte;
        });
        return jsonToolSuccess(sorted);
      });
    },
  );
}
