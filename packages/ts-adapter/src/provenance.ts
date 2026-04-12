import type { Provenance } from "./types.js";

/** First `lineCount` lines of canonical source (newline-delimited); used for header heuristics. */
export function firstNLines(canonicalUtf8: string, lineCount: number): string[] {
  const lines: string[] = [];
  let i = 0;
  while (lines.length < lineCount && i <= canonicalUtf8.length) {
    const j = canonicalUtf8.indexOf("\n", i);
    if (j === -1) {
      lines.push(canonicalUtf8.slice(i));
      break;
    }
    lines.push(canonicalUtf8.slice(i, j));
    i = j + 1;
  }
  return lines;
}

/**
 * Pattern-based generated-file detection (see `docs/impl/v0-decisions.md` — Generated file provenance (v1)).
 * Rules apply in order; first match wins.
 */
export function detectProvenance(filePathPosix: string, firstLines: string[]): Provenance {
  // Rule 1 — header (scan lines top to bottom)
  for (const line of firstLines) {
    const lower = line.toLowerCase();
    if (lower.includes("@generated")) {
      return { kind: "generated", detected_by: "header:@generated" };
    }
    if (lower.includes("do not edit")) {
      return { kind: "generated", detected_by: "header:do-not-edit" };
    }
  }

  const segments = filePathPosix.split("/");

  // Rule 2 — path segments
  for (const seg of segments) {
    if (seg === "__generated__") {
      return { kind: "generated", detected_by: "path:segment:__generated__" };
    }
    if (seg === "generated") {
      return { kind: "generated", detected_by: "path:segment:generated" };
    }
  }

  const base = segments[segments.length - 1] ?? filePathPosix;

  // Rule 3 — .generated.ts / .generated.d.ts
  if (base.endsWith(".generated.ts")) {
    return { kind: "generated", detected_by: "ext:.generated.ts" };
  }
  if (base.endsWith(".generated.d.ts")) {
    return { kind: "generated", detected_by: "ext:.generated.d.ts" };
  }

  // Rule 4 — protobuf-style
  if (base.endsWith(".pb.ts")) {
    return { kind: "generated", detected_by: "path:*.pb.ts" };
  }
  if (base.endsWith(".pb.d.ts")) {
    return { kind: "generated", detected_by: "path:*.pb.d.ts" };
  }

  return { kind: "authored" };
}

/**
 * Whether `filePath` is allowlisted for direct edits to generated units (`agent-ir.manifest.json`
 * key `generated_edit_allowlist`).
 */
export function fileMatchesGeneratedEditAllowlist(
  filePath: string,
  manifest: Record<string, unknown>,
): boolean {
  const raw = manifest.generated_edit_allowlist;
  if (!Array.isArray(raw)) {
    return false;
  }
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    if (entry.endsWith("/**")) {
      const base = entry.slice(0, -3);
      if (filePath === base || filePath.startsWith(`${base}/`)) {
        return true;
      }
      continue;
    }
    if (filePath === entry) {
      return true;
    }
  }
  return false;
}
