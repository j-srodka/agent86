import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getBlobCachePath } from "./blobs.js";
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
    expect(summary.generated_file_count).toBe(0);
    expect(summary.has_generated_files).toBe(false);
    expect(summary.manifest_url).toBeNull();
    expect(summary.policies.generated_allowlist_insufficient_assertions).toBe("error");
    expect(summary.blob_cache_path).toBe(getBlobCachePath(resolve(dir)));
    expect(summary.omitted_due_to_size).toEqual([]);
    expect(summary.manifest_strict).toBe(false);
    expect(summary.manifest_warnings).toEqual([]);
    const json = JSON.parse(JSON.stringify(summary)) as WorkspaceSummary;
    expect(json).toHaveProperty("omitted_due_to_size");
    expect(Array.isArray(json.omitted_due_to_size)).toBe(true);
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

  it("strictManifest: invalid JSON surfaces manifest_parse_error warning; summary still returns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-sum-"));
    await writeFile(join(dir, "m.ts"), `export function x(): void {}\n`, "utf8");
    await writeFile(join(dir, "agent-ir.manifest.json"), "{ not json }\n", "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    const summary = await buildWorkspaceSummary(snap, dir, { strictManifest: true });
    expect(summary.manifest_strict).toBe(true);
    expect(summary.manifest_url).toMatch(/^file:/);
    expect(summary.manifest_warnings).toHaveLength(1);
    expect(summary.manifest_warnings[0]!.code).toBe("lang.ts.manifest_parse_error");
    expect(summary.manifest_warnings[0]!.severity).toBe("warning");
    expect((summary.manifest_warnings[0]!.evidence as { reason?: string }).reason).toBe("invalid_json");
  });

  it("legacy-shaped summary omitting policies still resolves allowlist policy to error", () => {
    const legacy = {
      snapshot_id: "s",
      grammar_digest: "g",
      max_batch_ops: 50,
      generated_file_count: 0,
      has_generated_files: false,
      manifest_url: null,
      policies: {},
      blob_cache_path: "/x/.cache/blobs",
      omitted_due_to_size: [],
      manifest_strict: false,
      manifest_warnings: [],
    } as WorkspaceSummary;
    expect(getGeneratedAllowlistPolicy(legacy)).toBe("error");
  });
});
