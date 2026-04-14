/**
 * Tier I logical units for Python (v1).
 *
 * Extracts `function_definition` (top-level and class methods, including async def)
 * and `class_definition` (top-level only). Inner functions/closures are not Tier I units.
 *
 * See `docs/impl/v0-decisions.md` — Python adapter (v2).
 */

import { createHash } from "node:crypto";
import type Parser from "tree-sitter";

import { parsePythonSource } from "./parser.js";
import type { ExtractedUnitSpan, PyUnitKind } from "./types.js";

function sha256Hex(utf8: string): string {
  return createHash("sha256").update(utf8, "utf8").digest("hex");
}

export function computeUnitId(input: {
  grammarDigest: string;
  snapshotRootResolved: string;
  filePathPosix: string;
  startByte: number;
  endByte: number;
  kind: PyUnitKind;
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

/** Walk top-level children of `module` node to find units at depth 0 and class methods. */
function collectPythonUnits(
  rootNode: Parser.SyntaxNode,
  grammarDigest: string,
  snapshotRootResolved: string,
  filePathPosix: string,
  acc: ExtractedUnitSpan[],
): void {
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const node = rootNode.namedChild(i);
    if (!node) continue;

    if (node.type === "function_definition") {
      acc.push({
        id: computeUnitId({
          grammarDigest,
          snapshotRootResolved,
          filePathPosix,
          startByte: node.startIndex,
          endByte: node.endIndex,
          kind: "function_definition",
        }),
        file_path: filePathPosix,
        start_byte: node.startIndex,
        end_byte: node.endIndex,
        kind: "function_definition",
      });
    } else if (node.type === "class_definition") {
      // Emit the class itself as a Tier I unit.
      acc.push({
        id: computeUnitId({
          grammarDigest,
          snapshotRootResolved,
          filePathPosix,
          startByte: node.startIndex,
          endByte: node.endIndex,
          kind: "class_definition",
        }),
        file_path: filePathPosix,
        start_byte: node.startIndex,
        end_byte: node.endIndex,
        kind: "class_definition",
      });
      // Emit methods inside the class body as additional units.
      collectClassMethods(node, grammarDigest, snapshotRootResolved, filePathPosix, acc);
    }
    // Decorated definitions: decorated_definition wraps function/class in tree-sitter-python.
    // Unwrap and treat the inner node as the unit.
    else if (node.type === "decorated_definition") {
      const inner = lastNamedChildOfType(node, ["function_definition", "class_definition"]);
      if (inner) {
        const kind: PyUnitKind =
          inner.type === "class_definition" ? "class_definition" : "function_definition";
        acc.push({
          id: computeUnitId({
            grammarDigest,
            snapshotRootResolved,
            filePathPosix,
            startByte: node.startIndex, // span includes decorators
            endByte: node.endIndex,
            kind,
          }),
          file_path: filePathPosix,
          start_byte: node.startIndex,
          end_byte: node.endIndex,
          kind,
        });
        if (inner.type === "class_definition") {
          collectClassMethods(inner, grammarDigest, snapshotRootResolved, filePathPosix, acc);
        }
      }
    }
    // if_statement / try blocks at module level might contain top-level defs — skip for v1.
  }
}

function lastNamedChildOfType(
  node: Parser.SyntaxNode,
  types: string[],
): Parser.SyntaxNode | null {
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

/**
 * Collect `function_definition` (and `decorated_definition` wrapping them) as methods
 * from the direct `block` child of a `class_definition` node.
 */
function collectClassMethods(
  classNode: Parser.SyntaxNode,
  grammarDigest: string,
  snapshotRootResolved: string,
  filePathPosix: string,
  acc: ExtractedUnitSpan[],
): void {
  // Find the `block` child (class body).
  let block: Parser.SyntaxNode | null = null;
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const c = classNode.namedChild(i);
    if (c?.type === "block") {
      block = c;
      break;
    }
  }
  if (!block) return;

  for (let i = 0; i < block.namedChildCount; i++) {
    const child = block.namedChild(i);
    if (!child) continue;

    if (child.type === "function_definition") {
      acc.push({
        id: computeUnitId({
          grammarDigest,
          snapshotRootResolved,
          filePathPosix,
          startByte: child.startIndex,
          endByte: child.endIndex,
          kind: "function_definition",
        }),
        file_path: filePathPosix,
        start_byte: child.startIndex,
        end_byte: child.endIndex,
        kind: "function_definition",
      });
    } else if (child.type === "decorated_definition") {
      const inner = lastNamedChildOfType(child, ["function_definition"]);
      if (inner) {
        acc.push({
          id: computeUnitId({
            grammarDigest,
            snapshotRootResolved,
            filePathPosix,
            startByte: child.startIndex,
            endByte: child.endIndex,
            kind: "function_definition",
          }),
          file_path: filePathPosix,
          start_byte: child.startIndex,
          end_byte: child.endIndex,
          kind: "function_definition",
        });
      }
    }
  }
}

export function extractLogicalUnits(
  tree: Parser.Tree,
  input: {
    grammarDigest: string;
    snapshotRootResolved: string;
    filePathPosix: string;
  },
): ExtractedUnitSpan[] {
  const acc: ExtractedUnitSpan[] = [];
  collectPythonUnits(
    tree.rootNode,
    input.grammarDigest,
    input.snapshotRootResolved,
    input.filePathPosix,
    acc,
  );
  acc.sort((a, b) => a.start_byte - b.start_byte);
  return acc;
}

/** Extract the declared name from a Python unit's canonical source (first line). */
export function declaredNameFromUnitSource(source: string): string | null {
  const tree = parsePythonSource(source);
  return firstPythonDeclaredName(tree.rootNode);
}

function firstPythonDeclaredName(node: Parser.SyntaxNode): string | null {
  if (node.type === "function_definition" || node.type === "class_definition") {
    const n = node.childForFieldName("name");
    if (n) return n.text;
  }
  if (node.type === "decorated_definition") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && (c.type === "function_definition" || c.type === "class_definition")) {
        const n = c.childForFieldName("name");
        if (n) return n.text;
      }
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) {
      const s = firstPythonDeclaredName(c);
      if (s) return s;
    }
  }
  return null;
}
