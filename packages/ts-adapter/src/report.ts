import type {
  AdapterFingerprint,
  OmittedBlob,
  ValidationEntry,
  ValidationReport,
  ValidationOutcome,
} from "./types.js";

export interface BuildSuccessReportParams {
  snapshot_id: string;
  next_snapshot_id: string;
  adapter: AdapterFingerprint;
  toolchain_fingerprint_at_apply: string;
  id_resolve_delta?: Record<string, string>;
  entries?: ValidationEntry[];
  omitted_due_to_size?: OmittedBlob[];
}

/**
 * Builds a successful apply `ValidationReport`. Callers SHOULD attach section 12.1
 * codes on any informational `entries` (parse scope, thresholds, etc.).
 */
export function buildSuccessReport(params: BuildSuccessReportParams): ValidationReport {
  return {
    snapshot_id: params.snapshot_id,
    adapter: params.adapter,
    outcome: "success",
    next_snapshot_id: params.next_snapshot_id,
    id_resolve_delta: params.id_resolve_delta ?? {},
    entries: params.entries ?? [],
    omitted_due_to_size: params.omitted_due_to_size ?? [],
    toolchain_fingerprint_at_apply: params.toolchain_fingerprint_at_apply,
  };
}

export interface BuildFailureReportParams {
  snapshot_id: string;
  adapter: AdapterFingerprint;
  toolchain_fingerprint_at_apply: string;
  /** Must use normative section 12.1 codes (or `lang.*` per section 12.2), not prose-only outcomes. */
  entries: ValidationEntry[];
  outcome?: Extract<ValidationOutcome, "failure" | "partial">;
  /** Non-null only when `outcome === "partial"` and the batch explicitly opted in. */
  next_snapshot_id?: string | null;
  id_resolve_delta?: Record<string, string>;
  omitted_due_to_size?: OmittedBlob[];
}

/**
 * Builds a rejected (or explicit partial) apply report. `next_snapshot_id` defaults
 * to `null` for hard failures.
 */
export function buildFailureReport(params: BuildFailureReportParams): ValidationReport {
  const outcome = params.outcome ?? "failure";
  return {
    snapshot_id: params.snapshot_id,
    adapter: params.adapter,
    outcome,
    next_snapshot_id: params.next_snapshot_id ?? null,
    id_resolve_delta: params.id_resolve_delta ?? {},
    entries: params.entries,
    omitted_due_to_size: params.omitted_due_to_size ?? [],
    toolchain_fingerprint_at_apply: params.toolchain_fingerprint_at_apply,
  };
}

/**
 * Stub entry factory for future generated-unit allowlist checks (section 11 / 12.1).
 * Effective batch severity follows `getGeneratedAllowlistPolicy()` (section 6.1).
 */
export function stubAllowlistWithoutGeneratorAwarenessEntry(input: {
  op_index: number | null;
  target_id: string | null;
  severity: "error" | "warning";
}): ValidationEntry {
  return {
    code: "allowlist_without_generator_awareness",
    severity: input.severity,
    message:
      "Allowlisted generated target lacks generator_will_not_run or generator_inputs_patched.",
    op_index: input.op_index,
    target_id: input.target_id,
    check_scope: "file",
    confidence: "canonical",
    evidence: null,
  };
}
