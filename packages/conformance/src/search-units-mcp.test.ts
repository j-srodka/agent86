import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { declaredNameFromUnitSource } from "ts-adapter";
import type { WorkspaceSnapshot } from "ts-adapter";

import { wireAgent86Tools } from "@agent86/mcp-server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const fixturesDir = join(pkgRoot, "fixtures");

function firstTextJson(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((c) => c.type === "text" && c.text !== undefined);
  if (!block?.text) throw new Error("expected text content");
  return JSON.parse(block.text) as unknown;
}

describe("search_units MCP golden", () => {
  it("returns UnitRef id matching materialized snapshot unit for known function", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new McpServer(
      { name: "agent86-mcp-conf", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    wireAgent86Tools(server);
    const client = new Client({ name: "agent86-conf-client", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const dir = await mkdtemp(join(tmpdir(), "agent86-search-golden-"));
    try {
      await copyFile(join(fixturesDir, "search_units_golden.ts"), join(dir, "search_units_golden.ts"));

      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: dir },
      });
      expect(mat.isError).not.toBe(true);
      const snap = firstTextJson(mat) as WorkspaceSnapshot;

      const expected = snap.units.find((u) => {
        if (!u.file_path.endsWith("search_units_golden.ts")) return false;
        if (u.source_text === null) return false;
        return declaredNameFromUnitSource(u.source_text) === "conformanceSearchGoldenFn";
      });
      expect(expected).toBeTruthy();

      const search = await client.callTool({
        name: "search_units",
        arguments: {
          root_path: dir,
          criteria: { kind: "function", name: "conformanceSearchGoldenFn" },
        },
      });
      expect(search.isError).not.toBe(true);
      const body = firstTextJson(search) as { unit_refs: Array<{ id: string; snapshot_id: string }> };
      expect(body.unit_refs.length).toBeGreaterThanOrEqual(1);
      const hit = body.unit_refs.find((r) => r.id === expected!.id);
      expect(hit).toBeTruthy();
      expect(hit!.snapshot_id).toBe(snap.snapshot_id);
    } finally {
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
