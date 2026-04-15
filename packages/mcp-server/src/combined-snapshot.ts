import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  materializeSnapshot as materializeJsSnapshot,
  JS_ADAPTER_FINGERPRINT,
  JS_GRAMMAR_DIGEST,
} from "@agent86/js-adapter";
import {
  materializeSnapshot as materializePySnapshot,
  PY_ADAPTER_FINGERPRINT,
  PY_GRAMMAR_DIGEST,
} from "@agent86/py-adapter";
import type { WorkspaceSnapshot as TsWorkspaceSnapshot } from "ts-adapter";
import {
  DEFAULT_INLINE_THRESHOLD_BYTES,
  GRAMMAR_DIGEST_V0,
  materializeSnapshot as materializeTsSnapshot,
  V0_ADAPTER_FINGERPRINT,
} from "ts-adapter";

import { languageForPath } from "./router.js";

export type GrammarDigestsV2 = { ts: string; py: string; js: string };

/** Combined MCP snapshot: ts-adapter wire shape plus v2 `grammar_digests` and `skipped_jsx_paths`. */
export type CombinedWorkspaceSnapshot = TsWorkspaceSnapshot & {
  grammar_digests: GrammarDigestsV2;
  skipped_jsx_paths: string[];
};

export interface MaterializeCombinedOptions {
  rootPath: string;
  inline_threshold_bytes?: number;
}

