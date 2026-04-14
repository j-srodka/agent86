import type { ValidationReport } from "ts-adapter";

import type { CombinedWorkspaceSnapshot } from "./combined-snapshot.js";
import { languageForPath } from "./router.js";

export interface SessionState {
  ops_submitted: number;
  ops_succeeded: number;
  ops_rejected: number;
  batches_submitted: number;
  batches_succeeded: number;
  batches_rejected: number;
  false_positives_prevented: number;
  rejection_codes: Record<string, number>;
  warnings_emitted: Record<string, number>;
  snapshots_materialized: number;
  ts_units_seen: number;
  py_units_seen: number;
  session_start_iso: string;
}

/** Portable §12.1-style codes (non-`lang.*`) that may appear on success-path rows as warning or info. */
const KNOWN_SPEC_WARNING_OR_INFO_CODES = new Set<string>([
  "parse_scope_file",
  "rename_surface_skipped_refs",
  "format_drift",
  "id_superseded",
  "inline_threshold_exceeded",
  "allowlist_without_generator_awareness",
  "blob_unavailable",
]);

function createSessionState(): SessionState {
  return {
    ops_submitted: 0,
    ops_succeeded: 0,
    ops_rejected: 0,
    batches_submitted: 0,
    batches_succeeded: 0,
    batches_rejected: 0,
    false_positives_prevented: 0,
    rejection_codes: {},
    warnings_emitted: {},
    snapshots_materialized: 0,
    ts_units_seen: 0,
    py_units_seen: 0,
    session_start_iso: new Date().toISOString(),
  };
}

/** Single process-lifetime tally; reset when a new MCP server instance wires tools (see `beginMcpServerSession`). */
export const sessionState: SessionState = createSessionState();

/**
 * Clears tallies and sets a fresh `session_start_iso`. Invoked when wiring tools so each stdio server
 * process (and each in-memory smoke-test server) has an isolated session, matching “restart = reset.”
 */
export function beginMcpServerSession(): void {
  Object.assign(sessionState, createSessionState());
}

function bumpCodeCount(map: Record<string, number>, code: string): void {
  map[code] = (map[code] ?? 0) + 1;
}

function shouldCountWarningOrInfoEntry(code: string, severity: string): boolean {
  if (severity !== "warning" && severity !== "info") return false;
  if (code.startsWith("lang.")) return true;
  return KNOWN_SPEC_WARNING_OR_INFO_CODES.has(code);
}

export function recordMaterialize(snapshot: CombinedWorkspaceSnapshot): void {
  sessionState.snapshots_materialized += 1;
  for (const u of snapshot.units) {
    const lang = languageForPath(u.file_path);
    if (lang === "ts") sessionState.ts_units_seen += 1;
    else if (lang === "py") sessionState.py_units_seen += 1;
  }
}

export function recordApplyBatch(report: ValidationReport, opCount: number): void {
  sessionState.batches_submitted += 1;
  sessionState.ops_submitted += opCount;

  if (report.outcome === "success") {
    sessionState.batches_succeeded += 1;
    sessionState.ops_succeeded += opCount;
    for (const e of report.entries) {
      if (shouldCountWarningOrInfoEntry(e.code, e.severity)) {
        bumpCodeCount(sessionState.warnings_emitted, e.code);
      }
    }
    return;
  }

  sessionState.batches_rejected += 1;
  sessionState.ops_rejected += opCount;
  for (const e of report.entries) {
    bumpCodeCount(sessionState.rejection_codes, e.code);
  }
  if (report.outcome === "failure" && report.entries.some((e) => e.severity === "error")) {
    sessionState.false_positives_prevented += 1;
  }
}
