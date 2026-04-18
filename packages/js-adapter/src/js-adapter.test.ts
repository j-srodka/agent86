/**
 * js-adapter conformance tests.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeSnapshot, JS_ADAPTER_FINGERPRINT } from "./snapshot.js";
import { searchUnits } from "./search_units.js";
import { extractJsLogicalUnits, extractLogicalUnits } from "./units.js";
import { JS_GRAMMAR_DIGEST, computeJsGrammarDigestFromArtifact } from "./grammar.js";
import { applyBatch } from "./apply.js";
import { applyReplaceUnit } from "./ops/replace_unit.js";
import { applyRenameSymbol } from "./ops/rename_symbol.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "js-adapter-test-"));
}

async function writeJs(dir: string, rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true }).catch(() => {});
  await writeFile(abs, content, "utf8");
}

const TOOLCHAIN = "test-toolchain-v0";

it("JS_GRAMMAR_DIGEST matches parser.c on disk (gate)", () => {
  expect(computeJsGrammarDigestFromArtifact()).toBe(JS_GRAMMAR_DIGEST);
});

it("grammar digest stable across two computations in one process", () => {
  const a = computeJsGrammarDigestFromArtifact();
  const b = computeJsGrammarDigestFromArtifact();
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
});

it("JS_ADAPTER_FINGERPRINT has expected fields", () => {
  expect(JS_ADAPTER_FINGERPRINT.name).toBe("js-adapter");
  expect(JS_ADAPTER_FINGERPRINT.semver).toBe("0.0.0");
  expect(JS_ADAPTER_FINGERPRINT.grammar_digest).toBe(JS_GRAMMAR_DIGEST);
});

it("materializeSnapshot extracts function_declaration with stable id", async () => {
  const dir = await makeTempDir();
  try {
    await writeJs(dir, "fn.js", "export function hello() {\n  return 1;\n}\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const u = snap.units.find((x) => x.kind === "function_declaration");
    expect(u).toBeDefined();
    expect(u!.kind).toBe("function_declaration");
    expect(u!.id).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("materializeSnapshot extracts class_declaration and method_definition", async () => {
  const dir = await makeTempDir();
  try {
    await writeJs(
      dir,
      "cls.mjs",
      ["class Box {", "  size() {", "    return 1;", "  }", "}", ""].join("\n"),
    );
    const snap = await materializeSnapshot({ rootPath: dir });
    const kinds = snap.units.map((u) => u.kind).sort();
    expect(kinds).toContain("class_declaration");
    expect(kinds.filter((k) => k === "method_definition").length).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("materializeSnapshot extracts top-level const arrow_function as arrow_function kind", async () => {
  const dir = await makeTempDir();
  try {
    await writeJs(dir, "arrow.cjs", "const inc = (x) => x + 1;\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const u = snap.units.find((x) => x.kind === "arrow_function");
    expect(u).toBeDefined();
    expect(u!.source_text).toContain("=>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("searchUnits matches top-level arrow_function when kind is function and name matches", async () => {
  const dir = await makeTempDir();
  try {
    await writeJs(dir, "arr.js", "const inc = (x) => x + 1;\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const res = await searchUnits(snap, { kind: "function", name: "inc" }, dir);
    expect(res.unit_refs).toHaveLength(1);
    expect(res.unit_refs[0]!.kind).toBe("function");
    expect(res.unit_refs[0]!.name).toBe("inc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("extractLogicalUnits is an alias for extractJsLogicalUnits", () => {
  expect(extractLogicalUnits).toBe(extractJsLogicalUnits);
});

describe("replace_unit and ids", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replace_unit changes edited unit id; unit above unchanged", async () => {
    const src = [
      "function top() {",
      "  return 0;",
      "}",
      "",
      "function bottom() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    await writeJs(dir, "stack.js", src);
    const snap = await materializeSnapshot({ rootPath: dir });
    const ordered = snap.units.filter((u) => u.file_path === "stack.js").sort((a, b) => a.start_byte - b.start_byte);
    expect(ordered.length).toBeGreaterThanOrEqual(2);
    const top = ordered[0]!;
    const bottom = ordered[1]!;
    const topIdBefore = top.id;
    const bottomIdBefore = bottom.id;

    const r = await applyReplaceUnit({
      snapshotRootPath: dir,
      unit: bottom,
      newText: "function bottom() {\n  return 99;\n}\n",
      materialize: { previousSnapshot: snap },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.nextSnapshot.snapshot_id).not.toBe(snap.snapshot_id);
    const topAfter = r.nextSnapshot.units.find((u) => u.file_path === "stack.js" && u.start_byte === top.start_byte);
    expect(topAfter?.id).toBe(topIdBefore);
    const bottomAfter = r.nextSnapshot.units.find((u) => u.file_path === "stack.js" && u.kind === "function_declaration" && u.source_text?.includes("99"));
    expect(bottomAfter).toBeDefined();
    expect(bottomAfter!.id).not.toBe(bottomIdBefore);
  });
});

describe("applyRenameSymbol", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renames a function declaration and call sites in one file", async () => {
    await writeJs(dir, "greet.js", "function greet() {}\n\ngreet();\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    const unit = snap.units.find((u) => u.kind === "function_declaration")!;
    const r = await applyRenameSymbol({
      snapshotRootPath: dir,
      snapshot: snap,
      unit,
      newName: "greet_v2",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rename_surface_report.rewritten).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("method unit ID stability", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("class method unit IDs identical across two materializeSnapshot calls", async () => {
    await writeJs(
      dir,
      "methods.js",
      ["class C {", "  first() {}", "", "  second() {}", "}", ""].join("\n"),
    );
    const snap1 = await materializeSnapshot({ rootPath: dir });
    const snap2 = await materializeSnapshot({ rootPath: dir });
    const methodIds = (s: typeof snap1) =>
      s.units
        .filter((u) => u.file_path === "methods.js" && u.kind === "method_definition")
        .sort((a, b) => a.start_byte - b.start_byte)
        .map((u) => u.id);
    expect(methodIds(snap1)).toEqual(methodIds(snap2));
    expect(methodIds(snap1).length).toBeGreaterThanOrEqual(2);
  });
});

describe("applyBatch §9 gates", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects batch when snapshot_content_mismatch after disk drift", async () => {
    await writeJs(dir, "a.js", "function foo() {\n  return 1;\n}\n");
    const snap = await materializeSnapshot({ rootPath: dir });
    await writeJs(dir, "a.js", "function foo() {\n  return 2;\n}\n");
    const unit = snap.units[0]!;
    const report = await applyBatch({
      snapshotRootPath: dir,
      snapshot: snap,
      ops: [{ op: "replace_unit", target_id: unit.id, new_text: "function foo() {\n  return 1;\n}\n" }],
      toolchainFingerprintAtApply: TOOLCHAIN,
    });
    expect(report.outcome).toBe("failure");
    expect(report.entries.some((e) => e.code === "snapshot_content_mismatch")).toBe(true);
  });
});

describe("skipped_jsx_paths", () => {
  it("lists .jsx files as skipped, not parsed as JS", async () => {
    const dir = await makeTempDir();
    try {
      await writeJs(dir, "ok.js", "function f() {}\n");
      await writeJs(dir, "skip.jsx", "const x = <div />;\n");
      const snap = await materializeSnapshot({ rootPath: dir });
      expect(snap.skipped_jsx_paths).toContain("skip.jsx");
      expect(snap.files.every((f) => !f.path.endsWith(".jsx"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
