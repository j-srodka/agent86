import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalizeSourceForSnapshot, materializeSnapshot } from "./snapshot.js";

describe("materializeSnapshot (Task 3)", () => {
  it("materializes two functions as two units with deterministic snapshot_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-snap-"));
    await writeFile(
      join(dir, "a.ts"),
      `export function one(): number {\n  return 1;\n}\n\nexport function two(): number {\n  return 2;\n}\n`,
      "utf8",
    );
    const a = await materializeSnapshot({ rootPath: dir });
    const b = await materializeSnapshot({ rootPath: dir });
    expect(a.units).toHaveLength(2);
    expect(a.units[0]?.kind).toBe("function_declaration");
    expect(a.units[1]?.kind).toBe("function_declaration");
    expect(a.units[0]?.blob_ref).toBeNull();
    expect(a.units[0]?.source_text).toContain("function one");
    expect(new Set(a.units.map((u) => u.id)).size).toBe(2);
    expect(a.id_resolve[a.units[0]!.id]).toBe(a.units[0]!.id);
    expect(a.snapshot_id).toBe(b.snapshot_id);
    expect(a.files).toHaveLength(1);
    expect(a.skipped_tsx_paths).toEqual([]);
  });

  it("lists .tsx paths in skipped_tsx_paths and does not parse them as .ts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-snap-"));
    await writeFile(
      join(dir, "plain.ts"),
      `export function f(): void {}\n`,
      "utf8",
    );
    await writeFile(join(dir, "ui.tsx"), `export const X = () => <div />;\n`, "utf8");
    const s = await materializeSnapshot({ rootPath: dir });
    expect(s.files.map((f) => f.path).sort()).toEqual(["plain.ts"]);
    expect(s.skipped_tsx_paths).toEqual(["ui.tsx"]);
    expect(s.units).toHaveLength(1);
  });

  it("hashes per-file SHA-256 after CRLF→LF canonicalization (same as LF-only file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-crlf-"));
    const crlfSource = `export function a(): void {}\r\nexport function b(): void {}\r\n`;
    const lfOnly = canonicalizeSourceForSnapshot(crlfSource);
    expect(lfOnly.includes("\r")).toBe(false);
    const expectedSha = createHash("sha256").update(lfOnly, "utf8").digest("hex");
    await writeFile(join(dir, "mix.ts"), crlfSource, "utf8");
    const s = await materializeSnapshot({ rootPath: dir });
    expect(s.files[0]?.sha256).toBe(expectedSha);
    await writeFile(join(dir, "lf.ts"), lfOnly, "utf8");
    const s2 = await materializeSnapshot({ rootPath: dir });
    const lfFile = s2.files.find((f) => f.path === "lf.ts");
    const mixFile = s2.files.find((f) => f.path === "mix.ts");
    expect(lfFile?.sha256).toBe(mixFile?.sha256);
  });
});
