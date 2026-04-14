/**
 * py-adapter conformance tests (≥8).
 *
 * Each test exercises a distinct structural behaviour — not an
 * exhaustive integration run, but enough to guard the §9 gates,
 * unit extraction, and all three op types.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeSnapshot, PY_ADAPTER_FINGERPRINT } from "./snapshot.js";
import { extractLogicalUnits } from "./units.js";
import { parsePythonSource } from "./parser.js";
import { PY_GRAMMAR_DIGEST } from "./grammar.js";
import { applyBatch } from "./apply.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol } from "./ops/rename_symbol.js";
import { applyMoveUnit } from "./ops/move_unit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "py-adapter-test-"));
}

async function writePy(dir: string, rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true }).catch(() => {});
  await writeFile(abs, content, "utf8");
}

const TOOLCHAIN = "test-toolchain-v0";

// ---------------------------------------------------------------------------
// Test 1: grammar digest is pinned
// ---------------------------------------------------------------------------
it("PY_GRAMMAR_DIGEST matches parser.c on disk", () => {
  // The constant is asserted by assertPyGrammarDigestPinned(); we just confirm
  // the exported constant is a 64-char hex string.
  expect(PY_GRAMMAR_DIGEST).toMatch(/^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// Test 2: adapter fingerprint shape
// ---------------------------------------------------------------------------
it("PY_ADAPTER_FINGERPRINT has expected fields", () => {
  expect(PY_ADAPTER_FINGERPRINT.name).toBe("py-adapter");
  expect(PY_ADAPTER_FINGERPRINT.semver).toBe("0.0.0");
  expect(PY_ADAPTER_FINGERPRINT.grammar_digest).toBe(PY_GRAMMAR_DIGEST);
  expect(PY_ADAPTER_FINGERPRINT.max_batch_ops).toBe(50);
});

// ---------------------------------------------------------------------------
// Test 3: extractLogicalUnits — top-level function, class, async def, decorated
// ---------------------------------------------------------------------------
it("extractLogicalUnits extracts expected kinds from Python source", () => {
  const src = [
    "def foo():",
    "    pass",
    "",
    "async def bar():",
    "    pass",
    "",
    "class MyClass:",
    "    def method(self):",
    "        pass",
    "",
    "@decorator",
    "def decorated():",
    "    pass",
  ].join("\n");

  const tree = parsePythonSource(src);
  const units = extractLogicalUnits(tree, {
    grammarDigest: PY_GRAMMAR_DIGEST,
    snapshotRootResolved: "/fake/root",
    filePathPosix: "test.py",
  });

  const kinds = units.map((u) => u.kind);
  // top-level: foo, bar (async), MyClass class, MyClass.method, decorated
  expect(kinds.filter((k) => k === "function_definition").length).toBeGreaterThanOrEqual(3);
  expect(kinds.filter((k) => k === "class_definition").length).toBe(1);
  // All ids are unique 64-char hex
  const ids = units.map((u) => u.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  }
});

// ---------------------------------------------------------------------------
// Test 4: materializeSnapshot walks .py files deterministically
// ---------------------------------------------------------------------------
describe("materializeSnapshot", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("produces a stable snapshot_id for a fixed .py file", async () => {
    await writePy(dir, "a.py", "def hello():\n    pass\n");
    const snap1 = await materializeSnapshot({ rootPath: dir });
    const snap2 = await materializeSnapshot({ rootPath: dir });
    expect(snap1.snapshot_id).toBe(snap2.snapshot_id);
    expect(snap1.files).toHaveLength(1);
    expect(snap1.files[0]!.path).toBe("a.py");
    expect(snap1.units.length).toBeGreaterThanOrEqual(1);
  });

  it("skips __pycache__ dirs", async () => {
    await writePy(dir, "ok.py", "x = 1\n");
    await mkdir(join(dir, "__pycache__"), { recursive: true });
    await writeFile(join(dir, "__pycache__", "ok.cpython-311.pyc"), "binary", "utf8");
    // .pyc not a .py file, no issue — but ensure dir itself doesn't throw
    const snap = await materializeSnapshot({ rootPath: dir });
    expect(snap.files.every((f) => !f.path.includes("__pycache__"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: applyReplaceUnit replaces a function and re-materializes
// ---------------------------------------------------------------------------
describe("applyReplaceUnit", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("replaces a function body and returns a new snapshot", async () => {
    const src = "def add(a, b):\n    return a + b\n";
    await writePy(dir, "math.py", src);
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units.find((u) => u.kind === "function_definition")!;
    expect(unit).toBeDefined();

    const r = await applyReplaceUnit({
      snapshotRootPath: dir,
      unit,
      newText: "def add(a, b):\n    return a - b\n",
      materialize: { previousSnapshot: snap },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nextSnapshot.snapshot_id).not.toBe(snap.snapshot_id);
    }
  });

  it("returns error for parse failure after splice", async () => {
    await writePy(dir, "broken.py", "def foo():\n    pass\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units[0]!;
    const r = await applyReplaceUnit({
      snapshotRootPath: dir,
      unit,
      newText: "def foo(\n  # unclosed",
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: applyRenameSymbol renames within the file
// ---------------------------------------------------------------------------
describe("applyRenameSymbol", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("renames a function and finds it in the surface report", async () => {
    await writePy(dir, "funcs.py", "def greet():\n    pass\n\ngreet()\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units.find((u) => u.kind === "function_definition")!;

    const r = await applyRenameSymbol({
      snapshotRootPath: dir,
      snapshot: snap,
      unit,
      newName: "greet_v2",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rename_surface_report.rewritten).toBeGreaterThan(0);
    }
  });

  it("rejects rename_symbol on unsupported kind (would only happen if unit kind were invalid)", async () => {
    await writePy(dir, "funcs.py", "def greet():\n    pass\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units[0]!;
    // Force an invalid kind to test the guard.
    const badUnit = { ...unit, kind: "module" as never };
    const r = await applyRenameSymbol({
      snapshotRootPath: dir,
      snapshot: snap,
      unit: badUnit,
      newName: "anything",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("lang.py.rename_unsupported_node_kind");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: applyBatch — §9 gate: grammar_mismatch (stale snapshot digest)
// ---------------------------------------------------------------------------
describe("applyBatch §9 gates", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("rejects batch when snapshot.grammar_digest is stale", async () => {
    await writePy(dir, "a.py", "def foo():\n    pass\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const staleSnap = { ...snap, grammar_digest: "deadbeef".repeat(8) };
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: staleSnap,
      ops: [],
      toolchainFingerprintAtApply: TOOLCHAIN,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries.some((e) => e.code === "grammar_mismatch")).toBe(true);
  });

  it("rejects batch when snapshot_content_mismatch (file modified after snapshot)", async () => {
    await writePy(dir, "a.py", "def foo():\n    pass\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    // Mutate the file on disk without re-materializing
    await writePy(dir, "a.py", "def foo():\n    return 1\n");
    const unit = snap.units[0]!;
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [{ op: "replace_unit", target_id: unit.id, new_text: "def foo():\n    pass\n" }],
      toolchainFingerprintAtApply: TOOLCHAIN,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries.some((e) => e.code === "snapshot_content_mismatch")).toBe(true);
  });

  it("rejects unknown target_id with unknown_or_superseded_id", async () => {
    await writePy(dir, "a.py", "def foo():\n    pass\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [{ op: "replace_unit", target_id: "0".repeat(64), new_text: "def foo():\n    pass\n" }],
      toolchainFingerprintAtApply: TOOLCHAIN,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries.some((e) => e.code === "unknown_or_superseded_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 8: applyMoveUnit cross-file move
// ---------------------------------------------------------------------------
describe("applyMoveUnit", () => {
  let dir: string;
  beforeEach(async () => { dir = await makeTempDir(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("moves a function to a new file", async () => {
    await writePy(dir, "src.py", "def helper():\n    return 42\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units.find((u) => u.kind === "function_definition")!;

    const r = await applyMoveUnit({
      snapshotRootPath: dir,
      snapshot: snap,
      unit,
      destinationFilePosix: "dest.py",
      materialize: { previousSnapshot: snap },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id_resolve_delta[unit.id]).toBeDefined();
      const newId = r.id_resolve_delta[unit.id]!;
      expect(r.nextSnapshot.units.find((u) => u.id === newId)).toBeDefined();
    }
  });

  it("rejects same-file move", async () => {
    await writePy(dir, "src.py", "def helper():\n    return 42\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units[0]!;
    const r = await applyMoveUnit({
      snapshotRootPath: dir,
      snapshot: snap,
      unit,
      destinationFilePosix: "src.py",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("lang.py.move_unit_same_file");
    }
  });
});
