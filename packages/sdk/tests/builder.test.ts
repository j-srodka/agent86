import { describe, expect, it } from "vitest";
import type { AdapterFingerprint, ValidationReport } from "ts-adapter";

import { builder } from "../src/builder.js";
import { phraseForNormativeCode } from "../src/rejection-codes.js";

function stubReport(): ValidationReport {
  return {
    snapshot_id: "snap-a",
    adapter: {
      name: "ts-adapter",
      semver: "0.0.0",
      grammar_digest: "0".repeat(64),
      max_batch_ops: 64,
    },
    outcome: "success",
    next_snapshot_id: "snap-b",
    id_resolve_delta: {},
    entries: [],
    omitted_due_to_size: [],
    toolchain_fingerprint_at_apply: "{}",
  };
}

describe("OpBatchBuilder", () => {
  it("queues ops in fluent call order for apply_batch", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = {
      async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ name, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
        if (name === "apply_batch") return stubReport() as T;
        throw new Error(`unexpected tool ${name}`);
      },
    };

    await builder(transport)
      .renameSymbol({ target_id: "a", new_name: "A1" })
      .replaceUnit({ target_id: "b", new_body: "body" })
      .moveUnit({ target_id: "c", destination_file: "dst.ts", insert_after_id: "z" })
      .apply({ snapshot_id: "snap", root_path: "/tmp/root" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("apply_batch");
    const ops = calls[0]!.args.ops as Array<Record<string, unknown>>;
    expect(ops.map((o) => o.op)).toEqual(["rename_symbol", "replace_unit", "move_unit"]);
    expect(ops[0]).toMatchObject({ op: "rename_symbol", target_id: "a", new_name: "A1" });
    expect(ops[1]).toMatchObject({ op: "replace_unit", target_id: "b", new_text: "body" });
    expect(ops[2]).toMatchObject({
      op: "move_unit",
      target_id: "c",
      destination_file: "dst.ts",
      insert_after_id: "z",
    });
  });

  it("marshals apply_batch with optional toolchain_fingerprint_at_apply", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = {
      async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ name, args });
        if (name === "apply_batch") return stubReport() as T;
        throw new Error(`unexpected tool ${name}`);
      },
    };

    const fp: AdapterFingerprint = {
      name: "ts-adapter",
      semver: "0.0.0",
      grammar_digest: "1".repeat(64),
      max_batch_ops: 64,
    };

    await builder(transport).apply({
      snapshot_id: "snap",
      root_path: "/abs/root",
      toolchain_fingerprint_at_apply: fp,
    });

    expect(calls[0]!.args).toMatchObject({
      root_path: "/abs/root",
      snapshot_id: "snap",
      toolchain_fingerprint_at_apply: fp,
      ops: [],
    });
  });
});

describe("phraseForNormativeCode", () => {
  it("returns a stable phrase for representative §12.1 codes", () => {
    expect(phraseForNormativeCode("batch_size_exceeded")).toContain("max_batch_ops");
    expect(phraseForNormativeCode("id_superseded")).toContain("superseded");
  });
});
