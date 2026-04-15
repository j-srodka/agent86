import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runToolHandler, zodToToolInputError } from "../errors.js";
import { getSessionReportInputSchema } from "../schemas.js";
import { sessionState } from "../session.js";

export function registerTool(server: McpServer): void {
  server.registerTool(
    "get_session_report",
    {
      description:
        "Returns a running tally of Agent86 IR activity in this server session: ops submitted, ops succeeded, ops rejected, false positives prevented (batches blocked before any file was written), warning codes seen, and unit counts by language. Call at any time to gauge IR effectiveness. No inputs required.",
      inputSchema: getSessionReportInputSchema,
    },
    async (raw: unknown) => {
      const parsed = getSessionReportInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => ({
        content: [{ type: "text", text: JSON.stringify(sessionState, null, 2) }],
      }));
    },
  );
}
