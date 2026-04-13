import { writeFile } from "node:fs/promises";

import type { AdapterFingerprint, WorkspaceSnapshot } from "ts-adapter";

export const METRICS_SCHEMA_VERSION = "ab-harness.v0";

/** Single baseline or IR approach row (extended for demo runs). */
export interface ApproachMetrics {
  outcome: "success" | "failure";
  /** Machine-readable reason when outcome is failure (e.g. parse_error, string_not_found). */
  failure_reason: string | null;
  full_file_reads: number;
  /** Read–edit–validate cycles until done or gave up (v0: typically 1). */
  round_trips: number;
  /** Rough proxy for token cost: UTF-16 code units read ÷ 4 (baseline + IR paths tally their reads). */
  tokens_estimated: number;
  /** Legacy counter: 1 if this approach did not achieve a green patch, else 0. */
  failed_patches: number;
  /** Alias of round_trips kept for older consumers. */
  rounds: number;
  detail: string;
  /** IR only: normative validation entry codes from the last apply attempt. */
  validation_codes?: string[];
}

export interface TaskMetrics {
  task_id: string;
  baseline: ApproachMetrics;
  ir: ApproachMetrics;
}

export interface AbMetricsFile {
  schema_version: typeof METRICS_SCHEMA_VERSION;
  /** Applying adapter identity; matches snapshots produced by this workspace’s `ts-adapter`. */
  adapter_fingerprint: AdapterFingerprint;
  /** Same as `adapter_fingerprint.grammar_digest`; duplicated for quick verification against `GRAMMAR_DIGEST_V0`. */
  grammar_digest: string;
  repo: { url: string; rev: string };
  snapshot_root: string;
  tasks: TaskMetrics[];
  /** When true, metrics come from a one-off demo profile (e.g. tRPC), not the standard Zod pin run. */
  demo_run?: boolean;
  /** Multi-line stdout-style summary for dashboards (demo profiles). */
  human_summary?: string;
}

const CHARS_PER_TOKEN_EST = 4;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_EST);
}

/** Sum of canonical file byte lengths (proxy for chars read during materialize). */
export function tokenCharsFromSnapshotFiles(snap: WorkspaceSnapshot): number {
  return snap.files.reduce((acc, f) => acc + f.byte_length, 0);
}

export function approachMetrics(input: {
  outcome: "success" | "failure";
  failure_reason?: string | null;
  full_file_reads: number;
  round_trips: number;
  tokens_chars_read: number;
  failed_patches: number;
  detail: string;
  validation_codes?: string[];
}): ApproachMetrics {
  const {
    outcome,
    failure_reason = null,
    full_file_reads,
    round_trips,
    tokens_chars_read,
    failed_patches,
    detail,
    validation_codes,
  } = input;
  const base: ApproachMetrics = {
    outcome,
    failure_reason: outcome === "failure" ? failure_reason : null,
    full_file_reads,
    round_trips,
    tokens_estimated: estimateTokensFromChars(tokens_chars_read),
    failed_patches,
    rounds: round_trips,
    detail,
  };
  if (validation_codes !== undefined) {
    base.validation_codes = validation_codes;
  }
  return base;
}

export async function writeMetrics(path: string, data: AbMetricsFile): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
