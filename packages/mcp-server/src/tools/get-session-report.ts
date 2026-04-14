import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { runToolHandler, zodToToolInputError } from "../errors.js";
import { getSessionReportInputSchema } from "../schemas.js";
import { sessionState } from "../session.js";

export function registerTool(server: McpServer): void {
  server.registerTool(
    "get_session_report",
    {
      description:
        "Returns a running tally of IR activity in this server session: ops submitted/succeeded/rejected, false positives prevented, warning codes seen, and unit counts. Resets on server restart.",
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
