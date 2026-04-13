import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "tree-sitter";

import { materializeSnapshot, canonicalizeSourceForSnapshot, type MaterializeSnapshotOptions } from "../snapshot.js";
import { parseTypeScriptSource } from "../parser.js";
import type { LogicalUnit, RenameSurfaceReport, WorkspaceSnapshot } from "../types.js";
import {
  findEnclosingClassBody,
  isCrossFileImportExportBindingSite,
  isInTypeOnlyPosition,
  isObjectLiteralPropertyKey,
  isUnderStringOrTemplate,
  tsIdentifierRefersToFunction,
  tsIdentifierRefersToMethod,
  type SkippedRef,
} from "./rename_scope.js";

export interface RenameSymbolInput {
  snapshotRootPath: string;
  /** Required for cross-file enumeration and materialization. */
  snapshot: WorkspaceSnapshot;
  unit: LogicalUnit;
  newName: string;
  cross_file?: boolean;
  /** Forwarded to `materializeSnapshot` after the edit (§10 threshold + `id_resolve` merge). */
  materialize?: Pick<MaterializeSnapshotOptions, "inline_threshold_bytes" | "previousSnapshot">;
}

export interface RenameSymbolOk {
  ok: true;
  nextSnapshot: WorkspaceSnapshot;
  /** v0 ids are name-independent; renames do not rewrite `id_resolve` entries. */
  id_resolve_delta: Record<string, string>;
  rename_surface_report: RenameSurfaceReport;
}

export interface RenameSymbolErr {
  ok: false;
  message: string;
  code?: "lang.ts.rename_unsupported_node_kind" | "parse_error";
}

export type RenameSymbolResult = RenameSymbolOk | RenameSymbolErr;

interface Edit {
  start: number;
  end: number;
  text: string;
}

function findNodeWithByteRange(node: Parser.SyntaxNode, start: number, end: number): Parser.SyntaxNode | null {
  if (node.startIndex === start && node.endIndex === end) {
    return node;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    const f = findNodeWithByteRange(c, start, end);
    if (f) {
      return f;
    }
  }
  return null;
}

