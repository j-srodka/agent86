import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CombinedWorkspaceSnapshot } from "./combined-snapshot.js";

export const SNAPSHOT_CACHE_DIR = ".agent86/snapshots";

export async function writeSnapshotCache(
  rootPath: string,
  snapshot: CombinedWorkspaceSnapshot,
): Promise<string> {
  const root = resolve(rootPath);
  const filePath = join(root, SNAPSHOT_CACHE_DIR, `${snapshot.snapshot_id}.json`);
  await mkdir(join(root, SNAPSHOT_CACHE_DIR), { recursive: true });
  await writeFile(filePath, JSON.stringify(snapshot), "utf8");
  return filePath;
}

export async function readSnapshotCache(
  rootPath: string,
  snapshotId: string,
): Promise<CombinedWorkspaceSnapshot | null> {
  const root = resolve(rootPath);
  const filePath = join(root, SNAPSHOT_CACHE_DIR, `${snapshotId}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as CombinedWorkspaceSnapshot;
  } catch {
    return null;
  }
}
