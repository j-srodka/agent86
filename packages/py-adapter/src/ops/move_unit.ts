import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import { fetchBlobText } from "../blobs.js";
import { applyMoveIdResolveEdge, resolveOpTarget } from "../id_resolve.js";
import { parsePythonSource } from "../parser.js";
import {
  canonicalizeSourceForSnapshot,
  materializeSnapshot,
  type MaterializeSnapshotOptions,
} from "../snapshot.js";
import { declaredNameFromUnitSource, extractLogicalUnits } from "../units.js";
import { PY_GRAMMAR_DIGEST } from "../grammar.js";
import type { LogicalUnit, WorkspaceSnapshot } from "../types.js";

function toPosixPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
}

async function readUnitText(unit: LogicalUnit, snapshotRootPath: string): Promise<string> {
  if (unit.source_text != null) {
    return unit.source_text;
  }
  if (unit.blob_ref != null) {
    return fetchBlobText(unit.blob_ref, snapshotRootPath);
  }
  throw new Error("unit has no source_text or blob_ref");
}

export interface MoveUnitInput {
  snapshotRootPath: string;
  snapshot: WorkspaceSnapshot;
  unit: LogicalUnit;
  destinationFilePosix: string;
  insertAfterId?: string;
  materialize?: Pick<MaterializeSnapshotOptions, "inline_threshold_bytes" | "previousSnapshot">;
}

export type MoveUnitResult =
  | { ok: true; nextSnapshot: WorkspaceSnapshot; id_resolve_delta: Record<string, string> }
  | { ok: false; code: string; message: string };

/**
 * Cross-file move of a logical unit's canonical source bytes.
 *
 * Import rewriting in other files is NOT performed — callers must update imports.
 * See `docs/impl/v0-decisions.md` — move_unit v1.
 */
export async function applyMoveUnit(input: MoveUnitInput): Promise<MoveUnitResult> {
  const { snapshot, unit, insertAfterId } = input;
  const snapshotRootResolved = resolvePath(input.snapshotRootPath);
  const destinationFilePosix = toPosixPath(input.destinationFilePosix);

  if (!destinationFilePosix.endsWith(".py")) {
    return {
      ok: false,
      code: "parse_error",
      message: "move_unit: destination_file must be a repo-relative .py path",
    };
  }

  const sourcePath = unit.file_path;
  if (sourcePath === destinationFilePosix) {
    return {
      ok: false,
      code: "lang.py.move_unit_same_file",
      message:
        "[lang.py.move_unit_same_file] destination_file equals source file; same-file reorder is out of scope for v1",
    };
  }

  const unitText = await readUnitText(unit, snapshotRootResolved);
  const movedName = declaredNameFromUnitSource(unitText);
  if (!movedName) {
    return {
      ok: false,
      code: "parse_error",
      message: "move_unit: could not determine declared name of logical unit",
    };
  }

  const destAbs = join(snapshotRootResolved, ...destinationFilePosix.split("/"));
  const sourceAbs = join(snapshotRootResolved, ...sourcePath.split("/"));

  let destCanonical = "";
  if (existsSync(destAbs)) {
    const raw = await readFile(destAbs, "utf8");
    destCanonical = canonicalizeSourceForSnapshot(raw);
  }

  if (destCanonical.length > 0) {
    const tree = parsePythonSource(destCanonical);
    const spans = extractLogicalUnits(tree, {
      grammarDigest: PY_GRAMMAR_DIGEST,
      snapshotRootResolved,
      filePathPosix: destinationFilePosix,
    });
    for (const span of spans) {
      const slice = destCanonical.slice(span.start_byte, span.end_byte);
      const n = declaredNameFromUnitSource(slice);
      if (n === movedName) {
        return {
          ok: false,
          code: "lang.py.move_unit_name_conflict",
          message: `[lang.py.move_unit_name_conflict] destination file already declares a unit named "${movedName}"`,
        };
      }
    }
  }

  let insertAfterUnit: LogicalUnit | undefined;
  if (insertAfterId !== undefined && insertAfterId.length > 0) {
    const insRes = resolveOpTarget(snapshot, insertAfterId);
    if (insRes.kind !== "live" || insRes.unit.file_path !== destinationFilePosix) {
      return {
        ok: false,
        code: "unknown_or_superseded_id",
        message: "insert_after_id does not resolve to a live unit in destination_file",
      };
    }
    insertAfterUnit = insRes.unit;
  }

  const sourceRaw = await readFile(sourceAbs, "utf8");
  const sourceCanonical = canonicalizeSourceForSnapshot(sourceRaw);
  if (unit.start_byte < 0 || unit.end_byte > sourceCanonical.length || unit.start_byte > unit.end_byte) {
    return {
      ok: false,
      code: "parse_error",
      message: "move_unit: unit byte range out of bounds for source file",
    };
  }

  const nextSource =
    sourceCanonical.slice(0, unit.start_byte) + sourceCanonical.slice(unit.end_byte);

  let nextDest: string;
  let insertedStartByte: number;

  if (destCanonical.length === 0) {
    nextDest = unitText.endsWith("\n") ? unitText : `${unitText}\n`;
    insertedStartByte = 0;
  } else if (insertAfterUnit) {
    const pos = insertAfterUnit.end_byte;
    const between = "\n\n";
    nextDest = destCanonical.slice(0, pos) + between + unitText + destCanonical.slice(pos);
    insertedStartByte = pos + between.length;
  } else {
    const between = destCanonical.endsWith("\n") ? "\n" : "\n\n";
    insertedStartByte = destCanonical.length + between.length;
    nextDest = destCanonical + between + unitText;
  }

  await mkdir(dirname(destAbs), { recursive: true });
  await writeFile(sourceAbs, nextSource, "utf8");
  await writeFile(destAbs, nextDest, "utf8");

  const nextBase = await materializeSnapshot({
    rootPath: snapshotRootResolved,
    inline_threshold_bytes: input.materialize?.inline_threshold_bytes,
    previousSnapshot: input.materialize?.previousSnapshot ?? snapshot,
  });

  const newUnit = nextBase.units.find(
    (u) => u.file_path === destinationFilePosix && u.start_byte === insertedStartByte,
  );
  if (!newUnit) {
    return {
      ok: false,
      code: "parse_error",
      message: "move_unit: could not locate moved unit after re-materialization",
    };
  }

  const old_id = unit.id;
  const new_id = newUnit.id;
  const id_resolve = applyMoveIdResolveEdge(nextBase.id_resolve, old_id, new_id);

  return {
    ok: true,
    nextSnapshot: {
      ...nextBase,
      id_resolve,
    },
    id_resolve_delta: { [old_id]: new_id },
  };
}
