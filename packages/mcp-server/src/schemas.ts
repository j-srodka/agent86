import { z } from "zod";

export const materializeSnapshotInputSchema = z.object({
  root_path: z.string().min(1),
  inline_threshold_bytes: z.number().int().positive().optional(),
});

export const listUnitsInputSchema = z.object({
  root_path: z.string().min(1),
  file_path: z.string().optional(),
});

export const buildWorkspaceSummaryInputSchema = z.object({
  root_path: z.string().min(1),
});

/** No tool arguments; hosts may omit the key — normalize to `{}` before strict empty-object parse. */
export const getSessionReportInputSchema = z.preprocess(
  (v) => (v === undefined || v === null ? {} : v),
  z.object({}).strict(),
);

const adapterFingerprintSchema = z.object({
  name: z.string(),
  semver: z.string(),
  grammar_digest: z.string(),
  max_batch_ops: z.number().int().positive(),
});

/** Exactly one of snapshot_id or snapshot is validated in the apply_batch handler (MCP boundary must stay permissive so tool errors are consistent). */
export const applyBatchInputSchema = z.object({
  root_path: z.string().min(1),
  snapshot_id: z.string().min(1).optional(),
  snapshot: z.unknown().optional(),
  ops: z.array(z.unknown()),
  toolchain_fingerprint_at_apply: adapterFingerprintSchema.optional(),
});
