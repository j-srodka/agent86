import type {
  AdapterFingerprint,
  OmittedBlob,
  ValidationEntry,
  ValidationOutcome,
  ValidationReport,
} from "./types.js";

function ghostUnknownPeers(): Pick<
  ValidationEntry,
  "export_surface_delta" | "coverage_hint" | "declaration_peers_unpatched"
> {
  return {
    export_surface_delta: "unknown",
    coverage_hint: { covered: null, coverage_source: null },
    declaration_peers_unpatched: [],
  };
}

export { ghostUnknownPeers };

export interface BuildSuccessReportParams {
  snapshot_id: string;
  next_snapshot_id: string;
  adapter: AdapterFingerprint;
  toolchain_fingerprint_at_apply: string;
  id_resolve_delta?: Record<string, string>;
  entries?: ValidationEntry[];
  omitted_due_to_size?: OmittedBlob[];
}

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
  entries: ValidationEntry[];
  outcome?: Extract<ValidationOutcome, "failure" | "partial">;
  next_snapshot_id?: string | null;
  id_resolve_delta?: Record<string, string>;
  omitted_due_to_size?: OmittedBlob[];
}

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
