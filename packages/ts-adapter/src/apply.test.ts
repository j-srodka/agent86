import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
import { getBlobCachePath } from "./blobs.js";
import { materializeSnapshot } from "./snapshot.js";

const toolchain = "toolchain:test-apply";

describe("applyBatch", () => {
  it("replace_unit updates file and returns success with new snapshot_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(
      join(dir, "f.ts"),
      `export function keep(): number {\n  return 0;\n}\n\nexport function victim(): number {\n  return 1;\n}\n`,
      "utf8",
    );
    const snap = await materializeSnapshot({ rootPath: dir });
    const inFile = snap.units
      .filter((u) => u.file_path === "f.ts")
      .sort((a, b) => a.start_byte - b.start_byte);
    const victim = inFile[1];
    expect(victim).toBeDefined();
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [
        {
          op: "replace_unit",
          target_id: victim!.id,
          // Unit span is the function_declaration node (starts at `function`, after `export `).
          new_text: "function victim(): number {\n  return 99;\n}\n",
        },
      ],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("success");
    expect(report.next_snapshot_id).not.toBeNull();
    expect(report.next_snapshot_id).not.toBe(snap.snapshot_id);
    const after = await materializeSnapshot({ rootPath: dir });
    expect(after.snapshot_id).toBe(report.next_snapshot_id);
    const treeText = await readFile(join(dir, "f.ts"), "utf8");
    expect(treeText).toContain("99");
  });

  it("rename_symbol renames function and identifier calls; naive string replace would break a string literal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(
      join(dir, "homonym.ts"),
      `export function victim(): number {\n  return victim();\n}\nconst lit = "victim";\n`,
      "utf8",
    );
    const snap = await materializeSnapshot({ rootPath: dir });
    const u = snap.units.find((k) => k.file_path === "homonym.ts");
    expect(u).toBeDefined();
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [{ op: "rename_symbol", target_id: u!.id, new_name: "renamedFn" }],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("success");
    const text = await readFile(join(dir, "homonym.ts"), "utf8");
    expect(text).toContain("export function renamedFn()");
    expect(text).toContain("return renamedFn()");
    expect(text).toContain('"victim"');
    expect(text.includes("function victim")).toBe(false);
  });

  it("rejects rename_symbol on method_definition (v0)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(
      join(dir, "cls.ts"),
      `class C {\n  m(): void {}\n}\n`,
      "utf8",
    );
    const snap = await materializeSnapshot({ rootPath: dir });
    const m = snap.units.find((k) => k.kind === "method_definition");
    expect(m).toBeDefined();
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [{ op: "rename_symbol", target_id: m!.id, new_name: "n" }],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries[0]?.code).toBe("op_vocabulary_unsupported");
    expect(report.entries[0]?.message).toContain("not supported in v0");
  });

  it("Task 7: grammar_mismatch when snapshot grammar_digest does not match applying adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(join(dir, "x.ts"), `export function f(): void {}\n`, "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    const tampered = { ...snap, grammar_digest: "0".repeat(64) };
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: tampered,
      ops: [],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries[0]?.code).toBe("grammar_mismatch");
    expect(report.entries[0]?.message).toContain("[gate:snapshot_grammar_digest]");
  });

  it("Task 7: batch_size_exceeded before touching files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(join(dir, "x.ts"), `export function f(): void {}\n`, "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    const ops = Array.from({ length: 51 }, () => ({
      op: "replace_unit" as const,
      target_id: snap.units[0]!.id,
      new_text: "function f(): void {}\n",
    }));
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops,
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries[0]?.code).toBe("batch_size_exceeded");
  });

  it("Task 7: adapter_version_unsupported when AdapterFingerprint drifts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(join(dir, "x.ts"), `export function f(): void {}\n`, "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    const tampered = {
      ...snap,
      adapter: { ...snap.adapter, name: "foreign-adapter" },
    };
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: tampered,
      ops: [],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries[0]?.code).toBe("adapter_version_unsupported");
  });

  it("replace_unit: leading export in new_text duplicates export and fails parse (caller responsibility)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(
      join(dir, "f.ts"),
      `export function keep(): number {\n  return 0;\n}\n\nexport function victim(): number {\n  return 1;\n}\n`,
      "utf8",
    );
    const snap = await materializeSnapshot({ rootPath: dir });
    const victim = snap.units
      .filter((u) => u.file_path === "f.ts")
      .sort((a, b) => a.start_byte - b.start_byte)[1]!;
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [
        {
          op: "replace_unit",
          target_id: victim.id,
          new_text: "export function victim(): number {\n  return 99;\n}\n",
        },
      ],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries[0]?.code).toBe("parse_error");
  });

  it("v1: blob_unavailable warning when cache file missing; replace_unit still applies from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    const pad = "q".repeat(8200);
    await writeFile(
      join(dir, "huge.ts"),
      `export function huge(): void {\n  // ${pad}\n}\n`,
      "utf8",
    );
    const snap = await materializeSnapshot({ rootPath: dir });
    const u = snap.units[0]!;
    expect(u.blob_ref).toBeTruthy();
    const hex = u.blob_ref!.slice("sha256:".length);
    await rm(join(getBlobCachePath(dir), hex));
    const pad2 = "r".repeat(8200);
    const newText = `function huge(): void {\n  // ${pad2}\n}\n`;
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [{ op: "replace_unit", target_id: u.id, new_text: newText }],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("success");
    const blobEntry = report.entries.find((e) => e.code === "blob_unavailable");
    expect(blobEntry?.message).toContain("re-materialize snapshot");
    expect(report.omitted_due_to_size.some((o) => o.reason === "unavailable")).toBe(true);
  });

  it("v1: snapshot_content_mismatch when on-disk file bytes drift from snapshot.files.sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-apply-"));
    await writeFile(join(dir, "f.ts"), `export function drift(): void {}\n`, "utf8");
    const snap = await materializeSnapshot({ rootPath: dir });
    await writeFile(join(dir, "f.ts"), `export function drift(): void { }\n`, "utf8");
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [],
      toolchainFingerprintAtApply: toolchain,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries[0]?.code).toBe("snapshot_content_mismatch");
    expect(report.entries[0]?.message).toContain("[gate:snapshot_content_mismatch]");
  });
});
