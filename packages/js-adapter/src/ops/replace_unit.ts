import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalizeSourceForSnapshot,
  materializeSnapshot,
  type MaterializeSnapshotOptions,
} from "../snapshot.js";
import { parseJavaScriptSource } from "../parser.js";
import type { LogicalUnit, WorkspaceSnapshot } from "../types.js";

export interface ReplaceUnitInput {
  snapshotRootPath: string;
  unit: LogicalUnit;
  newText: string;
  materialize?: Pick<MaterializeSnapshotOptions, "inline_threshold_bytes" | "previousSnapshot">;
}

export interface ReplaceUnitOk {
  ok: true;
  nextSnapshot: WorkspaceSnapshot;
}

export interface ReplaceUnitErr {
  ok: false;
  message: string;
}

export type ReplaceUnitResult = ReplaceUnitOk | ReplaceUnitErr;

/**
 * Replace the exact logical unit span `[start_byte, end_byte)` with `newText`,
 * re-parse, and re-materialize the workspace snapshot.
 */
export async function applyReplaceUnit(input: ReplaceUnitInput): Promise<ReplaceUnitResult> {
  const { unit, newText, snapshotRootPath } = input;
  const abs = join(snapshotRootPath, ...unit.file_path.split("/"));
  const raw = await readFile(abs, "utf8");
  const canonical = canonicalizeSourceForSnapshot(raw);
  if (unit.start_byte < 0 || unit.end_byte > canonical.length || unit.start_byte > unit.end_byte) {
    return { ok: false, message: "unit byte range out of bounds" };
  }
  const nextSource =
    canonical.slice(0, unit.start_byte) + newText + canonical.slice(unit.end_byte);
  const tree = parseJavaScriptSource(nextSource);
  if (tree.rootNode.hasError) {
    return { ok: false, message: "parse_error after replace_unit splice" };
  }
  await writeFile(abs, nextSource, "utf8");
  const nextSnapshot = await materializeSnapshot({
    rootPath: snapshotRootPath,
    inline_threshold_bytes: input.materialize?.inline_threshold_bytes,
    previousSnapshot: input.materialize?.previousSnapshot,
  });
  return { ok: true, nextSnapshot };
}
