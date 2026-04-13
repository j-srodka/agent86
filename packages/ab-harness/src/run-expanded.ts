import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  applyBatch,
  canonicalizeSourceForSnapshot,
  detectPythonUnits,
  materializeSnapshot,
  parseTypeScriptSource,
  PYTHON_STUB_GRAMMAR_DIGEST,
} from "ts-adapter";
import type { LogicalUnit, WorkspaceSnapshot } from "ts-adapter";

import {
  approachMetrics,
  tokenCharsFromSnapshotFiles,
  type ApproachMetrics,
  type ExpandedMetricsFile,
  type ExpandedTaskRow,
  type RepoExpandedBlock,
} from "./metrics.js";
import { materializePythonStubSnapshot } from "./python-materialize.js";
import { applyPythonReplaceUnit, applyPythonRenameSymbol } from "./python-apply.js";
import {
  BENCHMARK_SEED,
  declaredNameFromTsUnit,
  mulberry32,
  sampleTasksFromPythonSnapshot,
  sampleTasksFromTsSnapshot,
  type TaskDescriptor,
  writeTaskListJson,
} from "./sample-tasks.js";
import { wilsonCI } from "./stats.js";

const TOOLCHAIN = "toolchain:ab-harness-expanded";

function resetGitWorkspace(root: string): void {
  try {
    execFileSync("git", ["-C", root, "checkout", "--", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "clean", "-fd"], { stdio: "ignore" });
  } catch {
    /* non-git roots fall through; caller may still run */
  }
}

function parseTsOk(source: string): boolean {
  const t = parseTypeScriptSource(canonicalizeSourceForSnapshot(source));
  return !t.rootNode.hasError;
}

function pythonStubOk(relPath: string, source: string, root: string): boolean {
  const c = canonicalizeSourceForSnapshot(source);
  return (
    detectPythonUnits(relPath, c, {
      grammarDigest: PYTHON_STUB_GRAMMAR_DIGEST,
      snapshotRootResolved: resolve(root),
    }).length > 0
  );
}

async function readAllFileSources(snapshotRoot: string, snapshot: WorkspaceSnapshot): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of snapshot.files) {
    const abs = join(snapshotRoot, ...f.path.split("/"));
    const raw = await readFile(abs, "utf8");
    m.set(f.path, canonicalizeSourceForSnapshot(raw));
  }
  return m;
}

function findUnit(snap: WorkspaceSnapshot, id: string): LogicalUnit | undefined {
  return snap.units.find((u) => u.id === id);
}

function tsReplaceNewText(unit: LogicalUnit, fileSource: string, badBrace: boolean): string {
  const name = declaredNameFromTsUnit(unit, fileSource) ?? "fn";
  if (badBrace) {
    return `function ${name}() {\n  return 42;\n`;
  }
  return `function ${name}() {\n  return 42;\n}\n`;
}

function pyReplaceNewText(unit: LogicalUnit, fileSource: string, bad: boolean): string {
  const span = fileSource.slice(unit.start_byte, unit.end_byte);
  const line = span.split("\n")[0] ?? "";
  if (unit.kind === "class_declaration" || /^class\s/.test(line)) {
    const m = line.match(/^class\s+([A-Za-z_]\w*)/);
    const n = m?.[1] ?? "C";
    if (bad) {
      return `class ${n}:\n    pass`;
    }
    return `class ${n}:\n    pass\n`;
  }
  const m = line.match(/^def\s+([A-Za-z_]\w*)/);
  const n = m?.[1] ?? "f";
  if (bad) {
    return `def ${n}():\n    return 42`;
  }
  return `def ${n}():\n    return 42\n`;
}

function baselineGlobalRename(source: string, oldName: string, newName: string): string {
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return source.replace(re, newName);
}

function enrichMetrics(base: ApproachMetrics, t: TaskDescriptor, fp: number): ExpandedTaskRow {
  return {
    ...base,
    task_id: t.task_id,
    task_category: t.task_category,
    repo: t.repo,
    language: t.language,
    false_positive_count: fp,
  };
}

