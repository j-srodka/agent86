import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyBatch, materializeSnapshot, parseTypeScriptSource, canonicalizeSourceForSnapshot } from "ts-adapter";
import type { ValidationReport, WorkspaceSnapshot } from "ts-adapter";

import type { TaskMetrics } from "./metrics.js";
import { approachMetrics, tokenCharsFromSnapshotFiles } from "./metrics.js";

const TOOLCHAIN = "toolchain:ab-harness";

/** Pinned tRPC tree layout — paths are repo-relative to the clone root. */
export const TRPC_PATHS = {
  router: "packages/server/src/unstable-core-do-not-import/router.ts",
  localLink: "packages/client/src/links/localLink.ts",
  serverIndex: "packages/server/src/@trpc/server/index.ts",
  utils: "packages/server/src/unstable-core-do-not-import/utils.ts",
  inputHelper: "packages/client/src/internals/inputWithTrackedEventId.ts",
  probe: "packages/probe/homonym.ts",
} as const;

const PROBE_TS = `/** A/B harness — literal must stay intact under identifier-aware rename. */
export const trpcAbDemoLiteral = "callProcedure";
`;

function parseTreeOk(source: string): boolean {
  const t = parseTypeScriptSource(canonicalizeSourceForSnapshot(source));
  return !t.rootNode.hasError;
}

function validationCodesFromReport(r: ValidationReport): string[] {
  return r.entries.map((e) => String(e.code));
}

async function copyInto(cloneRoot: string, destRoot: string, rel: string): Promise<void> {
  const from = join(cloneRoot, rel);
  const to = join(destRoot, rel);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from, "utf8"), "utf8");
}

async function rmrf(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function stageTaskA(cloneRoot: string): Promise<string> {
  const snapshotRoot = join(cloneRoot, "__agent_ir_trpc__", "a");
  await rmrf(snapshotRoot);
  await copyInto(cloneRoot, snapshotRoot, TRPC_PATHS.router);
  await copyInto(cloneRoot, snapshotRoot, TRPC_PATHS.localLink);
  await copyInto(cloneRoot, snapshotRoot, TRPC_PATHS.serverIndex);
  const probeAbs = join(snapshotRoot, TRPC_PATHS.probe);
  await mkdir(dirname(probeAbs), { recursive: true });
  await writeFile(probeAbs, PROBE_TS, "utf8");
  return snapshotRoot;
}

async function stageTaskB(cloneRoot: string): Promise<string> {
  const snapshotRoot = join(cloneRoot, "__agent_ir_trpc__", "b");
  await rmrf(snapshotRoot);
  await copyInto(cloneRoot, snapshotRoot, TRPC_PATHS.utils);
  return snapshotRoot;
}

async function stageTaskC(cloneRoot: string): Promise<string> {
  const snapshotRoot = join(cloneRoot, "__agent_ir_trpc__", "c");
  await rmrf(snapshotRoot);
  await copyInto(cloneRoot, snapshotRoot, TRPC_PATHS.inputHelper);
  await copyInto(cloneRoot, snapshotRoot, TRPC_PATHS.utils);
  return snapshotRoot;
}

const NEW_PROC_NAME = "invokeTrpcProcedure";

async function runTaskCrossRename(cloneRoot: string): Promise<TaskMetrics> {
  const task_id = "trpc_cross_package_rename_callProcedure";
  const snapshotRoot = await stageTaskA(cloneRoot);

  const tracked = [
    join(snapshotRoot, TRPC_PATHS.router),
    join(snapshotRoot, TRPC_PATHS.localLink),
    join(snapshotRoot, TRPC_PATHS.serverIndex),
    join(snapshotRoot, TRPC_PATHS.probe),
  ];

  let baselineReads = 0;
  let baselineChars = 0;
  let baselineParseFail = false;
  let literalCorrupted = false;

  for (const abs of tracked) {
    const raw = await readFile(abs, "utf8");
    baselineReads += 1;
    baselineChars += raw.length;
    const naive = raw.replaceAll("callProcedure", NEW_PROC_NAME);
    await writeFile(abs, naive, "utf8");
    if (abs === join(snapshotRoot, TRPC_PATHS.probe)) {
      literalCorrupted = !naive.includes('"callProcedure"');
    }
    if (!parseTreeOk(naive)) {
      baselineParseFail = true;
    }
  }

  const baselineFail = baselineParseFail || literalCorrupted;

  const baseline = approachMetrics({
    outcome: baselineFail ? "failure" : "success",
    failure_reason: baselineFail ? (literalCorrupted ? "false_positive_rename" : "parse_error") : null,
    full_file_reads: baselineReads,
    round_trips: 1,
    tokens_chars_read: baselineChars,
    failed_patches: baselineFail ? 1 : 0,
    detail: literalCorrupted
      ? "naive replace corrupted probe string literal"
      : baselineParseFail
        ? "parse_error after naive global replace"
        : "unexpected baseline success",
  });

  await stageTaskA(cloneRoot);
  const snap = await materializeSnapshot({ rootPath: snapshotRoot });
  const decl = snap.units.find(
    (u) =>
      u.file_path === TRPC_PATHS.router &&
      u.kind === "function_declaration" &&
      /\bcallProcedure\b/.test(u.source_text ?? ""),
  );
  if (!decl) {
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
        detail: "could not find callProcedure logical unit",
        validation_codes: [],
      }),
    };
  }

  const report = await applyBatch({
    snapshotRootPath: snapshotRoot,
    snapshot: snap,
    ops: [{ op: "rename_symbol", target_id: decl.id, new_name: NEW_PROC_NAME, cross_file: true }],
    toolchainFingerprintAtApply: TOOLCHAIN,
  });

  const routerText = await readFile(join(snapshotRoot, TRPC_PATHS.router), "utf8");
  const probeText = await readFile(join(snapshotRoot, TRPC_PATHS.probe), "utf8");
  const irOk =
    report.outcome === "success" &&
    probeText.includes('"callProcedure"') &&
    !/\bcallProcedure\b/.test(routerText);

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
            ? "rename_symbol cross_file; probe literal preserved"
            : "postcondition failed"
          : (report.entries[0]?.message ?? "applyBatch failed"),
      validation_codes: validationCodesFromReport(report),
    }),
  };
}

