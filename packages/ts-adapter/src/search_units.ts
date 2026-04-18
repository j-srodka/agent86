/**
 * Structured unit search (read path). See `docs/impl/v0-decisions.md` — Agent86 SDK (v3).
 * v1: linear scan over `snapshot.units` for `.ts` Tier I spans; same-adapter routing only.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Parser from "tree-sitter";

import { fetchBlobText } from "./blobs.js";
import { parseTypeScriptSource } from "./parser.js";
import type { LogicalUnit, WorkspaceSnapshot } from "./types.js";
import { declaredNameFromUnitSource } from "./units.js";

export type SearchCriteriaKind = "function" | "method" | "class" | "reference" | "import";

/** AND-composed criteria (normative wire shape; see v0-decisions.md). */
export interface SearchCriteria {
  kind: SearchCriteriaKind;
  name?: string;
  enclosing_class?: string;
  path_prefix?: string;
  imported_from?: string;
  tags?: string[];
}

export interface UnitRef {
  id: string;
  file_path: string;
  kind: SearchCriteriaKind;
  name?: string;
  enclosing_class?: string;
  imported_from?: string;
  tags?: string[];
}

export interface SearchCapabilityWarning {
  code: string;
  severity: "warning";
  message: string;
  evidence?: Record<string, unknown>;
}

export interface SearchUnitsResult {
  unit_refs: UnitRef[];
  capability_warnings?: SearchCapabilityWarning[];
}

function warn(
  warnings: SearchCapabilityWarning[],
  code: string,
  message: string,
  evidence?: Record<string, unknown>,
): void {
  warnings.push({ code, severity: "warning", message, ...(evidence !== undefined ? { evidence } : {}) });
}

async function unitText(unit: LogicalUnit, snapshotRootPath?: string): Promise<string | null> {
  if (unit.source_text !== null) return unit.source_text;
  if (unit.blob_ref !== null && snapshotRootPath !== undefined) {
    try {
      return await fetchBlobText(unit.blob_ref, snapshotRootPath);
    } catch {
      return null;
    }
  }
  return null;
}

type TsTree = ReturnType<typeof parseTypeScriptSource>;

function methodDefinitionNodeAt(tree: TsTree, startByte: number): Parser.SyntaxNode | null {
  function walk(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (n.type === "method_definition" && n.startIndex === startByte) return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return null;
  }
  return walk(tree.rootNode);
}

function enclosingClassNameForMethod(tree: TsTree, methodStartByte: number): string | null {
  const node = methodDefinitionNodeAt(tree, methodStartByte);
  if (!node) return null;
  let p: Parser.SyntaxNode | null = node.parent;
  while (p) {
    if (p.type === "class_declaration") {
      const name = p.childForFieldName("name");
      if (name?.type === "identifier") return name.text;
      return null;
    }
    p = p.parent;
  }
  return null;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function logicalKindForTsUnit(unit: LogicalUnit): "function" | "method" | null {
  if (unit.kind === "function_declaration") return "function";
  if (unit.kind === "method_definition") return "method";
  return null;
}

/**
 * Search Tier I units in a ts-adapter `WorkspaceSnapshot` slice (typically `.ts` files only).
 */
export async function searchUnits(
  snapshot: WorkspaceSnapshot,
  criteria: SearchCriteria,
  snapshotRootPath?: string,
): Promise<SearchUnitsResult> {
  const capability_warnings: SearchCapabilityWarning[] = [];

  if (criteria.tags !== undefined && criteria.tags.length > 0) {
    warn(
      capability_warnings,
      "lang.agent86.search_tags_unsupported",
      "tags filter is not implemented for ts-adapter v1 search_units; tags were ignored.",
      { tags: criteria.tags },
    );
  }
  if (criteria.imported_from !== undefined && criteria.imported_from !== "") {
    warn(
      capability_warnings,
      "lang.agent86.search_imported_from_unsupported",
      "imported_from is not implemented for ts-adapter v1 search_units; predicate ignored.",
      { imported_from: criteria.imported_from },
    );
  }

  if (criteria.kind === "reference" || criteria.kind === "import") {
    warn(
      capability_warnings,
      criteria.kind === "reference"
        ? "lang.agent86.search_kind_reference_unsupported"
        : "lang.agent86.search_kind_import_unsupported",
      `kind "${criteria.kind}" is not implemented for ts-adapter v1 search_units.`,
      { kind: criteria.kind },
    );
    return { unit_refs: [], capability_warnings };
  }

  if (criteria.kind === "class") {
    warn(
      capability_warnings,
      "lang.agent86.search_kind_class_unavailable_ts",
      "ts-adapter v1 Tier I snapshots do not include class_declaration units; class search returns no ts matches.",
    );
    return { unit_refs: [], capability_warnings };
  }

  const pathPrefix = criteria.path_prefix !== undefined && criteria.path_prefix !== "" ? toPosix(criteria.path_prefix) : null;

  if (criteria.enclosing_class !== undefined && snapshotRootPath === undefined) {
    warn(
      capability_warnings,
      "lang.agent86.search_snapshot_root_required",
      "enclosing_class filter requires snapshot_root_path so the adapter can parse full .ts files for class context.",
    );
  }

  const fileTrees = new Map<string, TsTree>();
  async function treeForFile(filePath: string): Promise<TsTree | null> {
    if (!snapshotRootPath) return null;
    const hit = fileTrees.get(filePath);
    if (hit) return hit;
    try {
      const abs = join(snapshotRootPath, filePath);
      const src = await readFile(abs, "utf8");
      const tree = parseTypeScriptSource(src);
      fileTrees.set(filePath, tree);
      return tree;
    } catch {
      return null;
    }
  }

  const unit_refs: UnitRef[] = [];
  let bodyUnavailable = false;

  for (const unit of snapshot.units) {
    if (pathPrefix !== null && !toPosix(unit.file_path).startsWith(pathPrefix)) continue;

    const logical = logicalKindForTsUnit(unit);
    if (logical === null) continue;
    if (criteria.kind === "function" && logical !== "function") continue;
    if (criteria.kind === "method" && logical !== "method") continue;

    const text = await unitText(unit, snapshotRootPath);
    if (text === null) {
      if (criteria.name !== undefined || criteria.enclosing_class !== undefined) {
        bodyUnavailable = true;
      }
      continue;
    }

    const declName = declaredNameFromUnitSource(text);
    if (criteria.name !== undefined && criteria.name !== declName) continue;

    let enclosing: string | undefined;
    if (logical === "method" && snapshotRootPath) {
      const tree = await treeForFile(unit.file_path);
      if (tree) {
        enclosing = enclosingClassNameForMethod(tree, unit.start_byte) ?? undefined;
      }
    }

    if (criteria.enclosing_class !== undefined) {
      if (logical !== "method") continue;
      if (enclosing !== criteria.enclosing_class) continue;
    }

    unit_refs.push({
      id: unit.id,
      file_path: unit.file_path,
      kind: logical,
      ...(declName !== null ? { name: declName } : {}),
      ...(enclosing !== undefined ? { enclosing_class: enclosing } : {}),
    });
  }

  if (bodyUnavailable) {
    warn(
      capability_warnings,
      "lang.agent86.search_unit_body_unavailable",
      "Some units were skipped because inlined source was unavailable and blob text could not be resolved; narrow path_prefix or pass snapshot_root_path.",
    );
  }

  unit_refs.sort((a, b) => a.file_path.localeCompare(b.file_path) || a.id.localeCompare(b.id));
  return { unit_refs, capability_warnings: capability_warnings.length > 0 ? capability_warnings : undefined };
}
