import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyBatch, buildWorkspaceSummary, fetchBlobText, materializeSnapshot } from "ts-adapter";

/**
 * Conformance goldens (implementation plan Task 8).
 * See `docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const fixturesDir = join(pkgRoot, "fixtures");
const materializeScriptPath = join(pkgRoot, "scripts", "materialize-snapshot-json.mjs");

const toolchain = "toolchain:conformance-golden";

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

async function copyFixtureToTemp(fixtureName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent86-conf-"));
  await copyFile(fixturePath(fixtureName), join(dir, fixtureName));
  return dir;
}

describe("Task 8 — conformance goldens", () => {
  it("double materialize yields identical snapshot_id and id_resolve", async () => {
    const root = await copyFixtureToTemp("template_literals.ts");
    try {
      const a = await materializeSnapshot({ rootPath: root });
      const b = await materializeSnapshot({ rootPath: root });
      expect(a.snapshot_id).toBe(b.snapshot_id);
      expect(JSON.stringify(a.id_resolve)).toBe(JSON.stringify(b.id_resolve));
      expect(a.units.map((u) => u.id).sort()).toEqual(b.units.map((u) => u.id).sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("subprocess materialize matches in-process snapshot_id and id_resolve key order", async () => {
    const root = await copyFixtureToTemp("decorators.ts");
    try {
      const a = await materializeSnapshot({ rootPath: root });
      const out = execFileSync(process.execPath, [materializeScriptPath, root], {
        encoding: "utf8",
        cwd: pkgRoot,
        env: process.env,
      });
      const parsed = JSON.parse(out.trim()) as {
        snapshot_id: string;
        unit_ids: string[];
        id_resolve_key_order: string[];
      };
      expect(parsed.snapshot_id).toBe(a.snapshot_id);
      expect(parsed.unit_ids).toEqual(a.units.map((u) => u.id).sort());
      expect(parsed.id_resolve_key_order).toEqual(Object.keys(a.id_resolve).sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes template literal and decorator fixtures without empty snapshots", async () => {
    for (const name of ["template_literals.ts", "decorators.ts"]) {
      const root = await copyFixtureToTemp(name);
      try {
        const s = await materializeSnapshot({ rootPath: root });
        expect(s.units.length).toBeGreaterThan(0);
        expect(s.snapshot_id.length).toBeGreaterThan(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("Tier I edit-shift: replace_unit on middle unit; id above stable; edited and below ids change", async () => {
    const root = await copyFixtureToTemp("edit_shift.ts");
    const fileName = "edit_shift.ts";
    try {
      // "Above" is strict by byte span: a unit counts as unchanged only if its entire
      // `[start_byte, end_byte)` lies strictly before the edited span (`u.end_byte <= edited.start_byte`).
      // The middle function starts at the edit boundary; it is the target, so its id must change — not "above".
      const snapA = await materializeSnapshot({ rootPath: root });
      const unitsA = snapA.units
        .filter((u) => u.file_path === fileName)
        .slice()
        .sort((a, b) => a.start_byte - b.start_byte);
      expect(unitsA.length).toBe(3);

      const [topA, midA, botA] = unitsA;
      const newMidText = `function mid(): number {\n  return 10;\n}\n`;

      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snapA,
        ops: [{ op: "replace_unit", target_id: midA.id, new_text: newMidText }],
        toolchainFingerprintAtApply: toolchain,
      });

      expect(report.outcome).toBe("success");

      const snapB = await materializeSnapshot({ rootPath: root });
      const unitsB = snapB.units
        .filter((u) => u.file_path === fileName)
        .slice()
        .sort((a, b) => a.start_byte - b.start_byte);
      expect(unitsB.length).toBe(3);

      const [topB, midB, botB] = unitsB;
      expect(topB.id).toBe(topA.id);
      expect(midB.id).not.toBe(midA.id);
      expect(botB.id).not.toBe(botA.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("v1 — blob externalization (section 10)", () => {
  async function copyLargeFixtureToTemp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agent86-blob-"));
    await copyFile(fixturePath("large_unit.ts"), join(dir, "large_unit.ts"));
    return dir;
  }

  it("default threshold externalizes large unit; summary lists omitted_due_to_size", async () => {
    const root = await copyLargeFixtureToTemp();
    try {
      const s = await materializeSnapshot({ rootPath: root });
      expect(s.units).toHaveLength(1);
      const u = s.units[0]!;
      expect(u.source_text).toBeNull();
      expect(u.blob_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(u.blob_bytes).toBeGreaterThan(8192);
      const summary = await buildWorkspaceSummary(s, root);
      expect(summary.omitted_due_to_size).toHaveLength(1);
      expect(summary.omitted_due_to_size[0]!.ref).toBe(u.blob_ref);
      expect(summary.omitted_due_to_size[0]!.bytes).toBe(u.blob_bytes);
      expect(summary.omitted_due_to_size[0]!.reason).toBe("inline_threshold");
      const text = await fetchBlobText(u.blob_ref!, root);
      expect(Buffer.byteLength(text, "utf8")).toBe(u.blob_bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("raised threshold inlines unit; omitted_due_to_size empty on summary", async () => {
    const root = await copyLargeFixtureToTemp();
    try {
      const s = await materializeSnapshot({ rootPath: root, inline_threshold_bytes: 100_000 });
      const u = s.units[0]!;
      expect(u.source_text).not.toBeNull();
      expect(u.blob_ref).toBeNull();
      const summary = await buildWorkspaceSummary(s, root);
      expect(summary.omitted_due_to_size).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replace_unit on externalized unit succeeds; result still externalized when large", async () => {
    const root = await copyLargeFixtureToTemp();
    try {
      const snapA = await materializeSnapshot({ rootPath: root });
      const u = snapA.units[0]!;
      expect(u.blob_ref).toBeTruthy();
      const pad = "z".repeat(8200);
      const newText = `function big(): void {\n  // ${pad}\n}\n`;
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snapA,
        ops: [{ op: "replace_unit", target_id: u.id, new_text: newText }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("success");
      expect(report.omitted_due_to_size.some((o) => o.reason === "inline_threshold")).toBe(true);
      const snapB = await materializeSnapshot({ rootPath: root });
      const u2 = snapB.units[0]!;
      expect(u2.blob_ref).toBeTruthy();
      expect(u2.source_text).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
