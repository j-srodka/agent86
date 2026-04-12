import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { applyBatch } from "./apply.js";
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
  });
});
