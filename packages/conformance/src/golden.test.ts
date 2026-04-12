import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  applyMoveIdResolveEdge,
  buildWorkspaceSummary,
  fetchBlobText,
  materializeSnapshot,
} from "ts-adapter";
import type { ValidationReport, WorkspaceSnapshot } from "ts-adapter";

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

/** Copy a fixture preserving relative path under `fixtures/` (e.g. `__generated__/x.ts`). */
async function copyRelFixtureToTemp(relUnderFixtures: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent86-conf-"));
  const dest = join(dir, relUnderFixtures);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(fixturePath(relUnderFixtures), dest);
  return dir;
}

/** Rebuild workspace snapshot + `id_resolve` after a successful apply (matches on-disk state + batch deltas). */
async function snapshotAfterSuccessfulBatch(
  rootPath: string,
  snapshotBefore: WorkspaceSnapshot,
  report: ValidationReport,
): Promise<WorkspaceSnapshot> {
  if (report.outcome !== "success") {
    throw new Error("snapshotAfterSuccessfulBatch: report must be success");
  }
  const reloaded = await materializeSnapshot({ rootPath, previousSnapshot: snapshotBefore });
  let { id_resolve } = reloaded;
  const keys = Object.keys(report.id_resolve_delta).sort((a, b) => a.localeCompare(b));
  for (const o of keys) {
    const n = report.id_resolve_delta[o]!;
    id_resolve = applyMoveIdResolveEdge(id_resolve, o, n);
  }
  return { ...reloaded, id_resolve };
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

describe("v1 — generated provenance (section 11)", () => {
  it("materialize: @generated header fixture is classified generated", async () => {
    const root = await copyFixtureToTemp("generated_header.ts");
    try {
      const s = await materializeSnapshot({ rootPath: root });
      expect(s.files).toHaveLength(1);
      expect(s.files[0]!.provenance).toEqual({
        kind: "generated",
        detected_by: "header:@generated",
      });
      expect(s.units[0]!.provenance).toEqual(s.files[0]!.provenance);
      const summary = await buildWorkspaceSummary(s, root);
      expect(summary.generated_file_count).toBe(1);
      expect(summary.has_generated_files).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materialize: __generated__ path segment fixture is classified generated", async () => {
    const root = await copyRelFixtureToTemp("__generated__/generated_path.ts");
    try {
      const s = await materializeSnapshot({ rootPath: root });
      expect(s.files[0]!.provenance.kind).toBe("generated");
      expect(s.files[0]!.provenance).toMatchObject({
        kind: "generated",
        detected_by: "path:segment:__generated__",
      });
      expect(s.units[0]!.provenance).toEqual(s.files[0]!.provenance);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materialize: normal fixture is authored", async () => {
    const root = await copyFixtureToTemp("template_literals.ts");
    try {
      const s = await materializeSnapshot({ rootPath: root });
      for (const f of s.files) {
        expect(f.provenance).toEqual({ kind: "authored" });
      }
      for (const u of s.units) {
        expect(u.provenance).toEqual({ kind: "authored" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applyBatch on generated unit without allowlist → illegal_target_generated; no file mutation", async () => {
    const root = await copyFixtureToTemp("generated_header.ts");
    try {
      const snap = await materializeSnapshot({ rootPath: root });
      const u = snap.units[0]!;
      const before = await readFile(join(root, "generated_header.ts"), "utf8");
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap,
        ops: [
          {
            op: "replace_unit",
            target_id: u.id,
            new_text: `function generatedHeader(): number {\n  return 0;\n}\n`,
          },
        ],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("failure");
      expect(report.entries[0]?.code).toBe("illegal_target_generated");
      const after = await readFile(join(root, "generated_header.ts"), "utf8");
      expect(after).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applyBatch with allowlist + generator_will_not_run → warning audit; batch succeeds", async () => {
    const root = await copyRelFixtureToTemp("__generated__/generated_path.ts");
    try {
      await writeFile(
        join(root, "agent-ir.manifest.json"),
        JSON.stringify({
          generated_edit_allowlist: ["__generated__/generated_path.ts"],
        }),
        "utf8",
      );
      const snap = await materializeSnapshot({ rootPath: root });
      const summary = await buildWorkspaceSummary(snap, root);
      const u = snap.units[0]!;
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap,
        workspaceSummary: summary,
        ops: [
          {
            op: "replace_unit",
            target_id: u.id,
            new_text: `function generatedPath(): string {\n  return "patched";\n}\n`,
            generator_will_not_run: true,
          },
        ],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("success");
      const audits = report.entries.filter((e) => e.code === "allowlist_without_generator_awareness");
      expect(audits).toHaveLength(1);
      expect(audits[0]!.severity).toBe("warning");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applyBatch warning policy + allowlist + no assertion → success with allowlist_without_generator_awareness warning", async () => {
    const root = await copyRelFixtureToTemp("__generated__/generated_path.ts");
    try {
      await writeFile(
        join(root, "agent-ir.manifest.json"),
        JSON.stringify({
          generated_edit_allowlist: ["__generated__/generated_path.ts"],
        }),
        "utf8",
      );
      const snap = await materializeSnapshot({ rootPath: root });
      const base = await buildWorkspaceSummary(snap, root);
      const summary = {
        ...base,
        policies: { generated_allowlist_insufficient_assertions: "warning" as const },
      };
      const u = snap.units[0]!;
      const before = await readFile(join(root, "__generated__", "generated_path.ts"), "utf8");
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap,
        workspaceSummary: summary,
        ops: [
          {
            op: "replace_unit",
            target_id: u.id,
            new_text: `function generatedPath(): string {\n  return "warn-policy";\n}\n`,
          },
        ],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("success");
      const w = report.entries.filter((e) => e.code === "allowlist_without_generator_awareness");
      expect(w.length).toBeGreaterThanOrEqual(1);
      expect(w.every((e) => e.severity === "warning")).toBe(true);
      const after = await readFile(join(root, "__generated__", "generated_path.ts"), "utf8");
      expect(after).not.toBe(before);
      expect(after).toContain("warn-policy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applyBatch allowlisted generated without assertion → error; batch rejected", async () => {
    const root = await copyRelFixtureToTemp("__generated__/generated_path.ts");
    try {
      await writeFile(
        join(root, "agent-ir.manifest.json"),
        JSON.stringify({
          generated_edit_allowlist: ["__generated__/generated_path.ts"],
        }),
        "utf8",
      );
      const snap = await materializeSnapshot({ rootPath: root });
      const summary = await buildWorkspaceSummary(snap, root);
      const u = snap.units[0]!;
      const before = await readFile(join(root, "__generated__", "generated_path.ts"), "utf8");
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap,
        workspaceSummary: summary,
        ops: [
          {
            op: "replace_unit",
            target_id: u.id,
            new_text: `function generatedPath(): string {\n  return "nope";\n}\n`,
          },
        ],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("failure");
      expect(report.entries[0]?.code).toBe("allowlist_without_generator_awareness");
      expect(await readFile(join(root, "__generated__", "generated_path.ts"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("v1 — move_unit (sections 4.3, 8)", () => {
  it("cross-file move to new file: id_resolve_delta, destination contains unit, source emptied", async () => {
    const root = await copyFixtureToTemp("move_export.ts");
    try {
      const snap0 = await materializeSnapshot({ rootPath: root });
      const u = snap0.units[0]!;
      const oldId = u.id;
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap0,
        ops: [{ op: "move_unit", target_id: u.id, destination_file: "out/moved_here.ts" }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("success");
      const newId = report.id_resolve_delta[oldId];
      expect(newId).toBeDefined();
      expect(newId).not.toBe(oldId);
      const snap1 = await snapshotAfterSuccessfulBatch(root, snap0, report);
      expect(snap1.id_resolve[oldId]).toBe(newId);
      const destUnit = snap1.units.find((x) => x.id === newId);
      expect(destUnit?.file_path).toBe("out/moved_here.ts");
      const destText = await readFile(join(root, "out", "moved_here.ts"), "utf8");
      expect(destText).toContain("movedOnce");
      const srcText = await readFile(join(root, "move_export.ts"), "utf8");
      expect(srcText).not.toContain("movedOnce");
      expect(snap1.units.filter((x) => x.file_path === "move_export.ts")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("auto-resolve: replace_unit targeting pre-move id succeeds with id_superseded warning", async () => {
    const root = await copyFixtureToTemp("move_export.ts");
    try {
      const snap0 = await materializeSnapshot({ rootPath: root });
      const u = snap0.units[0]!;
      const oldId = u.id;
      const r0 = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap0,
        ops: [{ op: "move_unit", target_id: u.id, destination_file: "relocated.ts" }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(r0.outcome).toBe("success");
      const snap1 = await snapshotAfterSuccessfulBatch(root, snap0, r0);
      const r1 = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap1,
        ops: [
          {
            op: "replace_unit",
            target_id: oldId,
            new_text: `function movedOnce(): number {\n  return 99;\n}\n`,
          },
        ],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(r1.outcome).toBe("success");
      const warn = r1.entries.filter((e) => e.code === "id_superseded");
      expect(warn.length).toBeGreaterThanOrEqual(1);
      expect(warn[0]!.evidence).toEqual({ resolved_to: r0.id_resolve_delta[oldId] });
      const text = await readFile(join(root, "relocated.ts"), "utf8");
      expect(text).toContain("99");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ghost_unit: moved unit deleted on disk then re-snapshot; op targeting old id hard-fails", async () => {
    const root = await copyFixtureToTemp("move_export.ts");
    try {
      const snap0 = await materializeSnapshot({ rootPath: root });
      const u = snap0.units[0]!;
      const oldId = u.id;
      const r0 = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap0,
        ops: [{ op: "move_unit", target_id: u.id, destination_file: "gone.ts" }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(r0.outcome).toBe("success");
      const snapMoved = await snapshotAfterSuccessfulBatch(root, snap0, r0);
      await rm(join(root, "gone.ts"));
      const snapGhost = await materializeSnapshot({ rootPath: root, previousSnapshot: snapMoved });
      const r1 = await applyBatch({
        snapshotRootPath: root,
        snapshot: snapGhost,
        ops: [
          {
            op: "replace_unit",
            target_id: oldId,
            new_text: `function movedOnce(): number {\n  return 0;\n}\n`,
          },
        ],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(r1.outcome).toBe("failure");
      expect(r1.entries[0]?.code).toBe("ghost_unit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lang.ts.move_unit_name_conflict: no mutation when destination has same declared name", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent86-move-conf-"));
    try {
      await copyFile(fixturePath("move_export.ts"), join(root, "src.ts"));
      await mkdir(join(root, "nested"), { recursive: true });
      await copyFile(fixturePath("move_name_conflict_dest.ts"), join(root, "nested", "dest.ts"));
      const snap0 = await materializeSnapshot({ rootPath: root });
      const u = snap0.units.find((x) => x.file_path === "src.ts");
      expect(u).toBeDefined();
      const beforeSrc = await readFile(join(root, "src.ts"), "utf8");
      const beforeDest = await readFile(join(root, "nested", "dest.ts"), "utf8");
      const report = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap0,
        ops: [{ op: "move_unit", target_id: u!.id, destination_file: "nested/dest.ts" }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(report.outcome).toBe("failure");
      expect(report.entries[0]?.code).toBe("lang.ts.move_unit_name_conflict");
      expect(await readFile(join(root, "src.ts"), "utf8")).toBe(beforeSrc);
      expect(await readFile(join(root, "nested", "dest.ts"), "utf8")).toBe(beforeDest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flattened chain: move A→B then B→C yields id_resolve old_A → final id", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent86-chain-"));
    try {
      await copyFile(fixturePath("move_chain_src.ts"), join(root, "chain_a.ts"));
      const snap0 = await materializeSnapshot({ rootPath: root });
      const ua = snap0.units.find((x) => x.file_path === "chain_a.ts");
      expect(ua).toBeDefined();
      const oldA = ua!.id;
      const r1 = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap0,
        ops: [{ op: "move_unit", target_id: oldA, destination_file: "chain_b.ts" }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(r1.outcome).toBe("success");
      const idB = r1.id_resolve_delta[oldA]!;
      const snap1 = await snapshotAfterSuccessfulBatch(root, snap0, r1);
      const r2 = await applyBatch({
        snapshotRootPath: root,
        snapshot: snap1,
        ops: [{ op: "move_unit", target_id: idB, destination_file: "chain_c/final.ts" }],
        toolchainFingerprintAtApply: toolchain,
      });
      expect(r2.outcome).toBe("success");
      const idC = r2.id_resolve_delta[idB]!;
      const snap2 = await snapshotAfterSuccessfulBatch(root, snap1, r2);
      expect(snap2.id_resolve[oldA]).toBe(idC);
      expect(snap2.units.some((u) => u.id === idC && u.file_path === "chain_c/final.ts")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