function aggregateBlock(rows: ExpandedTaskRow[]): Omit<RepoExpandedBlock, "tasks"> {
  const n = rows.length;
  const failed = rows.reduce((a, r) => a + r.failed_patches, 0);
  const fpSum = rows.reduce((a, r) => a + r.false_positive_count, 0);
  const rate = n > 0 ? failed / n : 0;
  const w = wilsonCI(failed, n, 1.96);
  return {
    failed_patch_rate: rate,
    false_positive_count: fpSum,
    ci_95_lower: w.lower,
    ci_95_upper: w.upper,
  };
}

async function runTsRepo(input: {
  cloneRoot: string;
  repo: string;
  tasks: TaskDescriptor[];
}): Promise<{ baseline: RepoExpandedBlock; ir: RepoExpandedBlock }> {
  const snapshotRoot = input.cloneRoot;
  const baselineRows: ExpandedTaskRow[] = [];
  const irRows: ExpandedTaskRow[] = [];
  const rngBad = mulberry32(BENCHMARK_SEED + 0xcafe);

  for (const t of input.tasks) {
    resetGitWorkspace(snapshotRoot);
    let snap = await materializeSnapshot({ rootPath: snapshotRoot });
    let fileSources = await readAllFileSources(snapshotRoot, snap);
    const unit = findUnit(snap, t.target_unit_id);
    if (!unit) {
      const fail = approachMetrics({
        outcome: "failure",
        failure_reason: "unit_not_found",
        full_file_reads: 0,
        round_trips: 1,
        tokens_chars_read: 0,
        failed_patches: 1,
        detail: "unit missing after materialize",
      });
      baselineRows.push(enrichMetrics(fail, t, 0));
      irRows.push(enrichMetrics(fail, t, 0));
      continue;
    }
    const src = fileSources.get(t.file_path);
    if (!src) {
      const fail = approachMetrics({
        outcome: "failure",
        failure_reason: "file_not_found",
        full_file_reads: 0,
        round_trips: 1,
        tokens_chars_read: 0,
        failed_patches: 1,
        detail: "file missing",
      });
      baselineRows.push(enrichMetrics(fail, t, 0));
      irRows.push(enrichMetrics(fail, t, 0));
      continue;
    }

    if (t.task_category === "replace_unit") {
      const bad = rngBad() < 0.3;
      const newText = tsReplaceNewText(unit, src, bad);
      const naive = src.slice(0, unit.start_byte) + newText + src.slice(unit.end_byte);
      const parseOk = parseTsOk(naive);
      const failed = !parseOk ? 1 : 0;
      const fp = parseOk && bad ? 1 : 0;
      baselineRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: failed ? "failure" : "success",
            failure_reason: failed ? "parse_error" : null,
            full_file_reads: 1,
            round_trips: 1,
            tokens_chars_read: src.length,
            failed_patches: failed,
            detail: bad ? "baseline replace (possibly off-by-one brace)" : "baseline replace",
          }),
          t,
          fp,
        ),
      );

      resetGitWorkspace(snapshotRoot);
      snap = await materializeSnapshot({ rootPath: snapshotRoot });
      fileSources = await readAllFileSources(snapshotRoot, snap);
      const uIr = findUnit(snap, t.target_unit_id);
      if (!uIr) {
        irRows.push(
          enrichMetrics(
            approachMetrics({
              outcome: "failure",
              failure_reason: "unit_not_found",
              full_file_reads: snap.files.length,
              round_trips: 1,
              tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
              failed_patches: 1,
              detail: "unit missing before IR replace",
            }),
            t,
            0,
          ),
        );
        continue;
      }
      const srcIr = fileSources.get(t.file_path)!;
      const irText = tsReplaceNewText(uIr, srcIr, false);
      const report = await applyBatch({
        snapshotRootPath: snapshotRoot,
        snapshot: snap,
        ops: [{ op: "replace_unit", target_id: uIr.id, new_text: irText }],
        toolchainFingerprintAtApply: TOOLCHAIN,
      });
      const irOk = report.outcome === "success";
      if (irOk) {
        snap = await materializeSnapshot({ rootPath: snapshotRoot, previousSnapshot: snap });
      }
      irRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: irOk ? "success" : "failure",
            failure_reason: irOk ? null : "parse_error",
            full_file_reads: snap.files.length,
            round_trips: 1,
            tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
            failed_patches: irOk ? 0 : 1,
            detail: irOk ? "replace_unit IR" : report.entries[0]?.message ?? "apply failed",
            validation_codes: report.entries.map((e) => String(e.code)),
          }),
          t,
          0,
        ),
      );
    } else {
      const oldName = declaredNameFromTsUnit(unit, src);
      const newName = t.rename_to ?? "renamed";
      if (!oldName) {
        const fail = approachMetrics({
          outcome: "failure",
          failure_reason: "string_not_found",
          full_file_reads: 1,
          round_trips: 1,
          tokens_chars_read: src.length,
          failed_patches: 1,
          detail: "could not read declared name",
        });
        baselineRows.push(enrichMetrics(fail, t, 0));
        irRows.push(enrichMetrics(fail, t, 0));
        continue;
      }
      const naive = baselineGlobalRename(src, oldName, newName);
      const parseOk = parseTsOk(naive);
      const failed = !parseOk ? 1 : 0;
      const fp = parseOk && t.has_homonym ? 1 : 0;
      baselineRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: failed ? "failure" : "success",
            failure_reason: failed ? "parse_error" : null,
            full_file_reads: 1,
            round_trips: 1,
            tokens_chars_read: src.length,
            failed_patches: failed,
            detail: "baseline global rename",
          }),
          t,
          fp,
        ),
      );

      resetGitWorkspace(snapshotRoot);
      snap = await materializeSnapshot({ rootPath: snapshotRoot });
      fileSources = await readAllFileSources(snapshotRoot, snap);
      const u2 = findUnit(snap, t.target_unit_id);
      if (!u2) {
        irRows.push(
          enrichMetrics(
            approachMetrics({
              outcome: "failure",
              failure_reason: "unit_not_found",
              full_file_reads: snap.files.length,
              round_trips: 1,
              tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
              failed_patches: 1,
              detail: "unit missing before IR rename",
            }),
            t,
            0,
          ),
        );
        continue;
      }
      const report = await applyBatch({
        snapshotRootPath: snapshotRoot,
        snapshot: snap,
        ops: [{ op: "rename_symbol", target_id: u2.id, new_name: newName, cross_file: false }],
        toolchainFingerprintAtApply: TOOLCHAIN,
      });
      const irOk = report.outcome === "success";
      if (irOk) {
        snap = await materializeSnapshot({ rootPath: snapshotRoot, previousSnapshot: snap });
      }
      irRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: irOk ? "success" : "failure",
            failure_reason: irOk ? null : "parse_error",
            full_file_reads: snap.files.length,
            round_trips: 1,
            tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
            failed_patches: irOk ? 0 : 1,
            detail: irOk ? "rename_symbol IR" : report.entries[0]?.message ?? "apply failed",
            validation_codes: report.entries.map((e) => String(e.code)),
          }),
          t,
          0,
        ),
      );
    }
  }

  return {
    baseline: { tasks: baselineRows, ...aggregateBlock(baselineRows) },
    ir: { tasks: irRows, ...aggregateBlock(irRows) },
  };
}

