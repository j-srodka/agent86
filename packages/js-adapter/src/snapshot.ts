import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { getBlobCachePath } from "./blobs.js";
import { JS_GRAMMAR_DIGEST } from "./grammar.js";
import { mergeIdResolveFromPrevious } from "./id_resolve.js";
import { parseJavaScriptSource } from "./parser.js";
import { extractJsLogicalUnits } from "./units.js";
import type {
  AdapterFingerprint,
  ExtractedUnitSpan,
  LogicalUnit,
  OmittedBlob,
  Provenance,
  SkippedJsParseThrow,
  SnapshotFile,
  WorkspaceSnapshot,
} from "./types.js";

export const JS_ADAPTER_FINGERPRINT: AdapterFingerprint = {
  name: "js-adapter",
  semver: "0.0.0",
  grammar_digest: JS_GRAMMAR_DIGEST,
  max_batch_ops: 50,
};

export function canonicalizeSourceForSnapshot(sourceUtf8: string): string {
  return sourceUtf8.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sha256HexOfCanonicalSource(canonicalUtf8: string): string {
  return createHash("sha256").update(canonicalUtf8, "utf8").digest("hex");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isJsSource(relPosix: string): boolean {
  return (
    relPosix.endsWith(".js") || relPosix.endsWith(".mjs") || relPosix.endsWith(".cjs")
  );
}

function isJsx(relPosix: string): boolean {
  return relPosix.endsWith(".jsx");
}

async function walkJsAndJsxFiles(
  absoluteDir: string,
  snapshotRoot: string,
  jsOut: string[],
  jsxOut: string[],
): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = join(absoluteDir, ent.name);
    const rel = toPosix(relative(snapshotRoot, abs));
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git") {
        continue;
      }
      await walkJsAndJsxFiles(abs, snapshotRoot, jsOut, jsxOut);
    } else if (ent.isFile()) {
      if (isJsSource(rel)) jsOut.push(rel);
      else if (isJsx(rel)) jsxOut.push(rel);
    }
  }
}