function collectNameLikeNodes(node: Parser.SyntaxNode, acc: Parser.SyntaxNode[]): void {
  if (node.type === "identifier" || node.type === "property_identifier") {
    acc.push(node);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    collectNameLikeNodes(node.namedChild(i)!, acc);
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

function finalizeReport(found: number, rewritten: number, skipped: SkippedRef[]): RenameSurfaceReport {
  return {
    found,
    rewritten,
    skipped,
  };
}

function sameFileFunctionRename(
  canonical: string,
  decl: Parser.SyntaxNode,
  unit: LogicalUnit,
  newName: string,
): { ok: true; nextSource: string; report: RenameSurfaceReport } | { ok: false; message: string } {
  const nameNode = decl.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") {
    return { ok: false, message: "function_declaration has no name identifier" };
  }
  const oldName = nameNode.text;
  const edits: Edit[] = [];
  const skipped: SkippedRef[] = [];
  let found = 0;
  let rewritten = 0;

  const nodes: Parser.SyntaxNode[] = [];
  collectNameLikeNodes(decl.tree.rootNode, nodes);

  for (const n of nodes) {
    if (n.text !== oldName) {
      continue;
    }
    if (n.type === "property_identifier") {
      found++;
      skipped.push({
        unit_id: unit.id,
        reason: "skip:property_member_access_function_target",
        file: unit.file_path,
      });
      continue;
    }
    if (n.type !== "identifier") {
      continue;
    }
    found++;
    if (isUnderStringOrTemplate(n) || isInTypeOnlyPosition(n)) {
      skipped.push({
        unit_id: unit.id,
        reason: isUnderStringOrTemplate(n) ? "skip:string_or_template_context" : "skip:type_position",
        file: unit.file_path,
      });
      continue;
    }
    if (tsIdentifierRefersToFunction(canonical, n.startIndex, decl, oldName)) {
      edits.push({ start: n.startIndex, end: n.endIndex, text: newName });
      rewritten++;
      continue;
    }
    skipped.push({
      unit_id: unit.id,
      reason: "skip:lexical_binding_not_target",
      file: unit.file_path,
    });
  }

  if (edits.length === 0) {
    return { ok: false, message: "no identifier occurrences to rename" };
  }

  const nextSource = applyEditsDescending(canonical, edits);
  return {
    ok: true,
    nextSource,
    report: finalizeReport(found, rewritten, skipped),
  };
}

function sameFileMethodRename(
  canonical: string,
  decl: Parser.SyntaxNode,
  unit: LogicalUnit,
  newName: string,
): { ok: true; nextSource: string; report: RenameSurfaceReport } | { ok: false; message: string } {
  const nameNode = decl.childForFieldName("name");
  if (!nameNode || nameNode.type !== "property_identifier") {
    return { ok: false, message: "method_definition has no property_identifier name" };
  }
  const oldName = nameNode.text;
  const classBody = findEnclosingClassBody(decl);
  if (!classBody) {
    return { ok: false, message: "method_definition not inside a class_body" };
  }

  const edits: Edit[] = [];
  const skipped: SkippedRef[] = [];
  let found = 0;
  let rewritten = 0;

  const nodes: Parser.SyntaxNode[] = [];
  collectNameLikeNodes(classBody, nodes);

  for (const n of nodes) {
    if (n.text !== oldName) {
      continue;
    }

    found++;
    if (isUnderStringOrTemplate(n) || isInTypeOnlyPosition(n)) {
      skipped.push({
        unit_id: unit.id,
        reason: isUnderStringOrTemplate(n) ? "skip:string_or_template_context" : "skip:type_position",
        file: unit.file_path,
      });
      continue;
    }
    if (isObjectLiteralPropertyKey(n)) {
      skipped.push({
        unit_id: unit.id,
        reason: "skip:object_literal_key",
        file: unit.file_path,
      });
      continue;
    }

    if (tsIdentifierRefersToMethod(canonical, n.startIndex, decl, oldName)) {
      edits.push({ start: n.startIndex, end: n.endIndex, text: newName });
      rewritten++;
      continue;
    }
    skipped.push({
      unit_id: unit.id,
      reason: "skip:not_target_method_binding",
      file: unit.file_path,
    });
  }

  if (edits.length === 0) {
    return { ok: false, message: "no identifier occurrences to rename" };
  }

  const nextSource = applyEditsDescending(canonical, edits);
  return {
    ok: true,
    nextSource,
    report: finalizeReport(found, rewritten, skipped),
  };
}

function crossFileIdentifierRewrite(
  canonical: string,
  filePath: string,
  oldName: string,
  newName: string,
  unitId: string,
): { nextSource: string; report: RenameSurfaceReport } {
  const tree = parseTypeScriptSource(canonical);
  const edits: Edit[] = [];
  const skipped: SkippedRef[] = [];
  let found = 0;
  let rewritten = 0;

  const nodes: Parser.SyntaxNode[] = [];
  collectNameLikeNodes(tree.rootNode, nodes);

  for (const n of nodes) {
    if (n.type !== "identifier" || n.text !== oldName) {
      continue;
    }
    found++;
    if (isUnderStringOrTemplate(n) || isInTypeOnlyPosition(n)) {
      skipped.push({
        unit_id: unitId,
        reason: isUnderStringOrTemplate(n) ? "skip:string_or_template_context" : "skip:type_position",
        file: filePath,
      });
      continue;
    }
    if (isCrossFileImportExportBindingSite(n)) {
      skipped.push({
        unit_id: unitId,
        reason: "skip:import_or_export_specifier",
        file: filePath,
      });
      continue;
    }
    edits.push({ start: n.startIndex, end: n.endIndex, text: newName });
    rewritten++;
  }

  const nextSource = edits.length > 0 ? applyEditsDescending(canonical, edits) : canonical;
  return { nextSource, report: finalizeReport(found, rewritten, skipped) };
}

function mergeReports(a: RenameSurfaceReport, b: RenameSurfaceReport): RenameSurfaceReport {
  return {
    found: a.found + b.found,
    rewritten: a.rewritten + b.rewritten,
    skipped: [...a.skipped, ...b.skipped],
  };
}

/**
 * `rename_symbol`: same-file scoped rename for `function_declaration` or `method_definition`,
 * optional best-effort cross-file `identifier` rewrite. See `docs/impl/v0-decisions.md`.
 */
export async function applyRenameSymbol(input: RenameSymbolInput): Promise<RenameSymbolResult> {
  const { unit, newName, snapshotRootPath, snapshot } = input;
  const crossFile = input.cross_file === true;

  if (unit.kind !== "function_declaration" && unit.kind !== "method_definition") {
    return {
      ok: false,
      message: "rename_symbol supports function_declaration and method_definition only",
      code: "lang.ts.rename_unsupported_node_kind",
    };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) {
    return { ok: false, message: "invalid new_name identifier" };
  }

  const abs = join(snapshotRootPath, ...unit.file_path.split("/"));
  const raw = await readFile(abs, "utf8");
  const canonical = canonicalizeSourceForSnapshot(raw);
  const tree = parseTypeScriptSource(canonical);
  const decl = findNodeWithByteRange(tree.rootNode, unit.start_byte, unit.end_byte);
  if (!decl || decl.type !== unit.kind) {
    return { ok: false, message: `could not locate ${unit.kind} for unit span` };
  }
  const nameNode = decl.childForFieldName("name");
  if (!nameNode) {
    return { ok: false, message: "declaration has no name" };
  }
  const oldName = nameNode.text;
  if (oldName === newName) {
    return { ok: false, message: "old and new name identical" };
  }

  let same: { ok: true; nextSource: string; report: RenameSurfaceReport } | { ok: false; message: string };
  if (unit.kind === "function_declaration") {
    same = sameFileFunctionRename(canonical, decl, unit, newName);
  } else {
    same = sameFileMethodRename(canonical, decl, unit, newName);
  }
  if (!same.ok) {
    return { ok: false, message: same.message };
  }

  let mergedReport = same.report;
  const outMap = new Map<string, string>();
  outMap.set(unit.file_path, same.nextSource);

  if (crossFile) {
    const others = snapshot.files
      .map((f) => f.path)
      .filter((p) => p !== unit.file_path)
      .sort((a, b) => a.localeCompare(b));

    for (const rel of others) {
      const oAbs = join(snapshotRootPath, ...rel.split("/"));
      const oRaw = await readFile(oAbs, "utf8");
      const oCan = canonicalizeSourceForSnapshot(oRaw);
      const { nextSource, report: r } = crossFileIdentifierRewrite(oCan, rel, oldName, newName, unit.id);
      mergedReport = mergeReports(mergedReport, r);
      if (nextSource !== oCan) {
        outMap.set(rel, nextSource);
      }
    }
  }

  const paths = [...outMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const p of paths) {
    const text = outMap.get(p)!;
    const t = parseTypeScriptSource(text);
    if (t.rootNode.hasError) {
      return { ok: false, message: "parse_error after rename_symbol" };
    }
  }

  for (const p of paths) {
    const text = outMap.get(p)!;
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
