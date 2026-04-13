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
  | "batch_size_exceeded"
  /** Op target was resolved via `id_resolve` (superseded id); resolution is never silent (section 8). */
  | "id_superseded";

/** Language-specific subcodes (section 12.2). Unknown `lang.*` severity must be honored as declared. */
export type LangSubcode = `lang.${string}`;

export type ValidationEntryCode = SpecNormativeCode | LangSubcode;

/** Normative attachment for `rename_symbol` success (section 5.1); always set by the reference adapter. */
export interface RenameSurfaceSkipped {
  /**
   * Tier I unit whose span encloses this reference, when one exists; otherwise `null`
   * with reason `no_enclosing_unit` (e.g. top-level script between units).
   */
  unit_id: string | null;
  reason: string;
  /** Repo-relative POSIX path. */
  file: string;
}

export interface RenameSurfaceReport {
  found: number;
  rewritten: number;
  skipped: RenameSurfaceSkipped[];
}

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
  /** Present on `rename_symbol` success entries (`parse_scope_file` + report payload). */
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

/**
 * File/unit provenance (section 11). Always set on materialized snapshots — never omitted.
 * `authored` is explicit; `generated` requires `detected_by` (which rule matched).
 */
export type Provenance =
  | { kind: "authored" }
  | { kind: "generated"; detected_by: string };

export interface WorkspaceSummary {
  snapshot_id: string;
  /** Same value as the snapshot header / `AdapterFingerprint.grammar_digest`. */
  grammar_digest: string;
  max_batch_ops: number;
  /** Count of tracked files with `provenance.kind === "generated"` in this snapshot. */
  generated_file_count: number;
  /** True iff `generated_file_count > 0` (same snapshot). */
  has_generated_files: boolean;
  /** Absolute `file:` URL when `agent-ir.manifest.json` exists at snapshot root; else `null`. */
  manifest_url: string | null;
  policies: WorkspaceSummaryPolicies;
  /**
   * Absolute path to `<snapshotRoot>/.cache/blobs/` (§10 local blob store).
   * Populated even when empty so agents know where `sha256:` refs resolve.
   */
  blob_cache_path: string;
  /**
   * Every externalized unit payload (`blob_ref`); never silent omission on the read path.
   * Always present on the wire, including **`[]`** when nothing was externalized — never omit the field.
   */
  omitted_due_to_size: OmittedBlob[];
  /**
   * `true` when this summary was built with `buildWorkspaceSummary(..., { strictManifest: true })`.
   * Default `false` preserves v0 lenient manifest parsing for existing callers.
   */
  manifest_strict: boolean;
  /**
   * Strict-mode manifest parse diagnostics. Always present on the wire, including **`[]`** when there are no issues.
   * A missing field must not be interpreted as “no warnings” — absence is not equivalent to an empty array.
   */
  manifest_warnings: ValidationEntry[];
}

export interface SnapshotFile {
  path: string;
  /** SHA-256 (hex) of canonical LF file bytes. */
  sha256: string;
  byte_length: number;
  provenance: Provenance;
}

/** Tree-sitter extraction only; `materializeSnapshot` attaches `source_text` / `blob_*`. */
export interface ExtractedUnitSpan {
  id: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  kind: "function_declaration" | "method_definition";
}

/**
 * Tier I unit with either inlined source (`source_text`) or externalized payload (`blob_ref`).
 * Invariant: `source_text` and `blob_ref` are never both non-null. Externalized: `source_text === null`,
 * `blob_ref` is `sha256:<hex>`, `blob_bytes` is UTF-8 length. Inlined: `blob_ref === null`, `blob_bytes === null`.
 */
export interface LogicalUnit {
  id: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  kind: "function_declaration" | "method_definition";
  /** Inherited from the containing file’s `SnapshotFile.provenance`. */
  provenance: Provenance;
  /** Present when the unit span is inlined (UTF-8); null when externalized. */
  source_text: string | null;
  /** `sha256:<hex>` when externalized; null when inlined. */
  blob_ref: string | null;
  /** Byte length of the UTF-8 payload when externalized; null when inlined. */
  blob_bytes: number | null;
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

/** Optional §11 workflow assertions for ops targeting allowlisted generated units. */
export type GeneratorWorkflowAssertion = {
  generator_will_not_run?: true;
  generator_inputs_patched?: string[];
};

/** v0 op batch JSON shapes (subset; full schema deferred). */
export type ReplaceUnitOp = {
  op: "replace_unit";
  target_id: string;
  new_text: string;
} & GeneratorWorkflowAssertion;

export type RenameSymbolOp = {
  op: "rename_symbol";
  target_id: string;
  new_name: string;
  /** When true, best-effort `identifier` rewrite in other snapshot `.ts` files (default false). */
  cross_file?: boolean;
} & GeneratorWorkflowAssertion;

/** Cross-file move only; same-file reorder is rejected (`lang.ts.move_unit_same_file`). */
export type MoveUnitOp = {
  op: "move_unit";
  target_id: string;
  /** Repo-relative POSIX path (`.ts`). */
  destination_file: string;
  /** If omitted, append to end of destination file. */
  insert_after_id?: string;
} & GeneratorWorkflowAssertion;

/** Batch op union (v0 + v1); name kept for package stability. */
export type V0Op = ReplaceUnitOp | RenameSymbolOp | MoveUnitOp;

/** Readable alias — same type as `V0Op`. */
export type Op = V0Op;