function computeSnapshotId(input: {
  grammar_digest: string;
  adapter: AdapterFingerprint;
  files: SnapshotFile[];
  units: LogicalUnit[];
  skipped_tsx_paths: string[];
  skipped_jsx_paths: string[];
  skipped_ts_parse_throw: SkippedJsParseThrow[];
}): string {
  const sortedFiles = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const sortedUnits = [...input.units].sort((a, b) => a.id.localeCompare(b.id));
  const skippedTsx = [...input.skipped_tsx_paths].sort((a, b) => a.localeCompare(b));
  const skippedJsx = [...input.skipped_jsx_paths].sort((a, b) => a.localeCompare(b));
  const skippedThrow = [...input.skipped_ts_parse_throw].sort((a, b) =>
    a.file_path.localeCompare(b.file_path),
  );
  const payload = {
    grammar_digest: input.grammar_digest,
    adapter: {
      name: input.adapter.name,
      semver: input.adapter.semver,
      max_batch_ops: input.adapter.max_batch_ops,
    },
    files: sortedFiles,
    units: sortedUnits,
    skipped_tsx_paths: skippedTsx,
    skipped_jsx_paths: skippedJsx,
    skipped_ts_parse_throw: skippedThrow,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export const DEFAULT_INLINE_THRESHOLD_BYTES = 8192;

export interface MaterializeSnapshotOptions {
  rootPath: string;
  inline_threshold_bytes?: number;
  previousSnapshot?: WorkspaceSnapshot;
}

export async function materializeSnapshot(options: MaterializeSnapshotOptions): Promise<WorkspaceSnapshot> {
  const snapshotRootResolved = resolve(options.rootPath);
  const inlineThreshold = options.inline_threshold_bytes ?? DEFAULT_INLINE_THRESHOLD_BYTES;
  const grammarDigest = JS_GRAMMAR_DIGEST;
  const previousSnapshot = options.previousSnapshot;

  const jsRel: string[] = [];
  const jsxRel: string[] = [];
  await walkJsAndJsxFiles(snapshotRootResolved, snapshotRootResolved, jsRel, jsxRel);
  jsRel.sort((a, b) => a.localeCompare(b));
  jsxRel.sort((a, b) => a.localeCompare(b));

  const files: SnapshotFile[] = [];
  const units: LogicalUnit[] = [];
  const skipped_parse_throw: SkippedJsParseThrow[] = [];

  for (const rel of jsRel) {
    const abs = join(snapshotRootResolved, ...rel.split("/"));
    const raw = await readFile(abs, "utf8");
    const canonical = canonicalizeSourceForSnapshot(raw);
    let tree: ReturnType<typeof parseJavaScriptSource>;
    try {
      tree = parseJavaScriptSource(canonical);
    } catch {
      skipped_parse_throw.push({ file_path: rel, reason: "parse_throw" });
      continue;
    }
    const fileSha = sha256HexOfCanonicalSource(canonical);
    const provenance: Provenance = { kind: "authored" };
    files.push({
      path: rel,
      sha256: fileSha,
      byte_length: Buffer.byteLength(canonical, "utf8"),
      provenance,
    });
    const spans = extractJsLogicalUnits(tree, {
      grammarDigest,
      snapshotRootResolved,
      filePathPosix: rel,
    });
    for (const span of spans) {
      const unitText = canonical.slice(span.start_byte, span.end_byte);
      units.push(await finalizeLogicalUnit(span, unitText, snapshotRootResolved, inlineThreshold, provenance));
    }
  }

  const id_resolve = mergeIdResolveFromPrevious(units, previousSnapshot?.id_resolve);
  skipped_parse_throw.sort((a, b) => a.file_path.localeCompare(b.file_path));

  const snapshot_id = computeSnapshotId({
    grammar_digest: grammarDigest,
    adapter: JS_ADAPTER_FINGERPRINT,
    files,
    units,
    skipped_tsx_paths: [],
    skipped_jsx_paths: jsxRel,
    skipped_ts_parse_throw: skipped_parse_throw,
  });

  return {
    snapshot_id,
    grammar_digest: grammarDigest,
    adapter: JS_ADAPTER_FINGERPRINT,
    files,
    units,
    id_resolve,
    skipped_tsx_paths: [],
    skipped_jsx_paths: jsxRel,
    skipped_ts_parse_throw: skipped_parse_throw,
  };
}

async function finalizeLogicalUnit(
  span: ExtractedUnitSpan,
  unitUtf8: string,
  snapshotRootResolved: string,
  inlineThresholdBytes: number,
  provenance: Provenance,
): Promise<LogicalUnit> {
  const byteLen = Buffer.byteLength(unitUtf8, "utf8");
  if (byteLen > inlineThresholdBytes) {
    const digestHex = createHash("sha256").update(unitUtf8, "utf8").digest("hex");
    const blob_ref = `sha256:${digestHex}`;
    const cacheDir = getBlobCachePath(snapshotRootResolved);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, digestHex), unitUtf8, "utf8");
    return {
      ...span,
      provenance,
      source_text: null,
      blob_ref,
      blob_bytes: byteLen,
    };
  }
  return {
    ...span,
    provenance,
    source_text: unitUtf8,
    blob_ref: null,
    blob_bytes: null,
  };
}

export function omittedBlobsFromExternalizedUnits(snapshot: WorkspaceSnapshot): OmittedBlob[] {
  const rows: OmittedBlob[] = [];
  for (const u of snapshot.units) {
    if (u.blob_ref != null && u.blob_bytes != null) {
      rows.push({ ref: u.blob_ref, bytes: u.blob_bytes, reason: "inline_threshold" });
    }
  }
  rows.sort((a, b) => (a.ref === b.ref ? a.bytes - b.bytes : a.ref.localeCompare(b.ref)));
  return rows;
}
