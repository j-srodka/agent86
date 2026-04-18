import type { SpecNormativeCode } from "ts-adapter";

/**
 * Hand-maintained map of normative §12.1 codes to short diagnostic phrases.
 * Grouped by spec table themes; `id_superseded` lives under identity/supersession.
 *
 * Callers should still branch on `ValidationEntry.code` from `ts-adapter` — this table is
 * for UX copy, static analysis, and exhaustive switch drills (see tests).
 */
export const REJECTION_CODES = {
  /** §12.1 — Tier I identity, snapshot staleness, supersession */
  identity_snapshot: {
    unknown_or_superseded_id: "Target id is not live and has no id_resolve forward edge",
    ghost_unit: "Target id maps through id_resolve to a non-live unit",
    stale_snapshot: "Snapshot header or handles are stale relative to workspace",
    id_resolve_chain_exceeded: "id_resolve forwarding exceeded the adapter chain limit",
    id_superseded: "Op target was auto-resolved from a superseded id (warning)",
  },
  /** §12.1 — On-disk bytes vs manifest, drift, grammar pins */
  integrity_environment: {
    snapshot_content_mismatch: "Canonical file bytes disagree with snapshot manifest hashes",
    format_drift: "Formatter profile detected unexpected line-ending or formatting drift",
    reanchored_span: "Logical span no longer matches the anchored snapshot range",
    grammar_mismatch: "Grammar artifact or snapshot grammar_digest disagrees with adapter pin",
    grammar_mismatch_on_apply: "Grammar mismatch detected specifically on the apply path",
  },
  /** §12.1 — Adapter interchange version and batch policy */
  adapter_batch: {
    adapter_version_unsupported: "Adapter fingerprint on snapshot does not match this toolchain",
    batch_size_exceeded: "Op batch length exceeds snapshot adapter max_batch_ops",
    op_vocabulary_unsupported: "Batch contains an opcode this adapter build cannot apply",
    partial_apply_not_permitted: "Partial apply was requested but policy forbids it",
  },
  /** §12.1 — Parse failures and parse-scoped informational entries */
  parse_surface: {
    parse_error: "Post-mutation parse failed for a touched file",
    parse_scope_file: "Parse scope is limited to the edited file (informational)",
    surface_changed: "Exported surface digest changed relative to pre-op snapshot",
    declaration_peer_unpatched: "Same-directory declaration peer may need manual alignment",
    rename_surface_skipped_refs: "Rename skipped reference sites (see rename_surface_report)",
  },
  /** §12.1 — Generated file policy and allowlist workflow */
  generated_policy: {
    illegal_target_generated: "Op targets generated provenance without allowlist escape",
    allowlist_without_generator_awareness: "Allowlisted generated edit lacks workflow assertions",
  },
  /** §12.1 — Blobs, inlining, and size thresholds */
  blobs_inline: {
    inline_threshold_exceeded: "Unit payload exceeded inline threshold after apply",
    blob_unavailable: "Externalized blob payload missing from local cache",
  },
  /** §12.1 — Typecheck/coverage placeholders */
  analysis_placeholders: {
    typecheck_scope_file: "Typecheck scope limited to file (informational)",
    typecheck_scope_none: "Typecheck scope disabled for this op (informational)",
    coverage_unknown: "Coverage signal unavailable",
    coverage_miss: "Coverage indicates potential untested surface",
  },
} as const;

export type RejectionPhraseCategory = keyof typeof REJECTION_CODES;

/** Exhaustive switch over every {@link SpecNormativeCode} — compile-time drift guard vs `ts-adapter`. */
export function phraseForNormativeCode(code: SpecNormativeCode): string {
  switch (code) {
    case "unknown_or_superseded_id":
      return REJECTION_CODES.identity_snapshot.unknown_or_superseded_id;
    case "ghost_unit":
      return REJECTION_CODES.identity_snapshot.ghost_unit;
    case "stale_snapshot":
      return REJECTION_CODES.identity_snapshot.stale_snapshot;
    case "id_resolve_chain_exceeded":
      return REJECTION_CODES.identity_snapshot.id_resolve_chain_exceeded;
    case "id_superseded":
      return REJECTION_CODES.identity_snapshot.id_superseded;
    case "snapshot_content_mismatch":
      return REJECTION_CODES.integrity_environment.snapshot_content_mismatch;
    case "format_drift":
      return REJECTION_CODES.integrity_environment.format_drift;
    case "reanchored_span":
      return REJECTION_CODES.integrity_environment.reanchored_span;
    case "grammar_mismatch":
      return REJECTION_CODES.integrity_environment.grammar_mismatch;
    case "grammar_mismatch_on_apply":
      return REJECTION_CODES.integrity_environment.grammar_mismatch_on_apply;
    case "adapter_version_unsupported":
      return REJECTION_CODES.adapter_batch.adapter_version_unsupported;
    case "batch_size_exceeded":
      return REJECTION_CODES.adapter_batch.batch_size_exceeded;
    case "op_vocabulary_unsupported":
      return REJECTION_CODES.adapter_batch.op_vocabulary_unsupported;
    case "partial_apply_not_permitted":
      return REJECTION_CODES.adapter_batch.partial_apply_not_permitted;
    case "parse_error":
      return REJECTION_CODES.parse_surface.parse_error;
    case "parse_scope_file":
      return REJECTION_CODES.parse_surface.parse_scope_file;
    case "surface_changed":
      return REJECTION_CODES.parse_surface.surface_changed;
    case "declaration_peer_unpatched":
      return REJECTION_CODES.parse_surface.declaration_peer_unpatched;
    case "rename_surface_skipped_refs":
      return REJECTION_CODES.parse_surface.rename_surface_skipped_refs;
    case "illegal_target_generated":
      return REJECTION_CODES.generated_policy.illegal_target_generated;
    case "allowlist_without_generator_awareness":
      return REJECTION_CODES.generated_policy.allowlist_without_generator_awareness;
    case "inline_threshold_exceeded":
      return REJECTION_CODES.blobs_inline.inline_threshold_exceeded;
    case "blob_unavailable":
      return REJECTION_CODES.blobs_inline.blob_unavailable;
    case "typecheck_scope_file":
      return REJECTION_CODES.analysis_placeholders.typecheck_scope_file;
    case "typecheck_scope_none":
      return REJECTION_CODES.analysis_placeholders.typecheck_scope_none;
    case "coverage_unknown":
      return REJECTION_CODES.analysis_placeholders.coverage_unknown;
    case "coverage_miss":
      return REJECTION_CODES.analysis_placeholders.coverage_miss;
    default: {
      const _exhaustive: never = code;
      void _exhaustive;
      throw new Error("unhandled normative code");
    }
  }
}

/** SDK-emitted `lang.agent86.*` contract codes (v0-decisions — snapshot coherence). */
export const SDK_LANG_AGENT86_CODES = {
  snapshot_id_mismatch: "lang.agent86.snapshot_id_mismatch",
} as const;
