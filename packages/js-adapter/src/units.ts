/**
 * Tier I logical units for JavaScript (v1).
 *
 * Extracts top-level `function_declaration`, `class_declaration` (with `method_definition`
 * children), and top-level `const`/`let`/`var` declarators whose initializer is an
 * `arrow_function`. See `docs/impl/v0-decisions.md` — JavaScript adapter (js-adapter, v1).
 */

import { createHash } from "node:crypto";
import type Parser from "tree-sitter";

import { parseJavaScriptSource } from "./parser.js";
import type { ExtractedUnitSpan, JsUnitKind } from "./types.js";

function sha256Hex(utf8: string): string {
  return createHash("sha256").update(utf8, "utf8").digest("hex");
}

export function computeUnitId(input: {
  grammarDigest: string;
  snapshotRootResolved: string;
  filePathPosix: string;
  startByte: number;
  endByte: number;
  kind: JsUnitKind;
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

function pushUnit(
  acc: ExtractedUnitSpan[],
  input: {
    grammarDigest: string;
    snapshotRootResolved: string;
    filePathPosix: string;
    node: Parser.SyntaxNode;
    kind: JsUnitKind;
  },
): void {
  const { node, kind, grammarDigest, snapshotRootResolved, filePathPosix } = input;
  acc.push({
    id: computeUnitId({
      grammarDigest,
      snapshotRootResolved,
      filePathPosix,
      startByte: node.startIndex,
      endByte: node.endIndex,
      kind,
    }),
    file_path: filePathPosix,
    start_byte: node.startIndex,
    end_byte: node.endIndex,
    kind,
  });
}

function collectClassMethods(
  classNode: Parser.SyntaxNode,
  grammarDigest: string,
  snapshotRootResolved: string,
  filePathPosix: string,
  acc: ExtractedUnitSpan[],
): void {
  let body: Parser.SyntaxNode | null = null;
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const c = classNode.namedChild(i);
    if (c?.type === "class_body") {
      body = c;
      break;
    }
  }
  if (!body) return;

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type === "method_definition") {
      pushUnit(acc, {
        grammarDigest,
        snapshotRootResolved,
        filePathPosix,
        node: child,
        kind: "method_definition",
      });
    }
  }
}

/**
 * Top-level `lexical_declaration` / `variable_declaration`: emit `variable_declarator`
 * units when `value` is an `arrow_function`.
 */
function collectTopLevelArrowDeclarators(
  decl: Parser.SyntaxNode,
  grammarDigest: string,
  snapshotRootResolved: string,
  filePathPosix: string,
  acc: ExtractedUnitSpan[],
): void {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const child = decl.namedChild(i);
    if (!child || child.type !== "variable_declarator") continue;
    const init = child.childForFieldName("value");
    if (init?.type === "arrow_function") {
      pushUnit(acc, {
        grammarDigest,
        snapshotRootResolved,
        filePathPosix,
        node: child,
        kind: "arrow_function",
      });
    }
  }
}

/** Handle `export_statement` or raw program-level declaration nodes. */
function collectFromStatementLike(
  node: Parser.SyntaxNode,
  grammarDigest: string,
  snapshotRootResolved: string,
  filePathPosix: string,
  acc: ExtractedUnitSpan[],
): void {
  if (node.type === "export_statement") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (!c) continue;
      if (
        c.type === "function_declaration" ||
        c.type === "class_declaration" ||
        c.type === "lexical_declaration" ||
        c.type === "variable_declaration"
      ) {
        collectFromStatementLike(c, grammarDigest, snapshotRootResolved, filePathPosix, acc);
      }
    }
    return;
  }

  if (node.type === "function_declaration") {
    pushUnit(acc, { grammarDigest, snapshotRootResolved, filePathPosix, node, kind: "function_declaration" });
    return;
  }

  if (node.type === "class_declaration") {
    pushUnit(acc, { grammarDigest, snapshotRootResolved, filePathPosix, node, kind: "class_declaration" });
    collectClassMethods(node, grammarDigest, snapshotRootResolved, filePathPosix, acc);
    return;
  }

  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    collectTopLevelArrowDeclarators(node, grammarDigest, snapshotRootResolved, filePathPosix, acc);
  }
}

export function extractJsLogicalUnits(
  tree: Parser.Tree,
  input: {
    grammarDigest: string;
    snapshotRootResolved: string;
    filePathPosix: string;
  },
): ExtractedUnitSpan[] {
  const acc: ExtractedUnitSpan[] = [];
  const root = tree.rootNode;
  if (root.type !== "program") {
    acc.sort((a, b) => a.start_byte - b.start_byte);
    return acc;
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;
    collectFromStatementLike(stmt, input.grammarDigest, input.snapshotRootResolved, input.filePathPosix, acc);
  }

  acc.sort((a, b) => a.start_byte - b.start_byte);
  return acc;
}

/** Public alias — same export name as py-adapter for drop-in surface. */
export const extractLogicalUnits = extractJsLogicalUnits;

/** Declared symbol name from a logical unit's canonical source slice. */
export function declaredNameFromUnitSource(source: string): string | null {
  const tree = parseJavaScriptSource(source);
  return firstJsDeclaredName(tree.rootNode, source.length);
}

function firstJsDeclaredName(node: Parser.SyntaxNode, maxByte: number): string | null {
  if (node.endIndex > maxByte) {
    // Defensive: span parse should align; avoid reading past slice.
  }
  if (node.type === "function_declaration") {
    const n = node.childForFieldName("name");
    if (n?.type === "identifier") return n.text;
  }
  if (node.type === "class_declaration") {
    const n = node.childForFieldName("name");
    if (n?.type === "identifier") return n.text;
  }
  if (node.type === "method_definition") {
    const n = node.childForFieldName("name");
    if (n?.type === "property_identifier") return n.text;
  }
  if (node.type === "variable_declarator") {
    const n = node.childForFieldName("name");
    if (n?.type === "identifier") return n.text;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) {
      const s = firstJsDeclaredName(c, maxByte);
      if (s) return s;
    }
  }
  return null;
}
