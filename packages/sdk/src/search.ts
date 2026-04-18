import type { Agent86Transport } from "./transport.js";
import type { SearchCriteria, UnitRef } from "./types.js";

export interface SearchWarning {
  code?: string;
  message: string;
  severity?: "error" | "warning" | "info";
}

export interface SearchUnitsWireResult {
  /** Normative MCP `search_units` payload (see v0-decisions). */
  unit_refs?: unknown;
  capability_warnings?: SearchWarning[];
  /** Legacy / test aliases */
  units?: unknown;
  warnings?: SearchWarning[];
}

export interface SearchOptions {
  transport: Agent86Transport;
  /** Workspace root passed through to `search_units` (absolute path recommended). */
  root_path: string;
  /** When set, `search_units` loads the snapshot from `.agent86/snapshots/` (same as `apply_batch`). */
  snapshot_id?: string;
  /**
   * When the server returns warnings (for example unsupported filter combinations), the SDK
   * may return an empty `units` list. Those warnings are forwarded here — never swallowed silently.
   */
  onWarning?: (warning: SearchWarning) => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") return undefined;
    out.push(x);
  }
  return out;
}

/**
 * Best-effort coercion of server payloads into {@link UnitRef}.
 * Unknown shapes throw so callers do not silently treat garbage as success.
 */
export function normalizeUnitRef(raw: unknown): UnitRef {
  if (!isRecord(raw)) {
    throw new TypeError("search_units unit entry must be an object");
  }
  const id = asString(raw.id);
  const file_path = asString(raw.file_path);
  const snapshot_id = asString(raw.snapshot_id);
  const kind = asString(raw.kind);
  if (!id || !file_path || !snapshot_id || !kind) {
    throw new TypeError("search_units unit entry missing id, file_path, snapshot_id, or kind");
  }
  if (kind !== "function" && kind !== "method" && kind !== "class" && kind !== "reference" && kind !== "import") {
    throw new TypeError(`search_units unit entry has unsupported kind: ${kind}`);
  }
  return {
    id,
    file_path,
    snapshot_id,
    kind,
    name: asString(raw.name),
    enclosing_class: asString(raw.enclosing_class),
    imported_from: asString(raw.imported_from),
    tags: asStringArray(raw.tags),
  };
}

function collectWarnings(payload: SearchUnitsWireResult): SearchWarning[] {
  const a = payload.capability_warnings ?? [];
  const b = payload.warnings ?? [];
  return [...a, ...b];
}

function hasUnsupportedFilterWarning(warnings: SearchWarning[] | undefined): boolean {
  if (!warnings) return false;
  return warnings.some((w) => {
    const code = w.code?.toLowerCase() ?? "";
    const msg = w.message.toLowerCase();
    return code.includes("unsupported") || msg.includes("unsupported filter");
  });
}

/**
 * Query logical units via the MCP `search_units` tool.
 *
 * **Empty results:** When the transport returns {@link SearchUnitsWireResult.warnings} that
 * indicate an unsupported filter, this function returns `[]` after emitting warnings through
 * `onWarning` (documented empty-on-warning behavior — not a silent failure).
 */
export async function search(criteria: SearchCriteria, opts: SearchOptions): Promise<UnitRef[]> {
  const payload = await opts.transport.callTool<SearchUnitsWireResult>("search_units", {
    root_path: opts.root_path,
    ...(opts.snapshot_id === undefined ? {} : { snapshot_id: opts.snapshot_id }),
    criteria,
  });
  const warnings = collectWarnings(payload);
  for (const w of warnings) {
    opts.onWarning?.(w);
  }
  if (hasUnsupportedFilterWarning(warnings)) {
    return [];
  }
  const units = payload.unit_refs ?? payload.units;
  if (units === undefined) {
    return [];
  }
  if (!Array.isArray(units)) {
    throw new TypeError("search_units result.unit_refs must be an array when present");
  }
  return units.map((u) => normalizeUnitRef(u));
}

/**
 * Convenience helper: merge base criteria with overrides (shallow).
 * `undefined` overrides do not clobber the base field.
 */
export function mergeSearchCriteria(base: SearchCriteria, override: Partial<SearchCriteria>): SearchCriteria {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)),
  } as SearchCriteria;
}