async function runTaskReplaceUtil(cloneRoot: string): Promise<TaskMetrics> {
  const task_id = "trpc_replace_isObject_utils";
  const snapshotRoot = await stageTaskB(cloneRoot);
  const abs = join(snapshotRoot, TRPC_PATHS.utils);

  const raw = await readFile(abs, "utf8");
  const baselineReads = 1;
  const baselineChars = raw.length;
  const dupExport = raw.replace("export function isObject", "export export function isObject");
  await writeFile(abs, dupExport, "utf8");
  const baselineFail = !parseTreeOk(dupExport);

  const baseline = approachMetrics({
    outcome: baselineFail ? "failure" : "success",
    failure_reason: baselineFail ? "parse_error" : null,
    full_file_reads: baselineReads,
    round_trips: 1,
    tokens_chars_read: baselineChars,
    failed_patches: baselineFail ? 1 : 0,
    detail: baselineFail ? "baseline duplicated export keyword (brittle splice)" : "unexpected baseline parse success",
  });

  await stageTaskB(cloneRoot);
  const snap = await materializeSnapshot({ rootPath: snapshotRoot });
  const u = snap.units.find(
    (k) =>
      k.file_path === TRPC_PATHS.utils &&
      k.kind === "function_declaration" &&
      /\bfunction isObject\b/.test(k.source_text ?? ""),
  );
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
        detail: "missing isObject unit",
        validation_codes: [],
      }),
    };
  }

  const newBody = `function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && !Array.isArray(value) && typeof value === 'object';
}
`;

  const report = await applyBatch({
    snapshotRootPath: snapshotRoot,
    snapshot: snap,
    ops: [{ op: "replace_unit", target_id: u.id, new_text: newBody }],
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
      detail: irOk ? "replace_unit with span-consistent new_text" : (report.entries[0]?.message ?? "failed"),
      validation_codes: validationCodesFromReport(report),
    }),
  };
}

function findInsertAfterIdForMove(snap: WorkspaceSnapshot): string | undefined {
  const inDest = snap.units
    .filter((u) => u.file_path === TRPC_PATHS.utils)
    .sort((a, b) => a.start_byte - b.start_byte);
  const noop = inDest.find((u) => /\bfunction noop\b/.test(u.source_text ?? ""));
  return noop?.id;
}

