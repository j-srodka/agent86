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

const adapterFingerprintSchema = z.object({
  name: z.string(),
  semver: z.string(),
  grammar_digest: z.string(),
  max_batch_ops: z.number().int().positive(),
});

export const applyBatchInputSchema = z.object({
  root_path: z.string().min(1),
  snapshot: z.unknown(),
  ops: z.array(z.unknown()),
  toolchain_fingerprint_at_apply: adapterFingerprintSchema.optional(),
});
