import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "tree-sitter";

import { materializeSnapshot, canonicalizeSourceForSnapshot, type MaterializeSnapshotOptions } from "../snapshot.js";
import { parseTypeScriptSource } from "../parser.js";
import type { LogicalUnit, WorkspaceSnapshot } from "../types.js";

export interface RenameSymbolInput {
  snapshotRootPath: string;
  unit: LogicalUnit;
  newName: string;
  /** Forwarded to `materializeSnapshot` after the edit (§10 threshold + `id_resolve` merge). */
  materialize?: Pick<MaterializeSnapshotOptions, "inline_threshold_bytes" | "previousSnapshot">;
}

export interface RenameSymbolOk {
  ok: true;
  nextSnapshot: WorkspaceSnapshot;
  /** v0 ids are name-independent; renames do not rewrite `id_resolve` entries. */
  id_resolve_delta: Record<string, string>;
}

export interface RenameSymbolErr {
  ok: false;
  message: string;
}

export type RenameSymbolResult = RenameSymbolOk | RenameSymbolErr;

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

function collectIdentifierReplacements(
  node: Parser.SyntaxNode,
  oldName: string,
  newName: string,
  edits: Array<{ start: number; end: number; text: string }>,
): void {
  if (node.type === "identifier" && node.text === oldName) {
    edits.push({ start: node.startIndex, end: node.endIndex, text: newName });
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    collectIdentifierReplacements(node.namedChild(i)!, oldName, newName, edits);
  }
}

/**
 * Same-file rename of a **function_declaration** name: replace declaration identifier
 * and every `identifier` subtree node with text `oldName` under that declaration
 * (v0 bounded scope — see `docs/impl/v0-decisions.md`).
 */
export async function applyRenameSymbol(input: RenameSymbolInput): Promise<RenameSymbolResult> {
  const { unit, newName, snapshotRootPath } = input;
  if (unit.kind !== "function_declaration") {
    return { ok: false, message: "rename_symbol v0 supports function_declaration only" };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) {
    return { ok: false, message: "invalid new_name identifier" };
  }

  const abs = join(snapshotRootPath, ...unit.file_path.split("/"));
  const raw = await readFile(abs, "utf8");
  const canonical = canonicalizeSourceForSnapshot(raw);
  const tree = parseTypeScriptSource(canonical);
  const decl = findNodeWithByteRange(tree.rootNode, unit.start_byte, unit.end_byte);
  if (!decl || decl.type !== "function_declaration") {
    return { ok: false, message: "could not locate function_declaration for unit span" };
  }
  const nameNode = decl.childForFieldName("name");
  if (!nameNode || nameNode.type !== "identifier") {
    return { ok: false, message: "function_declaration has no name identifier" };
  }
  const oldName = nameNode.text;
  if (oldName === newName) {
    return { ok: false, message: "old and new name identical" };
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];
  collectIdentifierReplacements(decl, oldName, newName, edits);
  if (edits.length === 0) {
    return { ok: false, message: "no identifier occurrences to rename" };
  }
  edits.sort((a, b) => b.start - a.start);
  let next = canonical;
  for (const e of edits) {
    next = next.slice(0, e.start) + e.text + next.slice(e.end);
  }

  const nextTree = parseTypeScriptSource(next);
  if (nextTree.rootNode.hasError) {
    return { ok: false, message: "parse_error after rename_symbol" };
  }

  await writeFile(abs, next, "utf8");
  const nextSnapshot = await materializeSnapshot({
    rootPath: snapshotRootPath,
    inline_threshold_bytes: input.materialize?.inline_threshold_bytes,
    previousSnapshot: input.materialize?.previousSnapshot,
  });

  return {
    ok: true,
    nextSnapshot,
    id_resolve_delta: {},
  };
}
