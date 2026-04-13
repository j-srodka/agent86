import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyBatch, materializeSnapshot, parseTypeScriptSource, canonicalizeSourceForSnapshot } from "ts-adapter";
import type { ValidationReport } from "ts-adapter";

import { refreshAbFixtures } from "./copy-fixtures.js";
import type { TaskMetrics } from "./metrics.js";
import { approachMetrics, tokenCharsFromSnapshotFiles } from "./metrics.js";

const TOOLCHAIN = "toolchain:ab-harness";

function parseTreeOk(source: string): boolean {
  const t = parseTypeScriptSource(canonicalizeSourceForSnapshot(source));
  return !t.rootNode.hasError;
}

function validationCodesFromReport(r: ValidationReport): string[] {
  return r.entries.map((e) => String(e.code));
}

const EXPORT_DUP_BAD = `export function keep(): number {
  return 0;
}

export export function victim(): number {
  return 99;
}
`;

const STACKED_BAD = `/** Three stacked units — baseline duplicates export on mid. */
export function top(): number {
  return 0;
}

export export function mid(): number {
  return 10;
}

export function bottom(): number {
  return 2;
}
`;

export async function runTaskSuite(cloneRoot: string): Promise<{ snapshotRoot: string; tasks: TaskMetrics[] }> {
  const snapshotRoot = join(cloneRoot, "__agent_ir_ab__");
  const tasks: TaskMetrics[] = [];
  tasks.push(await runHomonym(cloneRoot, snapshotRoot));
  tasks.push(await runExportDup(cloneRoot, snapshotRoot));
  tasks.push(await runStacked(cloneRoot, snapshotRoot));
  return { snapshotRoot, tasks };
}

async function runHomonym(cloneRoot: string, snapshotRoot: string): Promise<TaskMetrics> {
  const task_id = "homonym_rename";
  const rel = "homonym.ts";
  const abs = join(snapshotRoot, rel);

  await refreshAbFixtures(cloneRoot);
  const raw = await readFile(abs, "utf8");
  const naive = raw.replaceAll("victim", "renamedFn");
  await writeFile(abs, naive, "utf8");
  const parseOk = parseTreeOk(naive);
  const literalBroken = !naive.includes('"victim"');
  const brittleFailed = !parseOk || literalBroken;
  let baselineDetail: string;
  let baselineFailure: string | null = null;
  if (!parseOk) {
    baselineDetail = "parse_error after naive replace";
    baselineFailure = "parse_error";
  } else if (literalBroken) {
    baselineDetail = "naive replace corrupted string literal (expected brittle failure)";
    baselineFailure = "false_positive_rename";
  } else {
    baselineDetail = "unexpected: naive replace kept literal and parsed";
    baselineFailure = "unexpected_success";
  }

  const baseline = approachMetrics({
    outcome: brittleFailed ? "failure" : "success",
    failure_reason: baselineFailure,
    full_file_reads: 1,
    round_trips: 1,
    tokens_chars_read: raw.length,
    failed_patches: brittleFailed ? 1 : 0,
    detail: baselineDetail,
  });

  await refreshAbFixtures(cloneRoot);
  const snap = await materializeSnapshot({ rootPath: snapshotRoot });
  const u = snap.units.find((k) => k.file_path === rel);
  if (!u) {
    return {
      task_id,
      baseline,
      ir: approachMetrics({
        outcome: "failure",
        failure_reason: "string_not_found",
        full_file_reads: snap.files.length,
        round_trips: 1,
        tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
        failed_patches: 1,
        detail: "missing homonym.ts unit",
        validation_codes: [],
      }),
    };
  }
  const report = await applyBatch({
    snapshotRootPath: snapshotRoot,
    snapshot: snap,
    ops: [{ op: "rename_symbol", target_id: u.id, new_name: "renamedFn" }],
    toolchainFingerprintAtApply: TOOLCHAIN,
  });
  const text = await readFile(abs, "utf8");
  const irOk =
    report.outcome === "success" && text.includes('"victim"') && !/\bfunction\s+victim\b/.test(text);
  return {
    task_id,
    baseline,
    ir: approachMetrics({
      outcome: irOk ? "success" : "failure",
      failure_reason: irOk ? null : report.outcome === "success" ? "postcondition_failed" : "parse_error",
      full_file_reads: snap.files.length,
      round_trips: 1,
      tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
      failed_patches: irOk ? 0 : 1,
      detail:
        report.outcome === "success"
          ? irOk
            ? "rename_symbol retained string literal"
            : "postcondition check failed"
          : (report.entries[0]?.message ?? "applyBatch failed"),
      validation_codes: validationCodesFromReport(report),
    }),
  };
}

