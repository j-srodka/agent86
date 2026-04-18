/**
 * Structured unit search (read path). See `docs/impl/v0-decisions.md` — Agent86 SDK (v3).
 */

import { fetchBlobText } from "./blobs.js";
import type { LogicalUnit, WorkspaceSnapshot } from "./types.js";
import { declaredNameFromUnitSource } from "./units.js";

export type SearchCriteriaKind = "function" | "method" | "class" | "reference" | "import";

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

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

interface ClassSpan {
  start: number;
  end: number;
  name: string;
}

function innermostContainingClass(spans: ClassSpan[], byte: number): ClassSpan | null {
  let best: ClassSpan | null = null;
  for (const s of spans) {
    if (byte >= s.start && byte < s.end) {
      if (!best || s.start > best.start) best = s;
    }
  }
  return best;
}

function logicalKindForJsUnit(
  unit: LogicalUnit,
): "function" | "method" | "class" | null {
  if (unit.kind === "class_declaration") return "class";
  if (unit.kind === "method_definition") return "method";
  if (unit.kind === "function_declaration" || unit.kind === "arrow_function") return "function";
  return null;
}

/**
 * Search Tier I units in a js-adapter `WorkspaceSnapshot` slice (`.js`/`.mjs`/`.cjs` only).
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
      "tags filter is not implemented for js-adapter v1 search_units; tags were ignored.",
      { tags: criteria.tags },
    );
  }
  if (criteria.imported_from !== undefined && criteria.imported_from !== "") {
    warn(
      capability_warnings,
      "lang.agent86.search_imported_from_unsupported",
      "imported_from is not implemented for js-adapter v1 search_units; predicate ignored.",
      { imported_from: criteria.imported_from },
    );
  }

  if (criteria.kind === "reference" || criteria.kind === "import") {
    warn(
      capability_warnings,
      criteria.kind === "reference"
        ? "lang.agent86.search_kind_reference_unsupported"
        : "lang.agent86.search_kind_import_unsupported",
      `kind "${criteria.kind}" is not implemented for js-adapter v1 search_units.`,
      { kind: criteria.kind },
    );
    return { unit_refs: [], capability_warnings };
  }

  const pathPrefix = criteria.path_prefix !== undefined && criteria.path_prefix !== "" ? toPosix(criteria.path_prefix) : null;

  const classSpansByFile = new Map<string, ClassSpan[]>();
  for (const u of snapshot.units) {
    if (u.kind !== "class_declaration") continue;
    if (pathPrefix !== null && !toPosix(u.file_path).startsWith(pathPrefix)) continue;
    const text = await unitText(u, snapshotRootPath);
    const name = text !== null ? declaredNameFromUnitSource(text) ?? "" : "";
    const arr = classSpansByFile.get(u.file_path) ?? [];
    arr.push({ start: u.start_byte, end: u.end_byte, name });
    classSpansByFile.set(u.file_path, arr);
  }

  const unit_refs: UnitRef[] = [];
  let bodyUnavailable = false;

  for (const unit of snapshot.units) {
    if (pathPrefix !== null && !toPosix(unit.file_path).startsWith(pathPrefix)) continue;

    const logical = logicalKindForJsUnit(unit);
    if (logical === null) continue;
    if (criteria.kind !== logical) continue;

    const text = await unitText(unit, snapshotRootPath);
    if (text === null) {
      if (criteria.name !== undefined || criteria.enclosing_class !== undefined) bodyUnavailable = true;
      continue;
    }

    const declName = declaredNameFromUnitSource(text);
    if (criteria.name !== undefined && criteria.name !== declName) continue;

    let enclosing: string | undefined;
    if (logical === "method") {
      const spans = classSpansByFile.get(unit.file_path) ?? [];
      const container = innermostContainingClass(spans, unit.start_byte);
      enclosing = container?.name;
    }

    if (criteria.enclosing_class !== undefined) {
      if (logical !== "method" || enclosing !== criteria.enclosing_class) continue;
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
      "Some units were skipped because source text was unavailable; pass snapshot_root_path for blob-backed units.",
    );
  }

  unit_refs.sort((a, b) => a.file_path.localeCompare(b.file_path) || a.id.localeCompare(b.id));
  return { unit_refs, capability_warnings: capability_warnings.length > 0 ? capability_warnings : undefined };
}
