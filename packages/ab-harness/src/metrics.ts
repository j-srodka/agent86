import { writeFile } from "node:fs/promises";

export const METRICS_SCHEMA_VERSION = "ab-harness.v0";

export interface TaskMetrics {
  task_id: string;
  baseline: {
    outcome: "success" | "failure";
    full_file_reads: number;
    failed_patches: number;
    rounds: number;
    detail: string;
  };
  ir: {
    outcome: "success" | "failure";
    full_file_reads: number;
    failed_patches: number;
    rounds: number;
    detail: string;
  };
}

export interface AbMetricsFile {
  schema_version: typeof METRICS_SCHEMA_VERSION;
  repo: { url: string; rev: string };
  snapshot_root: string;
  tasks: TaskMetrics[];
}

export async function writeMetrics(path: string, data: AbMetricsFile): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