async function runPyRepo(input: {
  cloneRoot: string;
  repo: string;
  tasks: TaskDescriptor[];
}): Promise<{ baseline: RepoExpandedBlock; ir: RepoExpandedBlock }> {
  const root = input.cloneRoot;
  const baselineRows: ExpandedTaskRow[] = [];
  const irRows: ExpandedTaskRow[] = [];
  const rngBad = mulberry32(BENCHMARK_SEED + 0xbabe);

  for (const t of input.tasks) {
    resetGitWorkspace(root);
    let snapWrap = await materializePythonStubSnapshot(root);
    let snap = snapWrap.snapshot;
    const unit = findUnit(snap, t.target_unit_id);
    if (!unit) {
      const fail = approachMetrics({
        outcome: "failure",
        failure_reason: "unit_not_found",
        full_file_reads: 0,
        round_trips: 1,
        tokens_chars_read: 0,
        failed_patches: 1,
        detail: "python stub: unit missing",
      });
      baselineRows.push(enrichMetrics(fail, t, 0));
      irRows.push(enrichMetrics(fail, t, 0));
      continue;
    }
    const src = snapWrap.fileSources.get(t.file_path);
    if (!src) {
      const fail = approachMetrics({
        outcome: "failure",
        failure_reason: "file_not_found",
        full_file_reads: 0,
        round_trips: 1,
        tokens_chars_read: 0,
        failed_patches: 1,
        detail: "python file missing",
      });
      baselineRows.push(enrichMetrics(fail, t, 0));
      irRows.push(enrichMetrics(fail, t, 0));
      continue;
    }

    if (t.task_category === "replace_unit") {
      const bad = rngBad() < 0.3;
      const newText = pyReplaceNewText(unit, src, bad);
      const naive = src.slice(0, unit.start_byte) + newText + src.slice(unit.end_byte);
      const parseOk = pythonStubOk(t.file_path, naive, root);
      const failed = !parseOk ? 1 : 0;
      const fp = parseOk && bad ? 1 : 0;
      baselineRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: failed ? "failure" : "success",
            failure_reason: failed ? "parse_error" : null,
            full_file_reads: 1,
            round_trips: 1,
            tokens_chars_read: src.length,
            failed_patches: failed,
            detail: "baseline python replace",
          }),
          t,
          fp,
        ),
      );

      resetGitWorkspace(root);
      snapWrap = await materializePythonStubSnapshot(root);
      snap = snapWrap.snapshot;
      const u2 = findUnit(snap, t.target_unit_id);
      if (!u2) {
        irRows.push(
          enrichMetrics(
            approachMetrics({
              outcome: "failure",
              failure_reason: "unit_not_found",
              full_file_reads: snap.files.length,
              round_trips: 1,
              tokens_chars_read: [...snapWrap.fileSources.values()].reduce((a, s) => a + s.length, 0),
              failed_patches: 1,
              detail: "unit missing before IR replace",
            }),
            t,
            0,
          ),
        );
        continue;
      }
      const srcIr = snapWrap.fileSources.get(t.file_path)!;
      const irText = pyReplaceNewText(u2, srcIr, false);
      const r = await applyPythonReplaceUnit({
        snapshotRootPath: root,
        snapshot: snap,
        unit: u2,
        newText: irText,
      });
      const irOk = r.ok;
      if (irOk) {
        snapWrap = r.next;
        snap = snapWrap.snapshot;
      }
      irRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: irOk ? "success" : "failure",
            failure_reason: irOk ? null : "parse_error",
            full_file_reads: snap.files.length,
            round_trips: 1,
            tokens_chars_read: [...snapWrap.fileSources.values()].reduce((a, s) => a + s.length, 0),
            failed_patches: irOk ? 0 : 1,
            detail: irOk ? "python stub replace" : !r.ok ? r.message : "error",
            validation_codes: irOk ? ["parse_scope_file"] : undefined,
          }),
          t,
          0,
        ),
      );
    } else {
      const span = src.slice(unit.start_byte, unit.end_byte);
      const line = span.split("\n")[0] ?? "";
      const oldName =
        line.match(/^def\s+([A-Za-z_]\w*)/)?.[1] ?? line.match(/^class\s+([A-Za-z_]\w*)/)?.[1] ?? "";
      const newName = t.rename_to ?? "renamed";
      if (!oldName) {
        const fail = approachMetrics({
          outcome: "failure",
          failure_reason: "string_not_found",
          full_file_reads: 1,
          round_trips: 1,
          tokens_chars_read: src.length,
          failed_patches: 1,
          detail: "no python name",
        });
        baselineRows.push(enrichMetrics(fail, t, 0));
        irRows.push(enrichMetrics(fail, t, 0));
        continue;
      }
      const naive = baselineGlobalRename(src, oldName, newName);
      const parseOk = pythonStubOk(t.file_path, naive, root);
      const failed = !parseOk ? 1 : 0;
      const fp = parseOk && t.has_homonym ? 1 : 0;
      baselineRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: failed ? "failure" : "success",
            failure_reason: failed ? "parse_error" : null,
            full_file_reads: 1,
            round_trips: 1,
            tokens_chars_read: src.length,
            failed_patches: failed,
            detail: "baseline global rename (python)",
          }),
          t,
          fp,
        ),
      );

      resetGitWorkspace(root);
      snapWrap = await materializePythonStubSnapshot(root);
      snap = snapWrap.snapshot;
      const u2 = findUnit(snap, t.target_unit_id);
      if (!u2) {
        irRows.push(
          enrichMetrics(
            approachMetrics({
              outcome: "failure",
              failure_reason: "unit_not_found",
              full_file_reads: snap.files.length,
              round_trips: 1,
              tokens_chars_read: [...snapWrap.fileSources.values()].reduce((a, s) => a + s.length, 0),
              failed_patches: 1,
              detail: "unit missing before IR rename",
            }),
            t,
            0,
          ),
        );
        continue;
      }
      const r = await applyPythonRenameSymbol({
        snapshotRootPath: root,
        snapshot: snap,
        unit: u2,
        oldName,
        newName,
      });
      const irOk = r.ok;
      if (irOk) {
        snapWrap = r.next;
        snap = snapWrap.snapshot;
      }
      irRows.push(
        enrichMetrics(
          approachMetrics({
            outcome: irOk ? "success" : "failure",
            failure_reason: irOk ? null : "parse_error",
            full_file_reads: snap.files.length,
            round_trips: 1,
            tokens_chars_read: [...snapWrap.fileSources.values()].reduce((a, s) => a + s.length, 0),
            failed_patches: irOk ? 0 : 1,
            detail: irOk ? "python stub scoped rename" : !r.ok ? r.message : "error",
            validation_codes: irOk ? ["parse_scope_file"] : undefined,
          }),
          t,
          0,
        ),
      );
    }
  }

  return {
    baseline: { tasks: baselineRows, ...aggregateBlock(baselineRows) },
    ir: { tasks: irRows, ...aggregateBlock(irRows) },
  };
}

