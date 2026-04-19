import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CombinedWorkspaceSnapshot } from "./combined-snapshot.js";
import { isCombinedWorkspaceSnapshot } from "./snapshot-guards.js";

export const SNAPSHOT_CACHE_DIR = ".agent86/snapshots";

/** All materialized snapshot ids in this stack are SHA-256 hex (64 lowercase hex chars). */
const SNAPSHOT_CACHE_ID_RE = /^[0-9a-f]{64}$/;

export function isValidSnapshotCacheId(snapshotId: string): boolean {
  return SNAPSHOT_CACHE_ID_RE.test(snapshotId);
}

export async function writeSnapshotCache(
  rootPath: string,
  snapshot: CombinedWorkspaceSnapshot,
): Promise<string> {
  const root = resolve(rootPath);
  if (!isValidSnapshotCacheId(snapshot.snapshot_id)) {
    throw new Error(
      `[agent86] refuse to write snapshot cache: invalid snapshot_id shape (expected 64-char lowercase hex)`,
    );
  }
  const filePath = join(root, SNAPSHOT_CACHE_DIR, `${snapshot.snapshot_id}.json`);
  await mkdir(join(root, SNAPSHOT_CACHE_DIR), { recursive: true });
  await writeFile(filePath, JSON.stringify(snapshot), "utf8");
  return filePath;
}

export async function readSnapshotCache(
  rootPath: string,
  snapshotId: string,
): Promise<CombinedWorkspaceSnapshot | null> {
  if (!isValidSnapshotCacheId(snapshotId)) {
    return null;
  }
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
    if (!isCombinedWorkspaceSnapshot(parsed)) {
      return null;
    }
    if (parsed.snapshot_id !== snapshotId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