export function computeCombinedSnapshotId(tsSnapshotId: string, pySnapshotId: string, jsSnapshotId: string): string {
  const sorted = [tsSnapshotId, pySnapshotId, jsSnapshotId].sort((a, b) => a.localeCompare(b));
  const joined = `${sorted[0]}\n${sorted[1]}\n${sorted[2]}`;
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

function mergeSkippedParseThrow(
  a: TsWorkspaceSnapshot["skipped_ts_parse_throw"],
  b: TsWorkspaceSnapshot["skipped_ts_parse_throw"],
  c: TsWorkspaceSnapshot["skipped_ts_parse_throw"],
): TsWorkspaceSnapshot["skipped_ts_parse_throw"] {
  return [...a, ...b, ...c].sort((x, y) => x.file_path.localeCompare(y.file_path));
}

function combinedAdapterFingerprint(files: TsWorkspaceSnapshot["files"]): TsWorkspaceSnapshot["adapter"] {
  const hasTs = files.some((f) => languageForPath(f.path) === "ts");
  if (hasTs) return V0_ADAPTER_FINGERPRINT;
  const hasPy = files.some((f) => languageForPath(f.path) === "py");
  if (hasPy) return PY_ADAPTER_FINGERPRINT;
  const hasJs = files.some((f) => languageForPath(f.path) === "js");
  if (hasJs) return JS_ADAPTER_FINGERPRINT;
  return V0_ADAPTER_FINGERPRINT;
}

function combinedGrammarDigestString(files: TsWorkspaceSnapshot["files"]): string {
  const hasTs = files.some((f) => languageForPath(f.path) === "ts");
  if (hasTs) return GRAMMAR_DIGEST_V0;
  const hasPy = files.some((f) => languageForPath(f.path) === "py");
  if (hasPy) return PY_GRAMMAR_DIGEST;
  const hasJs = files.some((f) => languageForPath(f.path) === "js");
  if (hasJs) return JS_GRAMMAR_DIGEST;
  return GRAMMAR_DIGEST_V0;
}

/**
 * Materialize ts + py + js adapter snapshots on the same root and merge into one MCP snapshot.
 */
export async function materializeCombinedSnapshot(
  options: MaterializeCombinedOptions,
): Promise<CombinedWorkspaceSnapshot> {
  const rootPath = resolve(options.rootPath);
  const inline = options.inline_threshold_bytes ?? DEFAULT_INLINE_THRESHOLD_BYTES;

  const [tsSnap, pySnap, jsSnap] = await Promise.all([
    materializeTsSnapshot({ rootPath, inline_threshold_bytes: inline }),
    materializePySnapshot({ rootPath, inline_threshold_bytes: inline }),
    materializeJsSnapshot({ rootPath, inline_threshold_bytes: inline }),
  ]);

  const files = [...tsSnap.files, ...pySnap.files, ...jsSnap.files].sort((a, b) => a.path.localeCompare(b.path));
  const units = [...tsSnap.units, ...pySnap.units, ...jsSnap.units];
  const id_resolve = { ...tsSnap.id_resolve, ...pySnap.id_resolve, ...jsSnap.id_resolve };
  const skipped_ts_parse_throw = mergeSkippedParseThrow(
    tsSnap.skipped_ts_parse_throw,
    pySnap.skipped_ts_parse_throw,
    jsSnap.skipped_ts_parse_throw,
  );

  const snapshot_id = computeCombinedSnapshotId(tsSnap.snapshot_id, pySnap.snapshot_id, jsSnap.snapshot_id);
  const grammar_digest = combinedGrammarDigestString(files);
  const adapter = combinedAdapterFingerprint(files);

  const grammar_digests: GrammarDigestsV2 = {
    ts: GRAMMAR_DIGEST_V0,
    py: PY_GRAMMAR_DIGEST,
    js: JS_GRAMMAR_DIGEST,
  };

  const skipped_jsx_paths = [...jsSnap.skipped_jsx_paths].sort((a, b) => a.localeCompare(b));

  return {
    snapshot_id,
    grammar_digest,
    adapter,
    files,
    units: units as TsWorkspaceSnapshot["units"],
    id_resolve,
    skipped_tsx_paths: tsSnap.skipped_tsx_paths,
    skipped_ts_parse_throw,
    grammar_digests,
    skipped_jsx_paths,
  };
}

export function buildTsApplySubset(combined: CombinedWorkspaceSnapshot): TsWorkspaceSnapshot {
  const files = combined.files.filter((f) => languageForPath(f.path) === "ts");
  const units = combined.units.filter((u) => languageForPath(u.file_path) === "ts");
  const skipped_ts_parse_throw = combined.skipped_ts_parse_throw.filter(
    (r) => languageForPath(r.file_path) === "ts",
  );
  return {
    snapshot_id: combined.snapshot_id,
    grammar_digest: GRAMMAR_DIGEST_V0,
    adapter: V0_ADAPTER_FINGERPRINT,
    files,
    units: units as TsWorkspaceSnapshot["units"],
    id_resolve: combined.id_resolve,
    skipped_tsx_paths: combined.skipped_tsx_paths,
    skipped_ts_parse_throw,
  };
}

export function buildPyApplySubset(combined: CombinedWorkspaceSnapshot): import("@agent86/py-adapter").WorkspaceSnapshot {
  const files = combined.files.filter((f) => languageForPath(f.path) === "py");
  const units = combined.units.filter((u) => languageForPath(u.file_path) === "py");
  const skipped_ts_parse_throw = combined.skipped_ts_parse_throw.filter(
    (r) => languageForPath(r.file_path) === "py",
  );
  return {
    snapshot_id: combined.snapshot_id,
    grammar_digest: PY_GRAMMAR_DIGEST,
    adapter: PY_ADAPTER_FINGERPRINT,
    files: files as import("@agent86/py-adapter").WorkspaceSnapshot["files"],
    units: units as unknown as import("@agent86/py-adapter").WorkspaceSnapshot["units"],
    id_resolve: combined.id_resolve,
    skipped_tsx_paths: [],
    skipped_ts_parse_throw,
  };
}

export function buildJsApplySubset(combined: CombinedWorkspaceSnapshot): import("@agent86/js-adapter").WorkspaceSnapshot {
  const files = combined.files.filter((f) => languageForPath(f.path) === "js");
  const units = combined.units.filter((u) => languageForPath(u.file_path) === "js");
  const skipped_ts_parse_throw = combined.skipped_ts_parse_throw.filter(
    (r) => languageForPath(r.file_path) === "js",
  );
  return {
    snapshot_id: combined.snapshot_id,
    grammar_digest: JS_GRAMMAR_DIGEST,
    adapter: JS_ADAPTER_FINGERPRINT,
    files: files as import("@agent86/js-adapter").WorkspaceSnapshot["files"],
    units: units as unknown as import("@agent86/js-adapter").WorkspaceSnapshot["units"],
    id_resolve: combined.id_resolve,
    skipped_tsx_paths: [],
    skipped_jsx_paths: [],
    skipped_ts_parse_throw,
  };
}
