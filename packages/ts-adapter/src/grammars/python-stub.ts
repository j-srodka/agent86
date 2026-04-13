/**
 * STUB: regex-based Python unit detection.
 * Not a production adapter. For benchmark language-agnosticism demonstration only.
 *
 * This module does not use Tree-sitter or a Python parser. It recognizes top-level
 * `def …` and `class …` blocks at column 0 only (no leading whitespace on the `def`/`class` line).
 *
 * `grammar_digest` for snapshots using this stub is the SHA-256 (hex) of the UTF-8 source
 * of this file **excluding** the `PYTHON_STUB_GRAMMAR_DIGEST` export block (so the pin is stable).
 */

import { createHash } from "node:crypto";

import type { Provenance } from "../types.js";

export type PythonStubUnitKind = "function_declaration" | "class_declaration";

/** Wire shape aligned with `LogicalUnit.kind` strings used by the benchmark sampler. */
export interface PythonStubUnit {
  id: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  kind: PythonStubUnitKind;
}

function sha256Hex(utf8: string): string {
  return createHash("sha256").update(utf8, "utf8").digest("hex");
}

/**
 * SHA-256 (hex) of this file’s UTF-8 bytes with this block removed — update when stub logic changes.
 */
export const PYTHON_STUB_GRAMMAR_DIGEST =
  "90658f3cc521c12f3e3d778011ea326bafccb7f8aab619d6d8e20ea2ef3a42b4";

function computeUnitId(input: {
  grammarDigest: string;
  snapshotRootResolved: string;
  filePathPosix: string;
  startByte: number;
  endByte: number;
  kind: PythonStubUnitKind;
}): string {
  const line = [
    input.grammarDigest,
    input.snapshotRootResolved,
    input.filePathPosix,
    String(input.startByte),
    String(input.endByte),
    input.kind,
  ].join("|");
  return sha256Hex(line);
}

/**
 * Top-level `def` / `class` blocks: the defining line has no leading whitespace; blocks run
 * until the next top-level `def` or `class` line or EOF.
 */
export function detectPythonUnits(
  filePath: string,
  source: string,
  input: { grammarDigest: string; snapshotRootResolved: string },
): PythonStubUnit[] {
  const text = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out: PythonStubUnit[] = [];
  let pos = 0;
  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(pos, end);
    const isTop =
      line.length > 0 &&
      (line[0] === "d" || line[0] === "c") &&
      !/^\s/.test(line);
    let kind: PythonStubUnitKind | null = null;
    if (isTop && /^def\s+[A-Za-z_]\w*\s*\(/.test(line)) {
      kind = "function_declaration";
    } else if (isTop && /^class\s+[A-Za-z_]\w*\b/.test(line)) {
      kind = "class_declaration";
    }
    if (kind === null) {
      pos = end === text.length ? text.length : end + 1;
      continue;
    }
    const blockStart = pos;
    let j = end === text.length ? text.length : end + 1;
    while (j < text.length) {
      const ne = text.indexOf("\n", j);
      const nextEnd = ne === -1 ? text.length : ne;
      const nextLine = text.slice(j, nextEnd);
      const topNext =
        nextLine.length > 0 &&
        !/^\s/.test(nextLine) &&
        (/^def\s+[A-Za-z_]\w*\s*\(/.test(nextLine) || /^class\s+[A-Za-z_]\w*\b/.test(nextLine));
      if (topNext) {
        break;
      }
      j = nextEnd === text.length ? text.length : nextEnd + 1;
    }
    const blockEnd = j;
    const id = computeUnitId({
      grammarDigest: input.grammarDigest,
      snapshotRootResolved: input.snapshotRootResolved,
      filePathPosix: filePath,
      startByte: blockStart,
      endByte: blockEnd,
      kind,
    });
    out.push({
      id,
      file_path: filePath,
      start_byte: blockStart,
      end_byte: blockEnd,
      kind,
    });
    pos = j;
  }
  return out;
}

export function defaultAuthoredProvenance(): Provenance {
  return { kind: "authored" };
}
