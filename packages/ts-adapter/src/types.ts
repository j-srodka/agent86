/**
 * Wire types aligned with the locked v0 spec (section 5.1, section 6 read path,
 * section 12.1 codes). Agents branch on `outcome` and `entries[].code`, not on
 * `message` text.
 */

export type ValidationOutcome = "success" | "failure" | "partial";

export interface AdapterFingerprint {
  name: string;
  semver: string;
  grammar_digest: string;
  /** Same value MUST appear on `WorkspaceSummary.max_batch_ops` (read path). */
  max_batch_ops: number;
}

export type CheckScope = "file" | "package" | "project" | "none";

export type EntrySeverity = "error" | "warning" | "info";

export type EntryConfidence = "canonical" | "reanchored" | "unknown";

/**
 * Portable codes from the section 12.1 table. Adapters MUST NOT mint new
 * top-level codes for language-specific conditions; those use `lang.*` (section 12.2).
 */
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
  | "batch_size_exceeded";

/** Language-specific subcodes (section 12.2). Unknown `lang.*` severity must be honored as declared. */
export type LangSubcode = `lang.${string}`;

export type ValidationEntryCode = SpecNormativeCode | LangSubcode;

export interface ValidationEntry {
  code: ValidationEntryCode;
  severity: EntrySeverity;
  /** Human-readable detail; not for programmatic branching. */
  message: string;
  op_index: number | null;
  target_id: string | null;
  check_scope: CheckScope;
  confidence: EntryConfidence;
  evidence: Record<string, unknown> | null;
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
  /** Always present on the wire; empty when no id remapping occurred. */
  id_resolve_delta: Record<string, string>;
  entries: ValidationEntry[];
  /** Always present on the wire; empty when nothing was externalized. */
  omitted_due_to_size: OmittedBlob[];
  toolchain_fingerprint_at_apply: string;
}

/**
 * Cheap read-path surface (section 6). Task 4 materializes most fields; Task 10
 * resolves `manifest_url` when a manifest is present.
 */
export interface WorkspaceSummaryPolicies {
  /**
   * When absent at the wire level, generic processors MUST treat effective policy
   * as `"error"` (section 6.1 fail-safe). Use `getGeneratedAllowlistPolicy()`
   * (`policies.ts`) instead of reading this field directly.
   */
  generated_allowlist_insufficient_assertions?: "error" | "warning";
}

export interface WorkspaceSummary {
  snapshot_id: string;
  /** Same value as the snapshot header / `AdapterFingerprint.grammar_digest`. */
  grammar_digest: string;
  max_batch_ops: number;
  /** Absolute `file:` URL when `agent-ir.manifest.json` exists at snapshot root; else `null`. */
  manifest_url: string | null;
  policies: WorkspaceSummaryPolicies;
}

export interface SnapshotFile {
  path: string;
  /** SHA-256 (hex) of canonical LF file bytes. */
  sha256: string;
  byte_length: number;
}

export interface LogicalUnit {
  id: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  kind: "function_declaration" | "method_definition";
}

export interface WorkspaceSnapshot {
  snapshot_id: string;
  grammar_digest: string;
  adapter: AdapterFingerprint;
  files: SnapshotFile[];
  units: LogicalUnit[];
  /** Flattened map; v0 materialization starts as identity on unit ids. */
  id_resolve: Record<string, string>;
  /** `.tsx` paths discovered but not parsed (v0 TS grammar only); sorted. */
  skipped_tsx_paths: string[];
}

/** Subset referenced directly by the v0 apply path and plan gates. */
export type V0CoreApplyFailureCode =
  | "parse_error"
  | "grammar_mismatch"
  | "batch_size_exceeded"
  | "illegal_target_generated"
  | "allowlist_without_generator_awareness";

/** v0 op batch JSON shapes (subset; full schema deferred). */
export type ReplaceUnitOp = {
  op: "replace_unit";
  target_id: string;
  new_text: string;
};

export type RenameSymbolOp = {
  op: "rename_symbol";
  target_id: string;
  new_name: string;
};

export type V0Op = ReplaceUnitOp | RenameSymbolOp;