export interface ExpandedRunResult {
  repos: ExpandedMetricsFile["repos"];
  human_summary: string;
}

export async function runExpandedBenchmark(input: {
  repos: Array<{ id: string; cloneRoot: string; url: string; rev: string; language: "typescript" | "python_stub" }>;
  outDir: string;
}): Promise<ExpandedRunResult> {
  const repos: ExpandedRunResult["repos"] = {};
  const lines: string[] = [];

  for (const r of input.repos) {
    let tasks: TaskDescriptor[];
    if (r.language === "typescript") {
      const snap = await materializeSnapshot({ rootPath: r.cloneRoot });
      const fileSources = await readAllFileSources(r.cloneRoot, snap);
      tasks = sampleTasksFromTsSnapshot(snap, fileSources, { repo: r.id, language: "typescript" });
      await writeTaskListJson(join(input.outDir, `ab-tasks-${r.id}.json`), tasks);
      const { baseline, ir } = await runTsRepo({ cloneRoot: r.cloneRoot, repo: r.id, tasks });
      repos[r.id] = {
        url: r.url,
        rev: r.rev,
        snapshot_root: r.cloneRoot,
        task_count: tasks.length,
        baseline,
        ir,
      };
      lines.push(
        `${r.id} (TS): ${tasks.length} tasks — baseline failed_patch_rate=${baseline.failed_patch_rate.toFixed(3)} IR=${ir.failed_patch_rate.toFixed(3)}; baseline FP sum=${baseline.false_positive_count} IR FP sum=${ir.false_positive_count}.`,
      );
    } else {
      const snapWrap = await materializePythonStubSnapshot(r.cloneRoot);
      tasks = sampleTasksFromPythonSnapshot(snapWrap, { repo: r.id, language: "python_stub" });
      await writeTaskListJson(join(input.outDir, `ab-tasks-${r.id}.json`), tasks);
      const { baseline, ir } = await runPyRepo({ cloneRoot: r.cloneRoot, repo: r.id, tasks });
      repos[r.id] = {
        url: r.url,
        rev: r.rev,
        snapshot_root: r.cloneRoot,
        task_count: tasks.length,
        baseline,
        ir,
      };
      lines.push(
        `${r.id} (python stub): ${tasks.length} tasks — baseline failed_patch_rate=${baseline.failed_patch_rate.toFixed(3)} IR=${ir.failed_patch_rate.toFixed(3)}; baseline FP sum=${baseline.false_positive_count} IR FP sum=${ir.false_positive_count}.`,
      );
    }
  }

  const human_summary = `Expanded A/B benchmark (seed ${BENCHMARK_SEED}): ${lines.join(" ")} IR false_positive_count totals should be 0; Wilson 95% on failed_patch_rate is null only when a repo has fewer than 10 tasks (see per-repo ci fields).`;

  return { repos, human_summary };
}
