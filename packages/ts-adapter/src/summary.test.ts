import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getGeneratedAllowlistPolicy } from "./policies.js";
import { materializeSnapshot } from "./snapshot.js";
import { buildWorkspaceSummary } from "./summary.js";
import type { WorkspaceSummary } from "./types.js";

describe("buildWorkspaceSummary (Task 4)", () => {
  it("includes snapshot_id, grammar_digest, max_batch_ops, manifest_url null, explicit error policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-sum-"));
    await writeFile(join(dir, "m.ts"), `export function x(): void {}\n`, "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    const summary = await buildWorkspaceSummary(snap, dir);
    expect(summary.snapshot_id).toBe(snap.snapshot_id);
    expect(summary.grammar_digest).toBe(snap.grammar_digest);
    expect(summary.max_batch_ops).toBe(snap.adapter.max_batch_ops);
    expect(summary.manifest_url).toBeNull();
    expect(summary.policies.generated_allowlist_insufficient_assertions).toBe("error");
    const json = JSON.parse(JSON.stringify(summary)) as WorkspaceSummary;
    expect(json.manifest_url).toBeNull();
    expect(json.policies.generated_allowlist_insufficient_assertions).toBe("error");
  });

  it("sets manifest_url to file URL when agent-ir.manifest.json exists (Task 10)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-sum-"));
    await writeFile(join(dir, "m.ts"), `export function x(): void {}\n`, "utf8");
    await writeFile(join(dir, "agent-ir.manifest.json"), "{}\n", "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    const summary = await buildWorkspaceSummary(snap, dir);
    expect(summary.manifest_url).toMatch(/^file:/);
  });

  it("legacy-shaped summary omitting policies still resolves allowlist policy to error", () => {
    const legacy = {
      snapshot_id: "s",
      grammar_digest: "g",
      max_batch_ops: 50,
      manifest_url: null,
      policies: {},
    } as WorkspaceSummary;
    expect(getGeneratedAllowlistPolicy(legacy)).toBe("error");
  });
});
