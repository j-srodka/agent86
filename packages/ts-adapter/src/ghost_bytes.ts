import type { ValidationEntry, WorkspaceSnapshot } from "./types.js";

/** v1 placeholder — V8/Istanbul out of scope; wire shape is stable (see v0-decisions.md). */
export const COVERAGE_HINT_V1 = { covered: null, coverage_source: null } as const;

export type GhostBytesFields = Pick<
  ValidationEntry,
  "export_surface_delta" | "coverage_hint" | "declaration_peers_unpatched"
>;

export function ghostFields(
  export_surface_delta: "unchanged" | "changed" | "unknown",
  declaration_peers_unpatched: string[],
): GhostBytesFields {
  return {
    export_surface_delta,
    coverage_hint: COVERAGE_HINT_V1,
    declaration_peers_unpatched,
  };
}

export function ghostUnknownPeers(): GhostBytesFields {
  return ghostFields("unknown", []);
}

/** `src/foo.ts` → `src/foo.d.ts`; `.d.ts` sources have no peer in v1. */
export function peerDtsPathForTsSource(editedFilePath: string): string | null {
  if (!editedFilePath.endsWith(".ts") || editedFilePath.endsWith(".d.ts")) {
    return null;
  }
  return `${editedFilePath.slice(0, -3)}.d.ts`;
}

/** Unit ids from a same-directory `basename.d.ts` peer when that file is in the snapshot. */
export function declarationPeersUnpatched(snapshot: WorkspaceSnapshot, editedFilePath: string): string[] {
  const peerPath = peerDtsPathForTsSource(editedFilePath);
  if (peerPath == null || !snapshot.files.some((f) => f.path === peerPath)) {
    return [];
  }
  return snapshot.units
    .filter((u) => u.file_path === peerPath)
    .map((u) => u.id)
    .sort((a, b) => a.localeCompare(b));
}

export function combineSurfaceDelta(
  a: "unchanged" | "changed" | "unknown",
  b: "unchanged" | "changed" | "unknown",
): "unchanged" | "changed" | "unknown" {
  if (a === "unknown" || b === "unknown") {
    return "unknown";
  }
  if (a === "changed" || b === "changed") {
    return "changed";
  }
  return "unchanged";
}
