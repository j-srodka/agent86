import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AGENT_IR_MANIFEST_FILE } from "./manifest.js";

export type FormatterProfile = "prettier" | "lf-only";

export interface FormatDriftResult {
  drifted: boolean;
  /** Set when drift is not reported but profile is stubbed or informational. */
  reason: string | null;
}

/**
 * Reads `formatter.profile` from `agent-ir.manifest.json` at the given path.
 * Missing file, invalid JSON, or missing field → `"lf-only"`.
 */
export function readFormatterProfile(manifestPath: string | null): FormatterProfile {
  if (manifestPath == null) {
    return "lf-only";
  }
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "lf-only";
    }
    const fmt = (parsed as Record<string, unknown>).formatter;
    if (fmt === null || typeof fmt !== "object" || Array.isArray(fmt)) {
      return "lf-only";
    }
    const profile = (fmt as Record<string, unknown>).profile;
    if (profile === "prettier") {
      return "prettier";
    }
    return "lf-only";
  } catch {
    return "lf-only";
  }
}

/** Absolute path to `agent-ir.manifest.json` under the snapshot root. */
export function resolveAgentIrManifestPath(snapshotRootPath: string): string {
  return join(resolve(snapshotRootPath), AGENT_IR_MANIFEST_FILE);
}

/**
 * Post-edit drift check. `lf-only`: CR/LF in content is unexpected after canonicalization.
 * `prettier`: v1 stub — never drift; see `reason`.
 */
export function checkFormatDrift(source: string, profile: FormatterProfile): FormatDriftResult {
  if (profile === "prettier") {
    return { drifted: false, reason: "prettier_not_wired_v1" };
  }
  if (source.includes("\r\n") || source.includes("\r")) {
    return { drifted: true, reason: null };
  }
  return { drifted: false, reason: null };
}
