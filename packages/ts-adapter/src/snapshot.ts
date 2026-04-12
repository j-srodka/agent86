import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { getBlobCachePath } from "./blobs.js";
import { GRAMMAR_DIGEST_V0 } from "./grammar_meta.js";
import { parseTypeScriptSource } from "./parser.js";
import { extractLogicalUnits } from "./units.js";
import type {
  AdapterFingerprint,
  ExtractedUnitSpan,
  LogicalUnit,
  OmittedBlob,
  SnapshotFile,
  WorkspaceSnapshot,
} from "./types.js";

/** Applying adapter identity for materialized snapshots; apply gate compares incoming snapshots to this. */
export const V0_ADAPTER_FINGERPRINT: AdapterFingerprint = {
  name: "ts-adapter",
  semver: "0.0.0",
  grammar_digest: GRAMMAR_DIGEST_V0,
  max_batch_ops: 50,
};

/** Normalize to LF before hashing and parsing (see `docs/impl/v0-decisions.md`). */
export function canonicalizeSourceForSnapshot(sourceUtf8: string): string {
  return sourceUtf8.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sha256HexOfString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function walkRepoFiles(
  absoluteDir: string,
  snapshotRoot: string,
  filePredicate: (relativePosix: string) => boolean,
  outRelativePosix: string[],
): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = join(absoluteDir, ent.name);
    const rel = toPosix(relative(snapshotRoot, abs));
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") {
        continue;
      }
      await walkRepoFiles(abs, snapshotRoot, filePredicate, outRelativePosix);
    } else if (ent.isFile() && filePredicate(rel)) {
      outRelativePosix.push(rel);
    }
  }
}

function isTsNotTsx(relPosix: string): boolean {
  return relPosix.endsWith(".ts") && !relPosix.endsWith(".tsx");
}

function isTsx(relPosix: string): boolean {
  return relPosix.endsWith(".tsx");
}

function computeSnapshotId(input: {
  grammar_digest: string;
  adapter: AdapterFingerprint;
  files: SnapshotFile[];
  units: LogicalUnit[];
  skipped_tsx_paths: string[];
}): string {
  const sortedFiles = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const sortedUnits = [...input.units].sort((a, b) => a.id.localeCompare(b.id));
  const skipped = [...input.skipped_tsx_paths].sort((a, b) => a.localeCompare(b));
  const payload = {
    grammar_digest: input.grammar_digest,
    adapter: {
      name: input.adapter.name,
      semver: input.adapter.semver,
      max_batch_ops: input.adapter.max_batch_ops,
    },
    files: sortedFiles,
    units: sortedUnits,
    skipped_tsx_paths: skipped,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/** §10 default inline cap (UTF-8 bytes per logical unit span). */
export const DEFAULT_INLINE_THRESHOLD_BYTES = 8192;

export interface MaterializeSnapshotOptions {
  /** Directory to snapshot (absolute or CWD-relative). */
  rootPath: string;
  /**
   * Externalize unit spans strictly larger than this (UTF-8 byte length). Raise to force inlining
   * for a single materialization (§10).
   */
  inline_threshold_bytes?: number;
}

/**
 * Recursively walk `*.ts` files (glob semantics: all nested dirs; skip `node_modules`;
 * skip `.tsx` by filename). Parse with the v0 TypeScript grammar, extract Tier I units.
 * `.tsx` paths are listed in `skipped_tsx_paths` only (see `docs/impl/v0-decisions.md`).
 */
export async function materializeSnapshot(options: MaterializeSnapshotOptions): Promise<WorkspaceSnapshot> {
  const snapshotRootResolved = resolve(options.rootPath);
  const inlineThreshold = options.inline_threshold_bytes ?? DEFAULT_INLINE_THRESHOLD_BYTES;
  const grammarDigest = GRAMMAR_DIGEST_V0;

  const tsRel: string[] = [];
  const tsxRel: string[] = [];
  await walkRepoFiles(snapshotRootResolved, snapshotRootResolved, isTsNotTsx, tsRel);
  await walkRepoFiles(snapshotRootResolved, snapshotRootResolved, isTsx, tsxRel);
  tsRel.sort((a, b) => a.localeCompare(b));
  tsxRel.sort((a, b) => a.localeCompare(b));

  const files: SnapshotFile[] = [];
  const units: LogicalUnit[] = [];

  for (const rel of tsRel) {
    const abs = join(snapshotRootResolved, ...rel.split("/"));
    const raw = await readFile(abs, "utf8");
    const canonical = canonicalizeSourceForSnapshot(raw);
    const fileSha = sha256HexOfString(canonical);
    files.push({
      path: rel,
      sha256: fileSha,
      byte_length: Buffer.byteLength(canonical, "utf8"),
    });
    const tree = parseTypeScriptSource(canonical);
    const spans = extractLogicalUnits(tree, {
      grammarDigest,
      snapshotRootResolved,
      filePathPosix: rel,
    });
    for (const span of spans) {
      const unitText = canonical.slice(span.start_byte, span.end_byte);
      units.push(await finalizeLogicalUnit(span, unitText, snapshotRootResolved, inlineThreshold));
    }
  }

  const id_resolve: Record<string, string> = {};
  for (const u of units) {
    id_resolve[u.id] = u.id;
  }

  const snapshot_id = computeSnapshotId({
    grammar_digest: grammarDigest,
    adapter: V0_ADAPTER_FINGERPRINT,
    files,
    units,
    skipped_tsx_paths: tsxRel,
  });

  return {
    snapshot_id,
    grammar_digest: grammarDigest,
    adapter: V0_ADAPTER_FINGERPRINT,
    files,
    units,
    id_resolve,
    skipped_tsx_paths: tsxRel,
  };
}

async function finalizeLogicalUnit(
  span: ExtractedUnitSpan,
  unitUtf8: string,
  snapshotRootResolved: string,
  inlineThresholdBytes: number,
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
      source_text: null,
      blob_ref,
      blob_bytes: byteLen,
    };
  }
  return {
    ...span,
    source_text: unitUtf8,
    blob_ref: null,
    blob_bytes: null,
  };
}

/** §10 read/apply reporting: one row per externalized unit (reason `inline_threshold`). */
export function omittedBlobsFromExternalizedUnits(snapshot: WorkspaceSnapshot): OmittedBlob[] {
  const rows: OmittedBlob[] = [];
  for (const u of snapshot.units) {
    if (u.blob_ref != null && u.blob_bytes != null) {
      rows.push({
        ref: u.blob_ref,
        bytes: u.blob_bytes,
        reason: "inline_threshold",
      });
    }
  }
  rows.sort((a, b) => (a.ref === b.ref ? a.bytes - b.bytes : a.ref.localeCompare(b.ref)));
  return rows;
}
