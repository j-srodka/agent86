/**
 * Tier I logical units — normative semantics for implementers (v0)
 *
 * - Unit **ids** are stable **only within a single materialized `WorkspaceSnapshot`**
 *   (spec section 4). They are not portable across snapshots as stable handles.
 *
 * - After **`replace_unit`** (or any edit) and **re-snapshot**, the **edited** unit’s
 *   id **MUST change** (byte ranges / AST spans shift in canonical source).
 *
 * - **Untouched** units **above** the edit in the same file **retain** the same ids.
 *   Units **at or below** the edit **do not** retain ids (offsets shifted)—conformance
 *   asserts this (Task 8).
 *
 * v0 extracts **function_declaration** and **method_definition** nodes only.
 */

import { createHash } from "node:crypto";
import type Parser from "tree-sitter";

import type { LogicalUnit } from "./types.js";

const UNIT_NODE_TYPES = ["function_declaration", "method_definition"] as const;
type UnitNodeType = (typeof UNIT_NODE_TYPES)[number];

function isUnitNodeType(t: string): t is UnitNodeType {
  return (UNIT_NODE_TYPES as readonly string[]).includes(t);
}

function collectUnitNodes(node: Parser.SyntaxNode, acc: Parser.SyntaxNode[]): void {
  if (isUnitNodeType(node.type)) {
    acc.push(node);
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) collectUnitNodes(c, acc);
  }
}

/** Byte offsets are Tree-sitter indices over the canonical LF source string. */
export function computeUnitId(input: {
  grammarDigest: string;
  snapshotRootResolved: string;
  filePathPosix: string;
  startByte: number;
  endByte: number;
  kind: UnitNodeType;
}): string {
  const line = [
    input.grammarDigest,
    input.snapshotRootResolved,
    input.filePathPosix,
    String(input.startByte),
    String(input.endByte),
    input.kind,
  ].join("|");
  return createHash("sha256").update(line, "utf8").digest("hex");
}

export function extractLogicalUnits(
  tree: Parser.Tree,
  input: {
    grammarDigest: string;
    snapshotRootResolved: string;
    filePathPosix: string;
  },
): LogicalUnit[] {
  const nodes: Parser.SyntaxNode[] = [];
  collectUnitNodes(tree.rootNode, nodes);
  nodes.sort((a, b) => a.startIndex - b.startIndex);
  return nodes.map((n) => {
    const kind = n.type as UnitNodeType;
    const id = computeUnitId({
      grammarDigest: input.grammarDigest,
      snapshotRootResolved: input.snapshotRootResolved,
      filePathPosix: input.filePathPosix,
      startByte: n.startIndex,
      endByte: n.endIndex,
      kind,
    });
    return {
      id,
      file_path: input.filePathPosix,
      start_byte: n.startIndex,
      end_byte: n.endIndex,
      kind,
    };
  });
}
