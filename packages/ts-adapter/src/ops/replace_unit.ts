import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { materializeSnapshot, canonicalizeSourceForSnapshot } from "../snapshot.js";
import { parseTypeScriptSource } from "../parser.js";
import type { LogicalUnit, WorkspaceSnapshot } from "../types.js";

export interface ReplaceUnitInput {
  snapshotRootPath: string;
  unit: LogicalUnit;
  newText: string;
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
 *
 * For exported functions, the span is typically the `function_declaration` only
 * (starts at `function`); do not duplicate a leading `export` unless the span includes it.
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
  const tree = parseTypeScriptSource(nextSource);
  if (tree.rootNode.hasError) {
    return { ok: false, message: "parse_error after replace_unit splice" };
  }
  await writeFile(abs, nextSource, "utf8");
  const nextSnapshot = await materializeSnapshot({ rootPath: snapshotRootPath });
  return { ok: true, nextSnapshot };
}
