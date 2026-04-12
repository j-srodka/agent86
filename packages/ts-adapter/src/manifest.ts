import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** v0 manifest filename at the snapshot workspace root (see `docs/impl/v0-decisions.md`). */
export const AGENT_IR_MANIFEST_FILE = "agent-ir.manifest.json";

function manifestAbsolutePath(snapshotRootPath: string): string {
  return join(resolve(snapshotRootPath), AGENT_IR_MANIFEST_FILE);
}

/**
 * If `agent-ir.manifest.json` exists at the snapshot root, returns its absolute `file:` URL;
 * otherwise `null`. No network I/O.
 */
export async function resolveManifestUrl(snapshotRootPath: string): Promise<string | null> {
  const abs = manifestAbsolutePath(snapshotRootPath);
  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return pathToFileURL(abs).href;
}

/**
 * Reads and parses `agent-ir.manifest.json` at the snapshot root.
 * Missing file → `{}`. Invalid JSON → `{}`. No remote fetch.
 */
export async function readAgentIrManifest(snapshotRootPath: string): Promise<Record<string, unknown>> {
  const abs = manifestAbsolutePath(snapshotRootPath);
  try {
    const raw = await readFile(abs, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
