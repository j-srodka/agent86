import type { Agent86Transport } from "./transport.js";
import { Agent86TransportError, Agent86VersionSkewError } from "./transport.js";
import type { SearchCriteria, UnitRef } from "./types.js";

export interface SearchWarning {
  code?: string;
  message: string;
  severity?: "error" | "warning" | "info";
}

/** Normative MCP `search_units` tool result (JSON body). No `list_units` compatibility. */
export interface SearchUnitsWireResult {
  unit_refs: unknown[];
  capability_warnings?: SearchWarning[];
}

export interface SearchOptions {
  transport: Agent86Transport;
  /** Workspace root passed through to `search_units` (absolute path recommended). */
  root_path: string;
  /** When set, `search_units` loads the snapshot from `.agent86/snapshots/` (same as `apply_batch`). */
  snapshot_id?: string;
  /**
   * `search()` may return an empty `UnitRef[]` when no units match the criteria; unsupported filter
   * combinations produce capability warnings via `onWarning` (if provided) rather than errors.
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
  return payload.capability_warnings ?? [];
}

function hasUnsupportedFilterWarning(warnings: SearchWarning[] | undefined): boolean {
  if (!warnings) return false;
  return warnings.some((w) => {
    const code = w.code?.toLowerCase() ?? "";
    const msg = w.message.toLowerCase();
    return code.includes("unsupported") || msg.includes("unsupported filter");
  });
}

/** Case-insensitive exact phrases on {@link Agent86TransportError.rpcMessage} only (not `message`). */
const VERSION_SKEW_RPC_MESSAGES = new Set(["method not found", "unknown tool", "tool not found"]);

function isVersionSkewTransportError(err: Agent86TransportError): boolean {
  if (err.code === -32601) return true;
  const rpc = err.rpcMessage?.trim().toLowerCase();
  if (rpc === undefined || rpc === "") return false;
  return VERSION_SKEW_RPC_MESSAGES.has(rpc);
}

/**
 * Query logical units via the MCP **`search_units`** tool only (not `list_units`).
 *
 * **Version skew:** If the host does not register **`search_units`**, or returns a **`list_units`**
 * shape (`{ units }` without **`unit_refs`**), this throws {@link Agent86VersionSkewError}.
 *
 * **Empty results:** When **`capability_warnings`** indicate an unsupported filter combination,
 * returns `[]` after **`onWarning`** (documented — not a silent failure).
 */
export async function search(criteria: SearchCriteria, opts: SearchOptions): Promise<UnitRef[]> {
  let raw: unknown;
  try {
    raw = await opts.transport.callTool<unknown>("search_units", {
      root_path: opts.root_path,
      ...(opts.snapshot_id === undefined ? {} : { snapshot_id: opts.snapshot_id }),
      criteria,
    });
  } catch (e) {
    if (e instanceof Agent86TransportError && isVersionSkewTransportError(e)) {
      throw new Agent86VersionSkewError(
        "MCP server does not expose search_units (or the tool call failed). @agent86/sdk v3 requires the Agent86 MCP server with the search_units tool.",
        { cause: e },
      );
    }
    throw e;
  }

  if (!isRecord(raw)) {
    throw new Agent86VersionSkewError("search_units returned a non-object body; upgrade the Agent86 MCP server.");
  }

  if ("units" in raw && !("unit_refs" in raw)) {
    throw new Agent86VersionSkewError(
      "Received a list_units-shaped response { units } without unit_refs. @agent86/sdk v3 requires search_units (UnitRef.snapshot_id provenance).",
    );
  }

  if (!("unit_refs" in raw)) {
    throw new Agent86VersionSkewError(
      "search_units response missing unit_refs. Upgrade the Agent86 MCP server to a build that implements search_units.",
    );
  }

  const unit_refs = raw.unit_refs;
  if (!Array.isArray(unit_refs)) {
    throw new TypeError("search_units result.unit_refs must be an array");
  }

  const payload: SearchUnitsWireResult = {
    unit_refs,
    ...(Array.isArray(raw.capability_warnings)
      ? { capability_warnings: raw.capability_warnings as SearchWarning[] }
      : {}),
  };

  const warnings = collectWarnings(payload);
  for (const w of warnings) {
    opts.onWarning?.(w);
  }
  if (hasUnsupportedFilterWarning(warnings)) {
    return [];
  }

  return unit_refs.map((u) => normalizeUnitRef(u));
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
