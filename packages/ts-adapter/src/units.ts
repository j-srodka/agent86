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
 * v0 extracts **function_declaration**, **method_definition**, and top-level **class_declaration**
 * nodes (any **class_declaration** in the tree; see v0-decisions — Tier I scope).
 */

import { createHash } from "node:crypto";
import type Parser from "tree-sitter";

import { parseTypeScriptSource } from "./parser.js";
import type { ExtractedUnitSpan } from "./types.js";

const UNIT_NODE_TYPES = ["function_declaration", "method_definition", "class_declaration"] as const;
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
): ExtractedUnitSpan[] {
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
    } satisfies ExtractedUnitSpan;
  });
}

/**
 * Tree-sitter `method_definition` names live on `property_identifier` /
 * `shorthand_property_identifier` (not always exposed via childForFieldName("name")).
 */
function methodDefinitionDeclaredName(node: Parser.SyntaxNode): string | null {
  if (node.type !== "method_definition") return null;
  const byField = node.childForFieldName("name");
  if (
    byField &&
    (byField.type === "property_identifier" ||
      byField.type === "shorthand_property_identifier" ||
      byField.type === "identifier")
  ) {
    return byField.text;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "property_identifier" || c.type === "shorthand_property_identifier") {
      return c.text;
    }
  }
  return null;
}

function firstFunctionLikeName(node: Parser.SyntaxNode): string | null {
  if (node.type === "method_definition") {
    const direct = methodDefinitionDeclaredName(node);
    if (direct !== null) return direct;
    return null;
  }
  if (node.type === "function_declaration" || node.type === "class_declaration") {
    const n = node.childForFieldName("name");
    if (n) {
      return n.text;
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) {
      const s = firstFunctionLikeName(c);
      if (s) {
        return s;
      }
    }
  }
  return null;
}

/** Declared identifier of the first function-like unit in a canonical unit span string. */
export function declaredNameFromUnitSource(source: string): string | null {
  const tree = parseTypeScriptSource(source);
  return firstFunctionLikeName(tree.rootNode);
}

/**
 * Declared name for a Tier I tree-sitter node (`function_declaration`, `method_definition`,
 * `class_declaration`). Prefer this when the node comes from a **full-file** parse; isolated
 * method spans do not re-parse as `method_definition`.
 */
export function declaredNameFromTierOneNode(node: Parser.SyntaxNode): string | null {
  if (node.type === "method_definition") {
    return methodDefinitionDeclaredName(node);
  }
  if (node.type === "function_declaration" || node.type === "class_declaration") {
    const n = node.childForFieldName("name");
    return n ? n.text : null;
  }
  return null;
}