async function runExportDup(cloneRoot: string, snapshotRoot: string): Promise<TaskMetrics> {
  const task_id = "export_dup_replace_unit";
  const rel = "export_dup.ts";
  const abs = join(snapshotRoot, rel);

  await refreshAbFixtures(cloneRoot);
  await writeFile(abs, EXPORT_DUP_BAD, "utf8");
  const rawRead = await readFile(abs, "utf8");
  const baselineParseOk = parseTreeOk(rawRead);
  const baseline = approachMetrics({
    outcome: baselineParseOk ? "success" : "failure",
    failure_reason: baselineParseOk ? "unexpected_success" : "parse_error",
    full_file_reads: 1,
    round_trips: 1,
    tokens_chars_read: rawRead.length,
    failed_patches: baselineParseOk ? 0 : 1,
    detail: baselineParseOk ? "unexpected parse success" : "parse_error (export export)",
  });

  await refreshAbFixtures(cloneRoot);
  const snap = await materializeSnapshot({ rootPath: snapshotRoot });
  const inFile = snap.units.filter((u) => u.file_path === rel).sort((a, b) => a.start_byte - b.start_byte);
  const victim = inFile[1];
  if (!victim) {
    return {
      task_id,
      baseline,
      ir: approachMetrics({
        outcome: "failure",
        failure_reason: "string_not_found",
        full_file_reads: snap.files.length,
        round_trips: 1,
        tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
        failed_patches: 1,
        detail: "missing second unit",
        validation_codes: [],
      }),
    };
  }
  const report = await applyBatch({
    snapshotRootPath: snapshotRoot,
    snapshot: snap,
    ops: [
      {
        op: "replace_unit",
        target_id: victim.id,
        new_text: "function victim(): number {\n  return 99;\n}\n",
      },
    ],
    toolchainFingerprintAtApply: TOOLCHAIN,
  });
  const irOk = report.outcome === "success";
  return {
    task_id,
    baseline,
    ir: approachMetrics({
      outcome: irOk ? "success" : "failure",
      failure_reason: irOk ? null : "parse_error",
      full_file_reads: snap.files.length,
      round_trips: 1,
      tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
      failed_patches: irOk ? 0 : 1,
      detail: irOk ? "replace_unit without duplicate export" : (report.entries[0]?.message ?? "failed"),
      validation_codes: validationCodesFromReport(report),
    }),
  };
}

async function runStacked(cloneRoot: string, snapshotRoot: string): Promise<TaskMetrics> {
  const task_id = "stacked_middle_replace_unit";
  const rel = "stacked.ts";
  const abs = join(snapshotRoot, rel);

  await refreshAbFixtures(cloneRoot);
  await writeFile(abs, STACKED_BAD, "utf8");
  const rawRead = await readFile(abs, "utf8");
  const baselineParseOk = parseTreeOk(rawRead);
  const baseline = approachMetrics({
    outcome: baselineParseOk ? "success" : "failure",
    failure_reason: baselineParseOk ? "unexpected_success" : "parse_error",
    full_file_reads: 1,
    round_trips: 1,
    tokens_chars_read: rawRead.length,
    failed_patches: baselineParseOk ? 0 : 1,
    detail: baselineParseOk ? "unexpected parse success" : "parse_error (export export on mid)",
  });

  await refreshAbFixtures(cloneRoot);
  const snap = await materializeSnapshot({ rootPath: snapshotRoot });
  const units = snap.units.filter((u) => u.file_path === rel).sort((a, b) => a.start_byte - b.start_byte);
  const mid = units[1];
  if (!mid) {
    return {
      task_id,
      baseline,
      ir: approachMetrics({
        outcome: "failure",
        failure_reason: "string_not_found",
        full_file_reads: snap.files.length,
        round_trips: 1,
        tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
        failed_patches: 1,
        detail: "missing middle unit",
        validation_codes: [],
      }),
    };
  }
  const report = await applyBatch({
    snapshotRootPath: snapshotRoot,
    snapshot: snap,
    ops: [
      {
        op: "replace_unit",
        target_id: mid.id,
        new_text: "function mid(): number {\n  return 10;\n}\n",
      },
    ],
    toolchainFingerprintAtApply: TOOLCHAIN,
  });
  const irOk = report.outcome === "success";
  return {
    task_id,
    baseline,
    ir: approachMetrics({
      outcome: irOk ? "success" : "failure",
      failure_reason: irOk ? null : "parse_error",
      full_file_reads: snap.files.length,
      round_trips: 1,
      tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
      failed_patches: irOk ? 0 : 1,
      detail: irOk ? "middle unit replace ok" : (report.entries[0]?.message ?? "failed"),
      validation_codes: validationCodesFromReport(report),
    }),
  };
}
