import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { GRAMMAR_DIGEST_V0 } from "./grammar_meta.js";
import { parseTypeScriptSource } from "./parser.js";
import { extractLogicalUnits } from "./units.js";
import type { AdapterFingerprint, LogicalUnit, SnapshotFile, WorkspaceSnapshot } from "./types.js";

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

export interface MaterializeSnapshotOptions {
  /** Directory to snapshot (absolute or CWD-relative). */
  rootPath: string;
}

/**
 * Recursively walk `*.ts` files (glob semantics: all nested dirs; skip `node_modules`;
 * skip `.tsx` by filename). Parse with the v0 TypeScript grammar, extract Tier I units.
 * `.tsx` paths are listed in `skipped_tsx_paths` only (see `docs/impl/v0-decisions.md`).
 */
export async function materializeSnapshot(options: MaterializeSnapshotOptions): Promise<WorkspaceSnapshot> {
  const snapshotRootResolved = resolve(options.rootPath);
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
    const fileUnits = extractLogicalUnits(tree, {
      grammarDigest,
      snapshotRootResolved,
      filePathPosix: rel,
    });
    units.push(...fileUnits);
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
