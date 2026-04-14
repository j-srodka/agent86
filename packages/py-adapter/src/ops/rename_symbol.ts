import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "tree-sitter";

import {
  canonicalizeSourceForSnapshot,
  materializeSnapshot,
  type MaterializeSnapshotOptions,
} from "../snapshot.js";
import { parsePythonSource } from "../parser.js";
import type { LogicalUnit, RenameSurfaceReport, WorkspaceSnapshot } from "../types.js";

/** Cross-file `rename_surface_report.found` threshold for `lang.py.cross_file_rename_broad_match`. */
export const CROSS_FILE_RENAME_BROAD_MATCH_THRESHOLD = 10;

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface SkippedRef {
  unit_id: string | null;
  reason: string;
  file: string;
}

function isUnderStringOrComment(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur !== null) {
    const t = cur.type;
    if (
      t === "string" ||
      t === "concatenated_string" ||
      t === "comment" ||
      t === "string_content"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function collectIdentifiers(node: Parser.SyntaxNode, acc: Parser.SyntaxNode[]): void {
  if (node.type === "identifier") {
    acc.push(node);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) collectIdentifiers(c, acc);
  }
}

function applyEditsDescending(canonical: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let next = canonical;
  for (const e of sorted) {
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  }
  return next;
}

function enclosingUnitId(
  snapshot: WorkspaceSnapshot,
  filePath: string,
  refStart: number,
  refEnd: number,
): string | null {
  const candidates = snapshot.units.filter(
    (u) => u.file_path === filePath && u.start_byte <= refStart && u.end_byte >= refEnd,
  );
  if (candidates.length === 0) return null;
  return candidates
    .slice()
    .sort((a, b) => a.end_byte - a.start_byte - (b.end_byte - b.start_byte))[0]!.id;
}

function makeSkipped(
  snapshot: WorkspaceSnapshot,
  filePath: string,
  node: Parser.SyntaxNode,
  reason: string,
): SkippedRef {
  const unit_id = enclosingUnitId(snapshot, filePath, node.startIndex, node.endIndex);
  return { unit_id, reason, file: filePath };
}

function renameInSource(
  canonical: string,
  filePath: string,
  oldName: string,
  newName: string,
  snapshot: WorkspaceSnapshot,
): { nextSource: string; report: RenameSurfaceReport } {
  const tree = parsePythonSource(canonical);
  const nodes: Parser.SyntaxNode[] = [];
  collectIdentifiers(tree.rootNode, nodes);

  const edits: Edit[] = [];
  const skipped: SkippedRef[] = [];
  let found = 0;
  let rewritten = 0;

  for (const n of nodes) {
    if (n.text !== oldName) continue;
    found++;
    if (isUnderStringOrComment(n)) {
      skipped.push(makeSkipped(snapshot, filePath, n, "skip:string_or_comment_context"));
      continue;
    }
    edits.push({ start: n.startIndex, end: n.endIndex, text: newName });
    rewritten++;
  }

  const nextSource = edits.length > 0 ? applyEditsDescending(canonical, edits) : canonical;
  return {
    nextSource,
    report: { found, rewritten, skipped },
  };
}

function mergeReports(a: RenameSurfaceReport, b: RenameSurfaceReport): RenameSurfaceReport {
  return {
    found: a.found + b.found,
    rewritten: a.rewritten + b.rewritten,
    skipped: [...a.skipped, ...b.skipped],
  };
}

export interface RenameSymbolInput {
  snapshotRootPath: string;
  snapshot: WorkspaceSnapshot;
  unit: LogicalUnit;
  newName: string;
  cross_file?: boolean;
  materialize?: Pick<MaterializeSnapshotOptions, "inline_threshold_bytes" | "previousSnapshot">;
}

export interface RenameSymbolOk {
  ok: true;
  nextSnapshot: WorkspaceSnapshot;
  id_resolve_delta: Record<string, string>;
  rename_surface_report: RenameSurfaceReport;
}

export interface RenameSymbolErr {
  ok: false;
  message: string;
  code?: "lang.py.rename_unsupported_node_kind" | "parse_error";
}

export type RenameSymbolResult = RenameSymbolOk | RenameSymbolErr;

/**
 * `rename_symbol` for Python: identifier-level rename within the declaring file,
 * optional best-effort cross-file identifier rewrite.
 * Supported unit kinds: `function_definition`, `class_definition`.
 */
export async function applyRenameSymbol(input: RenameSymbolInput): Promise<RenameSymbolResult> {
  const { unit, newName, snapshotRootPath, snapshot } = input;
  const crossFile = input.cross_file === true;

  if (unit.kind !== "function_definition" && unit.kind !== "class_definition") {
    return {
      ok: false,
      message: "rename_symbol supports function_definition and class_definition only",
      code: "lang.py.rename_unsupported_node_kind",
    };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    return { ok: false, message: "invalid new_name identifier" };
  }

  const abs = join(snapshotRootPath, ...unit.file_path.split("/"));
  const raw = await readFile(abs, "utf8");
  const canonical = canonicalizeSourceForSnapshot(raw);
  const tree = parsePythonSource(canonical);

  // Find the declaring unit node to extract oldName.
  const span = canonical.slice(unit.start_byte, unit.end_byte);
  const spanTree = parsePythonSource(span);
  let oldName: string | null = null;
  for (let i = 0; i < spanTree.rootNode.namedChildCount; i++) {
    const c = spanTree.rootNode.namedChild(i);
    if (!c) continue;
    if (c.type === "function_definition" || c.type === "class_definition") {
      const n = c.childForFieldName("name");
      if (n) { oldName = n.text; break; }
    }
    if (c.type === "decorated_definition") {
      for (let j = 0; j < c.namedChildCount; j++) {
        const inner = c.namedChild(j);
        if (inner && (inner.type === "function_definition" || inner.type === "class_definition")) {
          const n = inner.childForFieldName("name");
          if (n) { oldName = n.text; break; }
        }
      }
      if (oldName) break;
    }
  }
  if (!oldName) {
    return { ok: false, message: "could not determine declared name from unit span" };
  }
  if (oldName === newName) {
    return { ok: false, message: "old and new name identical" };
  }

  void tree; // tree is reparsed in renameInSource below

  const { nextSource: sameFileSource, report: sameReport } = renameInSource(
    canonical,
    unit.file_path,
    oldName,
    newName,
    snapshot,
  );

  const outMap = new Map<string, string>();
  outMap.set(unit.file_path, sameFileSource);
  let mergedReport = sameReport;

  if (crossFile) {
    const others = snapshot.files
      .map((f) => f.path)
      .filter((p) => p !== unit.file_path)
      .sort((a, b) => a.localeCompare(b));
    for (const rel of others) {
      const oAbs = join(snapshotRootPath, ...rel.split("/"));
      const oRaw = await readFile(oAbs, "utf8");
      const oCan = canonicalizeSourceForSnapshot(oRaw);
      const { nextSource, report: r } = renameInSource(oCan, rel, oldName, newName, snapshot);
      mergedReport = mergeReports(mergedReport, r);
      if (nextSource !== oCan) {
        outMap.set(rel, nextSource);
      }
    }
  }

  // Validate all edits parse cleanly.
  for (const [, text] of outMap) {
    const t = parsePythonSource(text);
    if (t.rootNode.hasError) {
      return { ok: false, message: "parse_error after rename_symbol", code: "parse_error" };
    }
  }

  for (const [p, text] of outMap) {
    const wAbs = join(snapshotRootPath, ...p.split("/"));
    await writeFile(wAbs, text, "utf8");
  }

  const nextSnapshot = await materializeSnapshot({
    rootPath: snapshotRootPath,
    inline_threshold_bytes: input.materialize?.inline_threshold_bytes,
    previousSnapshot: input.materialize?.previousSnapshot,
  });

  return {
    ok: true,
    nextSnapshot,
    id_resolve_delta: {},
    rename_surface_report: mergedReport,
  };
}
