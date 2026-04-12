import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyBatch, materializeSnapshot } from "ts-adapter";

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
