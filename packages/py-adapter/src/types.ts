/**
 * Wire types for py-adapter — structurally compatible with ts-adapter but using
 * Python-specific unit kind strings. Agents branch on `outcome` and `entries[].code`.
 */

export type ValidationOutcome = "success" | "failure" | "partial";

export interface AdapterFingerprint {
  name: string;
  semver: string;
  grammar_digest: string;
  max_batch_ops: number;
}

export type CheckScope = "file" | "package" | "project" | "none";
export type EntrySeverity = "error" | "warning" | "info";
export type EntryConfidence = "canonical" | "reanchored" | "unknown";

export type SpecNormativeCode =
  | "unknown_or_superseded_id"
  | "ghost_unit"
  | "stale_snapshot"
  | "id_resolve_chain_exceeded"
  | "snapshot_content_mismatch"
  | "format_drift"
  | "reanchored_span"
  | "grammar_mismatch"
  | "grammar_mismatch_on_apply"
  | "adapter_version_unsupported"
  | "parse_error"
  | "illegal_target_generated"
  | "allowlist_without_generator_awareness"
  | "inline_threshold_exceeded"
  | "blob_unavailable"
  | "typecheck_scope_file"
  | "typecheck_scope_none"
  | "parse_scope_file"
  | "surface_changed"
  | "declaration_peer_unpatched"
  | "rename_surface_skipped_refs"
  | "coverage_unknown"
  | "coverage_miss"
  | "partial_apply_not_permitted"
  | "op_vocabulary_unsupported"
  | "batch_size_exceeded"
  | "id_superseded";

export type LangSubcode = `lang.${string}`;
export type ValidationEntryCode = SpecNormativeCode | LangSubcode;

export interface RenameSurfaceSkipped {
  unit_id: string | null;
  reason: string;
  file: string;
}

export interface RenameSurfaceReport {
  found: number;
  rewritten: number;
  skipped: RenameSurfaceSkipped[];
}

export interface CoverageHintV1 {
  covered: null;
  coverage_source: null;
}

export interface ValidationEntry {
  code: ValidationEntryCode;
  severity: EntrySeverity;
  message: string;
  op_index: number | null;
  target_id: string | null;
  check_scope: CheckScope;
  confidence: EntryConfidence;
  evidence: Record<string, unknown> | null;
  export_surface_delta: "unchanged" | "changed" | "unknown";
  coverage_hint: CoverageHintV1;
  declaration_peers_unpatched: string[];
  rename_surface_report?: RenameSurfaceReport;
}

export interface OmittedBlob {
  ref: string;
  bytes: number;
  reason: "inline_threshold" | "policy" | "unavailable";
}

export interface ValidationReport {
  snapshot_id: string;
  adapter: AdapterFingerprint;
  outcome: ValidationOutcome;
  next_snapshot_id: string | null;
  id_resolve_delta: Record<string, string>;
  entries: ValidationEntry[];
  omitted_due_to_size: OmittedBlob[];
  toolchain_fingerprint_at_apply: string;
}

export interface WorkspaceSummaryPolicies {
  generated_allowlist_insufficient_assertions?: "error" | "warning";
}

export type Provenance =
  | { kind: "authored" }
  | { kind: "generated"; detected_by: string };

export interface WorkspaceSummary {
  snapshot_id: string;
  grammar_digest: string;
  max_batch_ops: number;
  generated_file_count: number;
  has_generated_files: boolean;
  manifest_url: string | null;
  policies: WorkspaceSummaryPolicies;
  blob_cache_path: string;
  omitted_due_to_size: OmittedBlob[];
  manifest_strict: boolean;
  manifest_warnings: ValidationEntry[];
}

export interface SnapshotFile {
  path: string;
  sha256: string;
  byte_length: number;
  provenance: Provenance;
}

/** Python unit kinds (v1). See docs/impl/v0-decisions.md — Python adapter (v2). */
export type PyUnitKind = "function_definition" | "class_definition";

/** Tree-sitter extraction only; `materializeSnapshot` attaches `source_text` / `blob_*`. */
export interface ExtractedUnitSpan {
  id: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  kind: PyUnitKind;
}

export interface LogicalUnit {
  id: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  kind: PyUnitKind;
  provenance: Provenance;
  source_text: string | null;
  blob_ref: string | null;
  blob_bytes: number | null;
}

/** `.py` file omitted because tree-sitter threw during parse. */
export interface SkippedPyParseThrow {
  file_path: string;
  reason: "parse_throw";
}

export interface WorkspaceSnapshot {
  snapshot_id: string;
  grammar_digest: string;
  adapter: AdapterFingerprint;
  files: SnapshotFile[];
  units: LogicalUnit[];
  id_resolve: Record<string, string>;
  /** Explicit omission list (parallel to ts-adapter's skipped_tsx_paths). Always `[]` for py-adapter v1. */
  skipped_tsx_paths: string[];
  skipped_ts_parse_throw: SkippedPyParseThrow[];
}

export type V0CoreApplyFailureCode =
  | "parse_error"
  | "grammar_mismatch"
  | "batch_size_exceeded"
  | "illegal_target_generated"
  | "allowlist_without_generator_awareness";

export type GeneratorWorkflowAssertion = {
  generator_will_not_run?: true;
  generator_inputs_patched?: string[];
};

export type ReplaceUnitOp = {
  op: "replace_unit";
  target_id: string;
  new_text: string;
} & GeneratorWorkflowAssertion;

export type RenameSymbolOp = {
  op: "rename_symbol";
  target_id: string;
  new_name: string;
  cross_file?: boolean;
} & GeneratorWorkflowAssertion;

export type MoveUnitOp = {
  op: "move_unit";
  target_id: string;
  destination_file: string;
  insert_after_id?: string;
} & GeneratorWorkflowAssertion;

export type V0Op = ReplaceUnitOp | RenameSymbolOp | MoveUnitOp;
export type Op = V0Op;
