import { createHash } from "node:crypto";

import Parser from "tree-sitter";

/** Object accepted by `Parser#setLanguage` (e.g. default export from tree-sitter-typescript). */
export type TreeSitterLanguage = Parameters<InstanceType<typeof Parser>["setLanguage"]>[0];

/**
 * Tree-sitter parse failed or root has errors — `export_surface_delta` should be `"unknown"`.
 */
export class ExportSurfaceError extends Error {
  override readonly name = "ExportSurfaceError";
  constructor(message = "export surface extraction failed") {
    super(message);
  }
}

function hasFromClause(st: Parser.SyntaxNode): boolean {
  for (let i = 0; i < st.childCount; i++) {
    const ch = st.child(i)!;
    if (ch.type === "from") {
      return true;
    }
  }
  return false;
}

function pushExportSpecifierNames(spec: Parser.SyntaxNode, source: string, out: string[]): void {
  const ids = spec.namedChildren.filter((n) => n.type === "identifier" || n.type === "type_identifier");
  if (ids.length === 0) {
    return;
  }
  const exported = ids[ids.length - 1]!;
  out.push(source.slice(exported.startIndex, exported.endIndex));
}

function declarationName(decl: Parser.SyntaxNode, source: string): string | null {
  switch (decl.type) {
    case "function_declaration":
    case "function_signature": {
      const id = decl.namedChildren.find((n) => n.type === "identifier" || n.type === "type_identifier");
      return id ? source.slice(id.startIndex, id.endIndex) : null;
    }
    case "class_declaration": {
      const id = decl.namedChildren.find((n) => n.type === "identifier" || n.type === "type_identifier");
      return id ? source.slice(id.startIndex, id.endIndex) : null;
    }
    case "lexical_declaration": {
      const first = decl.namedChildren.find((n) => n.type === "variable_declarator");
      if (!first) {
        return null;
      }
      const name = first.namedChildren.find((n) => n.type === "identifier" || n.type === "type_identifier");
      return name ? source.slice(name.startIndex, name.endIndex) : null;
    }
    case "enum_declaration": {
      const id = decl.namedChildren.find((n) => n.type === "identifier");
      return id ? source.slice(id.startIndex, id.endIndex) : null;
    }
    case "internal_module": {
      const id = decl.namedChildren.find((n) => n.type === "identifier");
      return id ? source.slice(id.startIndex, id.endIndex) : null;
    }
    default:
      return null;
  }
}

/**
 * Collect exported **value** declaration names from top-level `export_statement` nodes
 * (best-effort syntactic surface; see `docs/impl/v0-decisions.md` — Ghost-bytes).
 */
export function collectExportedDeclarationNames(root: Parser.SyntaxNode, source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const st = root.namedChild(i)!;
    if (st.type !== "export_statement") {
      continue;
    }
    if (hasFromClause(st)) {
      continue;
    }
    const clause = st.namedChildren.find((n) => n.type === "export_clause");
    if (clause) {
      for (let j = 0; j < clause.namedChildCount; j++) {
        const sp = clause.namedChild(j)!;
        if (sp.type === "export_specifier") {
          pushExportSpecifierNames(sp, source, out);
        }
      }
      continue;
    }
    for (let j = 0; j < st.namedChildCount; j++) {
      const decl = st.namedChild(j)!;
      if (decl.type === "type_alias_declaration" || decl.type === "interface_declaration") {
        continue;
      }
      if (decl.type === "export_clause") {
        continue;
      }
      const n = declarationName(decl, source);
      if (n !== null) {
        out.push(n);
      }
    }
  }
  return out;
}

/**
 * Deterministic SHA-256 (hex) digest of the module’s exported **value** declaration names,
 * derived from the Tree-sitter parse tree (no `tsc`; see v0-decisions.md).
 */
export function computeExportSurface(sourceText: string, grammar: TreeSitterLanguage): string {
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(sourceText);
  if (tree.rootNode.hasError) {
    throw new ExportSurfaceError("parse has errors");
  }
  const names = collectExportedDeclarationNames(tree.rootNode, sourceText);
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const payload = unique.join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Compare pre/post canonical LF sources; any parse failure → `"unknown"`. */
export function exportSurfaceDelta(
  preCanonical: string,
  postCanonical: string,
  grammar: TreeSitterLanguage,
): "unchanged" | "changed" | "unknown" {
  try {
    const a = computeExportSurface(preCanonical, grammar);
    const b = computeExportSurface(postCanonical, grammar);
    return a === b ? "unchanged" : "changed";
  } catch {
    return "unknown";
  }
}
