import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  PYTHON_STUB_GRAMMAR_DIGEST,
  detectPythonUnits,
  defaultAuthoredProvenance,
  type PythonStubUnit,
} from "ts-adapter";
import type { AdapterFingerprint, LogicalUnit, SnapshotFile, WorkspaceSnapshot } from "ts-adapter";
import { canonicalizeSourceForSnapshot, sha256HexOfCanonicalSource } from "ts-adapter";

/** Snapshot built from regex Python units (stub) — same wire shape as `WorkspaceSnapshot`. */
export interface PythonMaterializedSnapshot {
  snapshot: WorkspaceSnapshot;
  /** Canonical LF sources for homonym checks and baseline. */
  fileSources: Map<string, string>;
  stubUnits: PythonStubUnit[];
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function walkPyFiles(absoluteDir: string, snapshotRoot: string, out: string[]): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const abs = join(absoluteDir, ent.name);
    const rel = toPosix(relative(snapshotRoot, abs));
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "__pycache__") {
        continue;
      }
      await walkPyFiles(abs, snapshotRoot, out);
    } else if (ent.isFile() && rel.endsWith(".py")) {
      out.push(rel);
    }
  }
}

export const PYTHON_STUB_ADAPTER_FINGERPRINT: AdapterFingerprint = {
  name: "python-stub",
  semver: "0.0.0",
  grammar_digest: PYTHON_STUB_GRAMMAR_DIGEST,
  max_batch_ops: 50,
};

function computeSnapshotId(input: {
  grammar_digest: string;
  adapter: AdapterFingerprint;
  files: SnapshotFile[];
  units: LogicalUnit[];
}): string {
  const sortedFiles = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const sortedUnits = [...input.units].sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    grammar_digest: input.grammar_digest,
    adapter: {
      name: input.adapter.name,
      semver: input.adapter.semver,
      max_batch_ops: input.adapter.max_batch_ops,
    },
    files: sortedFiles,
    units: sortedUnits,
    skipped_tsx_paths: [] as string[],
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/**
 * Materialize Python files under `rootPath` using regex stub units only.
 */
export async function materializePythonStubSnapshot(rootPath: string): Promise<PythonMaterializedSnapshot> {
  const snapshotRootResolved = resolve(rootPath);
  const rels: string[] = [];
  await walkPyFiles(snapshotRootResolved, snapshotRootResolved, rels);
  rels.sort((a, b) => a.localeCompare(b));

  const files: SnapshotFile[] = [];
  const units: LogicalUnit[] = [];
  const fileSources = new Map<string, string>();
  const stubUnits: PythonStubUnit[] = [];

  for (const rel of rels) {
    const abs = join(snapshotRootResolved, ...rel.split("/"));
    const raw = await readFile(abs, "utf8");
    const canonical = canonicalizeSourceForSnapshot(raw);
    fileSources.set(rel, canonical);
    const provenance = defaultAuthoredProvenance();
    files.push({
      path: rel,
      sha256: sha256HexOfCanonicalSource(canonical),
      byte_length: Buffer.byteLength(canonical, "utf8"),
      provenance,
    });
    const detected = detectPythonUnits(rel, canonical, {
      grammarDigest: PYTHON_STUB_GRAMMAR_DIGEST,
      snapshotRootResolved,
    });
    stubUnits.push(...detected);
    for (const d of detected) {
      const spanText = canonical.slice(d.start_byte, d.end_byte);
      const kind = d.kind === "class_declaration" ? "class_declaration" : "function_declaration";
      units.push({
        id: d.id,
        file_path: d.file_path,
        start_byte: d.start_byte,
        end_byte: d.end_byte,
        kind,
        provenance,
        source_text: spanText,
        blob_ref: null,
        blob_bytes: null,
      });
    }
  }

  const snapshot_id = computeSnapshotId({
    grammar_digest: PYTHON_STUB_GRAMMAR_DIGEST,
    adapter: PYTHON_STUB_ADAPTER_FINGERPRINT,
    files,
    units,
  });

  const snapshot: WorkspaceSnapshot = {
    snapshot_id,
    grammar_digest: PYTHON_STUB_GRAMMAR_DIGEST,
    adapter: PYTHON_STUB_ADAPTER_FINGERPRINT,
    files,
    units,
    id_resolve: Object.fromEntries(units.map((u) => [u.id, u.id])),
    skipped_tsx_paths: [],
  };

  return { snapshot, fileSources, stubUnits };
}
