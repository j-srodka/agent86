import type { WorkspaceSummary, WorkspaceSummaryPolicies } from "./types.js";

/**
 * Effective severity for insufficient generator assertions on allowlisted generated
 * targets (section 6.1). Callers MUST use this instead of reading
 * `policies.generated_allowlist_insufficient_assertions` directly so absent-field
 * fail-safe `"error"` is always applied.
 */
export function getGeneratedAllowlistPolicy(
  summaryOrPolicies: WorkspaceSummary | WorkspaceSummaryPolicies,
): "error" | "warning" {
  const policies: WorkspaceSummaryPolicies =
    "snapshot_id" in summaryOrPolicies
      ? summaryOrPolicies.policies
      : summaryOrPolicies;
  const v = policies.generated_allowlist_insufficient_assertions;
  return v === "warning" ? "warning" : "error";
}