async function runTaskMoveHelper(cloneRoot: string): Promise<TaskMetrics> {
  const task_id = "trpc_move_inputWithTrackedEventId_to_utils";
  const snapshotRoot = await stageTaskC(cloneRoot);
  const srcAbs = join(snapshotRoot, TRPC_PATHS.inputHelper);
  const dstAbs = join(snapshotRoot, TRPC_PATHS.utils);

  const inputRaw = await readFile(srcAbs, "utf8");
  const utilsRaw = await readFile(dstAbs, "utf8");
  let baselineReads = 2;
  let baselineChars = inputRaw.length + utilsRaw.length;

  const wrecked =
    utilsRaw +
    "\n" +
    inputRaw +
    "\nexport function inputWithTrackedEventId(incomplete: unknown";

  await writeFile(dstAbs, wrecked, "utf8");
  await writeFile(srcAbs, "export const trpcAbBroken = ", "utf8");

  const dstText = await readFile(dstAbs, "utf8");
  const srcText = await readFile(srcAbs, "utf8");
  baselineReads += 2;
  baselineChars += dstText.length + srcText.length;

  const baselineFail = !parseTreeOk(dstText) || !parseTreeOk(srcText);

  const baseline = approachMetrics({
    outcome: baselineFail ? "failure" : "success",
    failure_reason: baselineFail ? "parse_error" : null,
    full_file_reads: baselineReads,
    round_trips: 1,
    tokens_chars_read: baselineChars,
    failed_patches: baselineFail ? 1 : 0,
    detail: baselineFail
      ? "baseline copy/delete left malformed source and incomplete duplicate declaration in utils"
      : "unexpected baseline success",
  });

  await stageTaskC(cloneRoot);
  const snap = await materializeSnapshot({ rootPath: snapshotRoot });
  const moveUnit = snap.units.find((u) => u.file_path === TRPC_PATHS.inputHelper);
  if (!moveUnit) {
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
        detail: "missing inputWithTrackedEventId unit",
        validation_codes: [],
      }),
    };
  }

  const insertAfter = findInsertAfterIdForMove(snap);
  const report = await applyBatch({
    snapshotRootPath: snapshotRoot,
    snapshot: snap,
    ops: [
      {
        op: "move_unit",
        target_id: moveUnit.id,
        destination_file: TRPC_PATHS.utils,
        ...(insertAfter ? { insert_after_id: insertAfter } : {}),
      },
    ],
    toolchainFingerprintAtApply: TOOLCHAIN,
  });

  const irOk = report.outcome === "success";
  const destAfter = irOk ? await readFile(join(snapshotRoot, TRPC_PATHS.utils), "utf8") : "";
  const movedPresent = irOk && destAfter.includes("inputWithTrackedEventId");

  return {
    task_id,
    baseline,
    ir: approachMetrics({
      outcome: irOk && movedPresent ? "success" : "failure",
      failure_reason: irOk && movedPresent ? null : "parse_error",
      full_file_reads: snap.files.length,
      round_trips: 1,
      tokens_chars_read: tokenCharsFromSnapshotFiles(snap),
      failed_patches: irOk && movedPresent ? 0 : 1,
      detail: irOk
        ? movedPresent
          ? "move_unit appended helper into utils with id_resolve_delta"
          : "postcondition: helper not found in destination"
        : (report.entries[0]?.message ?? "move_unit failed"),
      validation_codes: validationCodesFromReport(report),
    }),
  };
}

export async function runTrpcDemoSuite(cloneRoot: string): Promise<{ snapshotRoot: string; tasks: TaskMetrics[] }> {
  const tasks: TaskMetrics[] = [];
  tasks.push(await runTaskCrossRename(cloneRoot));
  tasks.push(await runTaskReplaceUtil(cloneRoot));
  tasks.push(await runTaskMoveHelper(cloneRoot));
  return { snapshotRoot: join(cloneRoot, "__agent_ir_trpc__"), tasks };
}

export function formatTrpcDemoSummary(tasks: TaskMetrics[]): string {
  const label: Record<string, string> = {
    trpc_cross_package_rename_callProcedure: "rename",
    trpc_replace_isObject_utils: "replace",
    trpc_move_inputWithTrackedEventId_to_utils: "move",
  };
  const letters = ["A", "B", "C"];
  const lines: string[] = ["=== tRPC Demo Results ==="];
  let bFail = 0;
  let irFail = 0;
  tasks.forEach((t, i) => {
    const tag = label[t.task_id] ?? t.task_id;
    if (t.baseline.outcome === "failure") {
      bFail += 1;
    }
    if (t.ir.outcome === "failure") {
      irFail += 1;
    }
    const letter = letters[i] ?? String(i);
    lines.push(
      `Task ${letter} (${tag}): baseline=${t.baseline.outcome.toUpperCase()} ir=${t.ir.outcome.toUpperCase()} reads: ${t.baseline.full_file_reads} vs ${t.ir.full_file_reads}`,
    );
  });
  lines.push(`Overall failed patch rate: baseline ${bFail}/${tasks.length}, IR ${irFail}/${tasks.length}`);
  return lines.join("\n");
}

export function printTrpcDemoSummary(tasks: TaskMetrics[]): void {
  console.log(formatTrpcDemoSummary(tasks));
}
