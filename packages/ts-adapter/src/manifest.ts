import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** v0 manifest filename at the snapshot workspace root (see `docs/impl/v0-decisions.md`). */
export const AGENT_IR_MANIFEST_FILE = "agent-ir.manifest.json";

export class ManifestParseError extends Error {
  override readonly name = "ManifestParseError";
  readonly manifestPath: string;
  readonly reason: "invalid_json" | "non_object_root";
  readonly rawError?: string;

  constructor(params: {
    manifestPath: string;
    reason: "invalid_json" | "non_object_root";
    rawError?: string;
  }) {
    const { manifestPath, reason, rawError } = params;
    const detail =
      reason === "non_object_root"
        ? "non-object root"
        : rawError !== undefined && rawError !== ""
          ? rawError
          : "invalid JSON";
    super(`ManifestParseError: ${reason} (${detail}) (path: ${manifestPath})`);
    this.manifestPath = manifestPath;
    this.reason = reason;
    this.rawError = rawError;
  }
}

export interface ReadAgentIrManifestOptions {
  /**
   * When `true`, invalid JSON or a non-object root throws `ManifestParseError`.
   * Default `false` preserves v0 lenient behavior (`{}` for missing, invalid, or non-object).
   */
  strict?: boolean;
}

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
 * Missing file → `{}`. With default (lenient) options: invalid JSON or non-object root → `{}`. No remote fetch.
 */
export async function readAgentIrManifest(
  snapshotRootPath: string,
  options?: ReadAgentIrManifestOptions,
): Promise<Record<string, unknown>> {
  const strict = options?.strict === true;
  const abs = manifestAbsolutePath(snapshotRootPath);

  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {};
    }
    if (strict) {
      throw new ManifestParseError({
        manifestPath: abs,
        reason: "invalid_json",
        rawError: err.message ?? String(e),
      });
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (strict) {
      const rawError = e instanceof Error ? e.message : String(e);
      throw new ManifestParseError({
        manifestPath: abs,
        reason: "invalid_json",
        rawError,
      });
    }
    return {};
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (strict) {
      throw new ManifestParseError({
        manifestPath: abs,
        reason: "non_object_root",
      });
    }
    return {};
  }
  return parsed as Record<string, unknown>;
}
