#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { beginMcpServerSession } from "./session.js";
import { registerTool as registerApplyBatch } from "./tools/apply.js";
import { registerTool as registerGetSessionReport } from "./tools/get-session-report.js";
import { registerTool as registerListUnits } from "./tools/list-units.js";
import { registerTool as registerMaterializeSnapshot } from "./tools/materialize.js";
import { registerTool as registerSearchUnits } from "./tools/search-units.js";
import { registerTool as registerWorkspaceSummary } from "./tools/summary.js";

export function wireAgent86Tools(server: McpServer): void {
  beginMcpServerSession();
  registerMaterializeSnapshot(server);
  registerListUnits(server);
  registerSearchUnits(server);
  registerWorkspaceSummary(server);
  registerApplyBatch(server);
  registerGetSessionReport(server);
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "agent86-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  wireAgent86Tools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
const isMain = entryHref !== "" && import.meta.url === entryHref;
if (isMain) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
