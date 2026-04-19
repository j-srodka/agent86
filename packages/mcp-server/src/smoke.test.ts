import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LogicalUnit, ValidationEntry, ValidationReport } from "ts-adapter";

import type { CombinedWorkspaceSnapshot } from "./combined-snapshot.js";
import { wireAgent86Tools } from "./index.js";
import type { SessionState } from "./session.js";

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
  await writeFile(
    join(dir, "src", "smoke.js"),
    `export function jsAlpha() {\n  return 1;\n}\n\nexport function jsBeta() {\n  return 2;\n}\n`,
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
  it("materialize_snapshot records skipped_jsx_paths when a .jsx file is present", async () => {
    await withSmokeClient(async (client, root) => {
      await writeFile(join(root, "src", "skip.jsx"), "export const x = <div />;\n", "utf8");
      const res = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const snap = firstTextJson(res) as CombinedWorkspaceSnapshot & { skipped_jsx_paths?: string[] };
      expect(Array.isArray(snap.skipped_jsx_paths)).toBe(true);
      expect(snap.skipped_jsx_paths?.some((p) => p.endsWith("skip.jsx"))).toBe(true);
    });
  });

  it("materialize_snapshot mixed fixture includes ts, py, and js units and grammar_digests", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const snap = firstTextJson(res) as CombinedWorkspaceSnapshot;
      expect(snap.grammar_digests?.ts).toBeTruthy();
      expect(snap.grammar_digests?.py).toBeTruthy();
      expect(snap.grammar_digests?.js).toBeTruthy();
      const paths = new Set(snap.units.map((u: LogicalUnit) => u.file_path));
      expect(paths.has("src/smoke.ts")).toBe(true);
      expect(paths.has("src/smoke.py")).toBe(true);
      expect(paths.has("src/smoke.js")).toBe(true);
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

  it("list_units with file_path filter returns only units for that .js path", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "list_units",
        arguments: { root_path: root, file_path: "src/smoke.js" },
      });
      expect(res.isError).not.toBe(true);
      const units = firstTextJson(res) as LogicalUnit[];
      expect(units.length).toBeGreaterThan(0);
      expect(units.every((u) => u.file_path === "src/smoke.js")).toBe(true);
    });
  });

  it("list_units on mixed snapshot returns union of ts, py, and js units", async () => {
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
      expect(paths.has("src/smoke.js")).toBe(true);
    });
  });

  it("search_units returns unit_refs for ts function name match", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "search_units",
        arguments: {
          root_path: root,
          criteria: { kind: "function", name: "alpha" },
        },
      });
      expect(res.isError).not.toBe(true);
      const body = firstTextJson(res) as {
        unit_refs: Array<{ id: string; file_path: string; kind: string }>;
      };
      expect(body.unit_refs.some((r) => r.file_path === "src/smoke.ts" && r.kind === "function")).toBe(true);
      expect(body.unit_refs.every((r) => typeof r.snapshot_id === "string" && r.snapshot_id.length > 0)).toBe(true);
    });
  });

  it("search_units with snapshot_id reads cached combined snapshot", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(mat.isError).not.toBe(true);
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const res = await client.callTool({
        name: "search_units",
        arguments: {
          root_path: root,
          snapshot_id: snap.snapshot_id,
          criteria: { kind: "function", name: "py_alpha" },
        },
      });
      expect(res.isError).not.toBe(true);
      const body = firstTextJson(res) as { unit_refs: Array<{ file_path: string }> };
      expect(body.unit_refs.some((r) => r.file_path === "src/smoke.py")).toBe(true);
    });
  });

  it("search_units rejects snapshot_id that is not 64-char lowercase hex", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "search_units",
        arguments: {
          root_path: root,
          snapshot_id: `${"0".repeat(63)}G`,
          criteria: { kind: "function", name: "alpha" },
        },
      });
      expect(res.isError).toBe(true);
      const text = (res as { content?: Array<{ type?: string; text?: string }> }).content?.find(
        (c) => c.type === "text" && c.text !== undefined,
      )?.text;
      expect(text).toBeDefined();
      try {
        const err = JSON.parse(text!) as { code?: string };
        expect(err.code).toBe("lang.agent86.invalid_tool_input");
      } catch {
        // MCP JSON-RPC layer may reject invalid params before the handler (plain-text error).
        expect(text!.toLowerCase()).toMatch(/invalid|error|-32602/);
      }
    });
  });

  it("search_units with corrupt cache JSON yields snapshot_cache_miss", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(mat.isError).not.toBe(true);
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const cachePath = join(root, ".agent86", "snapshots", `${snap.snapshot_id}.json`);
      await writeFile(cachePath, "{}", "utf8");
      const res = await client.callTool({
        name: "search_units",
        arguments: {
          root_path: root,
          snapshot_id: snap.snapshot_id,
          criteria: { kind: "function", name: "alpha" },
        },
      });
      expect(res.isError).toBe(true);
      const err = firstTextJson(res) as { code?: string };
      expect(err.code).toBe("lang.agent86.snapshot_cache_miss");
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
        grammar_digests: { ts: string; py: string; js: string };
        manifest_url: string | null;
      };
      expect(summary.grammar_digests.ts).toBeTruthy();
      expect(summary.grammar_digests.py).toBeTruthy();
      expect(summary.grammar_digests.js).toBeTruthy();
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

  it("apply_batch replace_unit on js unit succeeds", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const units = snap.units
        .filter((u: LogicalUnit) => u.file_path === "src/smoke.js")
        .sort((a: LogicalUnit, b: LogicalUnit) => a.start_byte - b.start_byte);
      const victim = units.find((u: LogicalUnit) => u.source_text?.includes("jsBeta"));
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
              new_text: "function jsBeta() {\n  return 99;\n}\n",
            },
          ],
        },
      });
      expect(res.isError).not.toBe(true);
      const report = firstTextJson(res) as ValidationReport;
      expect(report.outcome).toBe("success");
      const text = await readFile(join(root, "src", "smoke.js"), "utf8");
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
            file_path: "src/bad.go",
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

  it("get_session_report before other calls returns zeroed state and valid session_start_iso", async () => {
    await withSmokeClient(async (client) => {
      const res = await client.callTool({ name: "get_session_report", arguments: {} });
      expect(res.isError).not.toBe(true);
      const s = firstTextJson(res) as SessionState;
      expect(s.ops_submitted).toBe(0);
      expect(s.batches_submitted).toBe(0);
      expect(s.snapshots_materialized).toBe(0);
      expect(s.ts_units_seen).toBe(0);
      expect(s.js_units_seen).toBe(0);
      expect(s.session_start_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isNaN(Date.parse(s.session_start_iso))).toBe(false);
    });
  });

  it("get_session_report after materialize_snapshot shows materialization unit counts", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(mat.isError).not.toBe(true);
      firstTextJson(mat);
      const rep = await client.callTool({ name: "get_session_report", arguments: {} });
      expect(rep.isError).not.toBe(true);
      const s = firstTextJson(rep) as SessionState;
      expect(s.snapshots_materialized).toBe(1);
      expect(s.ts_units_seen).toBeGreaterThan(0);
      expect(s.js_units_seen).toBeGreaterThan(0);
    });
  });

  it("get_session_report after materialize_snapshot shows py_units_seen for mixed fixture", async () => {
    await withSmokeClient(async (client, root) => {
      await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const rep = await client.callTool({ name: "get_session_report", arguments: {} });
      const s = firstTextJson(rep) as SessionState;
      expect(s.py_units_seen).toBeGreaterThan(0);
    });
  });

  it("get_session_report after successful apply_batch counts succeeded ops", async () => {
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
      const app = await client.callTool({
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
      expect(app.isError).not.toBe(true);
      expect((firstTextJson(app) as ValidationReport).outcome).toBe("success");
      const rep = await client.callTool({ name: "get_session_report", arguments: {} });
      const s = firstTextJson(rep) as SessionState;
      expect(s.batches_succeeded).toBe(1);
      expect(s.ops_succeeded).toBeGreaterThan(0);
    });
  });

  it("get_session_report after failed apply_batch counts rejection and false_positives_prevented", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      const badId = "0".repeat(64);
      const app = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: snap,
          ops: [{ op: "replace_unit", target_id: badId, new_text: "function x() {}" }],
        },
      });
      expect(app.isError).not.toBe(true);
      expect((firstTextJson(app) as ValidationReport).outcome).toBe("failure");
      const rep = await client.callTool({ name: "get_session_report", arguments: {} });
      const s = firstTextJson(rep) as SessionState;
      expect(s.batches_rejected).toBe(1);
      expect(s.false_positives_prevented).toBe(1);
      expect(Object.keys(s.rejection_codes).length).toBeGreaterThan(0);
    });
  });

  it("get_session_report cumulative: two successes then one failure", async () => {
    await withSmokeClient(async (client, root) => {
      const m0 = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const s0 = firstTextJson(m0) as CombinedWorkspaceSnapshot;
      const ts0 = s0.units
        .filter((u: LogicalUnit) => u.file_path === "src/smoke.ts")
        .sort((a: LogicalUnit, b: LogicalUnit) => a.start_byte - b.start_byte);
      const beta0 = ts0.find((u: LogicalUnit) => u.source_text?.includes("beta"));
      expect(beta0).toBeDefined();
      const a1 = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: s0,
          ops: [
            {
              op: "replace_unit",
              target_id: beta0!.id,
              new_text: "function beta(): number {\n  return 99;\n}\n",
            },
          ],
        },
      });
      expect(a1.isError).not.toBe(true);
      expect((firstTextJson(a1) as ValidationReport).outcome).toBe("success");

      const m1 = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const s1 = firstTextJson(m1) as CombinedWorkspaceSnapshot;
      const ts1 = s1.units
        .filter((u: LogicalUnit) => u.file_path === "src/smoke.ts")
        .sort((a: LogicalUnit, b: LogicalUnit) => a.start_byte - b.start_byte);
      const alpha1 = ts1.find((u: LogicalUnit) => u.source_text?.includes("alpha"));
      expect(alpha1).toBeDefined();
      const a2 = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: s1,
          ops: [
            {
              op: "replace_unit",
              target_id: alpha1!.id,
              new_text: "function alpha(): number {\n  return 77;\n}\n",
            },
          ],
        },
      });
      expect(a2.isError).not.toBe(true);
      expect((firstTextJson(a2) as ValidationReport).outcome).toBe("success");

      const badId = "f".repeat(64);
      const a3 = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot: s1,
          ops: [{ op: "replace_unit", target_id: badId, new_text: "function x() {}" }],
        },
      });
      expect(a3.isError).not.toBe(true);
      expect((firstTextJson(a3) as ValidationReport).outcome).toBe("failure");

      const rep = await client.callTool({ name: "get_session_report", arguments: {} });
      const s = firstTextJson(rep) as SessionState;
      expect(s.batches_submitted).toBe(3);
      expect(s.false_positives_prevented).toBe(1);
    });
  });

  it("materialize_snapshot writes cache file to .agent86/snapshots/<snapshot_id>.json", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      expect(res.isError).not.toBe(true);
      const snap = firstTextJson(res) as CombinedWorkspaceSnapshot;
      const cachePath = join(root, ".agent86", "snapshots", `${snap.snapshot_id}.json`);
      const raw = await readFile(cachePath, "utf8");
      const roundTrip = JSON.parse(raw) as CombinedWorkspaceSnapshot;
      expect(roundTrip.snapshot_id).toBe(snap.snapshot_id);
    });
  });

  it("apply_batch with snapshot_id resolves from cache and succeeds", async () => {
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
          snapshot_id: snap.snapshot_id,
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

  it("apply_batch with snapshot_id after cache file deleted returns lang.agent86.snapshot_cache_miss", async () => {
    await withSmokeClient(async (client, root) => {
      const mat = await client.callTool({
        name: "materialize_snapshot",
        arguments: { root_path: root },
      });
      const snap = firstTextJson(mat) as CombinedWorkspaceSnapshot;
      await unlink(join(root, ".agent86", "snapshots", `${snap.snapshot_id}.json`));
      const units = snap.units
        .filter((u: LogicalUnit) => u.file_path === "src/smoke.ts")
        .sort((a: LogicalUnit, b: LogicalUnit) => a.start_byte - b.start_byte);
      const victim = units.find((u: LogicalUnit) => u.source_text?.includes("beta"));
      expect(victim).toBeDefined();
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          snapshot_id: snap.snapshot_id,
          ops: [
            {
              op: "replace_unit",
              target_id: victim!.id,
              new_text: "function beta(): number {\n  return 99;\n}\n",
            },
          ],
        },
      });
      expect(res.isError).toBe(true);
      const payload = firstTextJson(res) as { code: string; message: string };
      expect(payload.code).toBe("lang.agent86.snapshot_cache_miss");
      expect(payload.message.toLowerCase()).toContain("re-run materialize_snapshot");
    });
  });

  it("apply_batch with both snapshot_id and snapshot returns tool error", async () => {
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
          snapshot_id: snap.snapshot_id,
          snapshot: snap,
          ops: [],
        },
      });
      expect(res.isError).toBe(true);
      expect((firstTextJson(res) as { code: string }).code).toBe("lang.agent86.invalid_tool_input");
    });
  });

  it("apply_batch with neither snapshot_id nor snapshot returns tool error", async () => {
    await withSmokeClient(async (client, root) => {
      const res = await client.callTool({
        name: "apply_batch",
        arguments: {
          root_path: root,
          ops: [
            {
              op: "replace_unit",
              target_id: "0".repeat(64),
              new_text: "function x() {}",
            },
          ],
        },
      });
      expect(res.isError).toBe(true);
      expect((firstTextJson(res) as { code: string }).code).toBe("lang.agent86.invalid_tool_input");
    });
  });
});
