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
  id_resolve_delta: Record<string, string>;
  entries: ValidationEntry[];
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
   * as `"error"` (section 6.1 fail-safe).
   */
  generated_allowlist_insufficient_assertions?: "error" | "warning";
}

export interface WorkspaceSummary {
  snapshot_id: string;
  max_batch_ops: number;
  /** `file:` URL or repo-relative path when known; `null` when absent (Task 10). */
  manifest_url: string | null;
  policies: WorkspaceSummaryPolicies;
}

/** Subset referenced directly by the v0 apply path and plan gates. */
export type V0CoreApplyFailureCode =
  | "parse_error"
  | "grammar_mismatch"
  | "batch_size_exceeded"
  | "illegal_target_generated"
  | "allowlist_without_generator_awareness";
