import { describe, expect, it } from "vitest";
import { getGeneratedAllowlistPolicy } from "./policies.js";
import type { WorkspaceSummary } from "./types.js";

describe("getGeneratedAllowlistPolicy", () => {
  it('defaults absent field to "error" (section 6.1 fail-safe)', () => {
    expect(getGeneratedAllowlistPolicy({})).toBe("error");
  });

  it("reads explicit warning from policies object", () => {
    expect(
      getGeneratedAllowlistPolicy({
        generated_allowlist_insufficient_assertions: "warning",
      }),
    ).toBe("warning");
  });

  it("reads explicit error from policies object", () => {
    expect(
      getGeneratedAllowlistPolicy({
        generated_allowlist_insufficient_assertions: "error",
      }),
    ).toBe("error");
  });

  it("uses nested policies from WorkspaceSummary", () => {
    const summary: WorkspaceSummary = {
      snapshot_id: "snap:1",
      grammar_digest: "digest:stub",
      max_batch_ops: 50,
      generated_file_count: 0,
      has_generated_files: false,
      manifest_url: null,
      policies: { generated_allowlist_insufficient_assertions: "warning" },
      blob_cache_path: "/tmp/.cache/blobs",
      omitted_due_to_size: [],
    };
    expect(getGeneratedAllowlistPolicy(summary)).toBe("warning");
  });

  it("treats absent nested policy as error", () => {
    const summary: WorkspaceSummary = {
      snapshot_id: "snap:1",
      grammar_digest: "digest:stub",
      max_batch_ops: 50,
      generated_file_count: 0,
      has_generated_files: false,
      manifest_url: null,
      policies: {},
      blob_cache_path: "/tmp/.cache/blobs",
      omitted_due_to_size: [],
    };
    expect(getGeneratedAllowlistPolicy(summary)).toBe("error");
  });
});
