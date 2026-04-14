import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LogicalUnit, ValidationEntry, ValidationReport } from "ts-adapter";

import type { CombinedWorkspaceSnapshot } from "./combined-snapshot.js";
import { wireAgent86Tools } from "./index.js";

function firstTextJson(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const block = r.content?.find((c) => c.type === "text" && c.text !== undefined);
  if (!block?.text) throw new Error("expected text content");
  return JSON.parse(block.text) as unknown;
}

async function withSmokeClient<T>(fn: (client: Client, root: string) => Promise<T>): Promise<T> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new McpServer(
    { name: "agent86-mcp-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  wireAgent86Tools(server);
  const client = new Client({ name: "agent86-mcp-smoke", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const dir = await mkdtemp(join(tmpdir(), "agent86-mcp-smoke-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "smoke.ts"),
    `export function alpha(): number {\n  return 1;\n}\n\nexport function beta(): number {\n  return 2;\n}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "src", "smoke.py"),
    `def py_alpha():\n    return 1\n\ndef py_beta():\n    return 2\n`,
    "utf8",
  );
  try {
    return await fn(client, dir);
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mcp-server smoke", () => {
  it("materialize_snapshot mixed fixture includes ts and py units and grammar_digests", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const snap = firstTextJson(res) as CombinedWorkspaceSnapshot;
      expect(snap.grammar_digests?.ts).toBeTruthy();
      expect(snap.grammar_digests?.py).toBeTruthy();
      const paths = new Set(snap.units.map((u: LogicalUnit) => u.file_path));
      expect(paths.has("src/smoke.ts")).toBe(true);
      expect(paths.has("src/smoke.py")).toBe(true);
    });
  });

  it("list_units returns at least one unit", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "list_units",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const units = firstTextJson(res) as LogicalUnit[];
      expect(Array.isArray(units)).toBe(true);
      expect(units.length).toBeGreaterThan(0);
    });
  });

  it("list_units on mixed snapshot returns union of ts and py units", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "list_units",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const units = firstTextJson(res) as LogicalUnit[];
      const paths = new Set(units.map((u) => u.file_path));
      expect(paths.has("src/smoke.ts")).toBe(true);
      expect(paths.has("src/smoke.py")).toBe(true);
    });
  });

  it("build_workspace_summary includes grammar_digests and manifest_url from ts path", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "build_workspace_summary",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const summary = firstTextJson(res) as {
        grammar_digests: { ts: string; py: string };
        manifest_url: string | null;
      };
      expect(summary.grammar_digests.ts).toBeTruthy();
      expect(summary.grammar_digests.py).toBeTruthy();
      expect(summary).toHaveProperty("manifest_url");
    });
  });

  it("apply_batch replace_unit on ts unit succeeds", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const units = snap.units
        .filter((u: LogicalUnit) => u.file_path === "src/smoke.ts")
        .sort((a: LogicalUnit, b: LogicalUnit) => a.start_byte - b.start_byte);
      const victim = units.find((u: LogicalUnit) => u.source_text?.includes("beta"));
      expect(victim).toBeDefined();
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: snap,
          ops: [
            {
              op: "replace_unit",
              target_id: victim!.id,
              new_text: "function beta(): number {\n  return 99;\n}\n",
            },
          ],
        },
      });
      expect(res.isError).not.toBe(true);
      const report = firstTextJson(res) as ValidationReport;
      expect(report.outcome).toBe("success");
      const text = await readFile(join(root, "src", "smoke.ts"), "utf8");
      expect(text).toContain("99");
    });
  });

  it("apply_batch replace_unit on py unit succeeds", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const units = snap.units
        .filter((u: LogicalUnit) => u.file_path === "src/smoke.py")
        .sort((a: LogicalUnit, b: LogicalUnit) => a.start_byte - b.start_byte);
      const victim = units.find((u: LogicalUnit) => u.source_text?.includes("py_beta"));
      expect(victim).toBeDefined();
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: snap,
          ops: [
            {
              op: "replace_unit",
              target_id: victim!.id,
              new_text: "def py_beta():\n    return 99\n",
            },
          ],
        },
      });
      expect(res.isError).not.toBe(true);
      const report = firstTextJson(res) as ValidationReport;
      expect(report.outcome).toBe("success");
      const text = await readFile(join(root, "src", "smoke.py"), "utf8");
      expect(text).toContain("99");
    });
  });

  it("apply_batch malformed ops yields MCP tool error with lang.agent86.invalid_tool_input", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: snap,
          ops: [{ op: "not_a_real_op", target_id: "x", new_text: "y" }],
        },
      });
      expect(res.isError).toBe(true);
      const payload = firstTextJson(res) as { code: string };
      expect(payload.code).toBe("lang.agent86.invalid_tool_input");
    });
  });

  it("apply_batch invalid target_id yields failure with normative code", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const badId = "0".repeat(64);
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: snap,
          ops: [
            {
              op: "replace_unit",
              target_id: badId,
              new_text: "function x() {}",
            },
          ],
        },
      });
      expect(res.isError).not.toBe(true);
      const report = firstTextJson(res) as ValidationReport;
      expect(report.outcome).toBe("failure");
      const codes = report.entries.map((e: ValidationEntry) => e.code);
      expect(codes).toContain("unknown_or_superseded_id");
    });
  });

  it("apply_batch targeting unsupported extension unit yields lang.agent86.unsupported_file_extension", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const donor = snap.units[0] as LogicalUnit;
      const tampered: CombinedWorkspaceSnapshot = {
        ...snap,
        units: [
          ...snap.units,
          {
            ...donor,
            id: "f".repeat(64),
            file_path: "src/bad.js",
            source_text: "function x() {}",
          } as LogicalUnit,
        ],
      };
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: tampered,
          ops: [
            {
              op: "replace_unit",
              target_id: "f".repeat(64),
              new_text: "y",
            },
          ],
        },
      });
      expect(res.isError).toBe(true);
      const payload = firstTextJson(res) as { code: string };
      expect(payload.code).toBe("lang.agent86.unsupported_file_extension");
    });
  });
});
