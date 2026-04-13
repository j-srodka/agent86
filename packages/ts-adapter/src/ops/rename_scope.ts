import type Parser from "tree-sitter";
import ts from "typescript";

import type { RenameSurfaceSkipped } from "../types.js";

export type SkippedRef = RenameSurfaceSkipped;

export function isStrictlyInside(inner: Parser.SyntaxNode, outer: Parser.SyntaxNode): boolean {
  return inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;
}

export function findEnclosingClassBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur != null) {
    if (cur.type === "class_body") {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

export function isUnderStringOrTemplate(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node;
  while (cur != null) {
    if (cur.type === "string_fragment" || cur.type === "string_literal" || cur.type === "template_string") {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

export function isInTypeOnlyPosition(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node;
  while (cur != null) {
    const t = cur.type;
    if (
      t === "type_annotation" ||
      t === "type_arguments" ||
      t === "type_parameters" ||
      t === "predefined_type" ||
      t === "union_type" ||
      t === "intersection_type" ||
      t === "nested_type_identifier" ||
      t === "lookup_type" ||
      t === "literal_type" ||
      t === "tuple_type" ||
      t === "object_type" ||
      t === "conditional_type" ||
      t === "parenthesized_type" ||
      t === "type_predicate" ||
      t === "type_query"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

export function isObjectLiteralPropertyKey(node: Parser.SyntaxNode): boolean {
  if (node.type !== "property_identifier" && node.type !== "shorthand_property_identifier") {
    return false;
  }
  const p = node.parent;
  if (p == null) {
    return false;
  }
  if (p.type === "pair") {
    const k = p.childForFieldName("key");
    return k === node;
  }
  return false;
}

/**
 * Cross-file best-effort: skip import bindings and `export { name }` — not identifiers inside
 * `export function … { … }` bodies.
 */
export function isCrossFileImportExportBindingSite(node: Parser.SyntaxNode): boolean {
  let cur: Parser.SyntaxNode | null = node;
  while (cur != null) {
    if (cur.type === "import_statement") {
      return true;
    }
    if (cur.type === "export_clause" || cur.type === "named_exports" || cur.type === "namespace_export") {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

export function isMethodDefinitionName(node: Parser.SyntaxNode): boolean {
  if (node.type !== "property_identifier") {
    return false;
  }
  const p = node.parent;
  return p?.type === "method_definition" && p.childForFieldName("name") === node;
}

export function isFunctionDeclarationName(node: Parser.SyntaxNode): boolean {
  if (node.type !== "identifier") {
    return false;
  }
  const p = node.parent;
  return p?.type === "function_declaration" && p.childForFieldName("name") === node;
}

const VIRTUAL = "/virtual/rename_target.ts";

function createSingleFileProgram(source: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const sf = ts.createSourceFile(VIRTUAL, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: false,
  };
  const host = ts.createCompilerHost(options);
  const origGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === VIRTUAL) {
      return sf;
    }
    return origGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const prog = ts.createProgram([VIRTUAL], options, host);
  return { sf, checker: prog.getTypeChecker() };
}

/** Deepest AST node containing `pos` (UTF-8/byte offset for ASCII). */
function findSmallestNodeAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  let best: ts.Node | undefined;
  function visit(n: ts.Node): void {
    const start = n.getStart(sf, false);
    const end = n.getEnd();
    if (pos >= start && pos < end) {
      best = n;
      ts.forEachChild(n, visit);
    }
  }
  visit(sf);
  return best;
}

/**
 * True if TypeScript considers this identifier's value declaration to be `targetMethod`
 * (method_declaration span aligned with Tree-sitter).
 */
export function tsIdentifierRefersToMethod(
  source: string,
  identifierByteStart: number,
  targetMethod: Parser.SyntaxNode,
  oldName: string,
): boolean {
  const nameTs = targetMethod.childForFieldName("name");
  if (!nameTs) {
    return false;
  }
  const { sf, checker } = createSingleFileProgram(source);
  const node = findSmallestNodeAt(sf, identifierByteStart);
  if (!node || !ts.isIdentifier(node) || node.text !== oldName) {
    return false;
  }
  const sym = checker.getSymbolAtLocation(node);
  if (!sym) {
    return false;
  }
  const v = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!v) {
    return false;
  }
  return (
    ts.isMethodDeclaration(v) &&
    v.name != null &&
    v.name.getStart(sf, false) === nameTs.startIndex &&
    v.name.getEnd() === nameTs.endIndex
  );
}

/**
 * True if identifier resolves to the given function_declaration (by Tree-sitter byte span).
 */
export function tsIdentifierRefersToFunction(
  source: string,
  identifierByteStart: number,
  targetFn: Parser.SyntaxNode,
  oldName: string,
): boolean {
  const nameTs = targetFn.childForFieldName("name");
  if (!nameTs) {
    return false;
  }
  const { sf, checker } = createSingleFileProgram(source);
  const node = findSmallestNodeAt(sf, identifierByteStart);
  if (!node || !ts.isIdentifier(node) || node.text !== oldName) {
    return false;
  }
  const sym = checker.getSymbolAtLocation(node);
  if (!sym) {
    return false;
  }
  const v = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!v) {
    return false;
  }
  return (
    ts.isFunctionDeclaration(v) &&
    v.name != null &&
    v.name.getStart(sf, false) === nameTs.startIndex &&
    v.name.getEnd() === nameTs.endIndex
  );
}
