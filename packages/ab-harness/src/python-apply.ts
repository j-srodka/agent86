import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LogicalUnit, WorkspaceSnapshot } from "ts-adapter";

import { materializePythonStubSnapshot, type PythonMaterializedSnapshot } from "./python-materialize.js";

/** Replace identifiers `oldName` with `newName` outside strings and comments (best-effort). */
export function pythonScopedRename(source: string, oldName: string, newName: string): string {
  if (!oldName.length || oldName === newName) {
    return source;
  }
  const n = source.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (c === "#") {
      const eol = source.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === q) {
          break;
        }
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const tail = source.slice(i);
    const word = new RegExp(`^\\b${escapeRe(oldName)}\\b`);
    const m = tail.match(word);
    if (m && m.index === 0) {
      out += newName;
      i += oldName.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function applyPythonReplaceUnit(input: {
  snapshotRootPath: string;
  snapshot: WorkspaceSnapshot;
  unit: LogicalUnit;
  newText: string;
}): Promise<{ ok: true; next: PythonMaterializedSnapshot } | { ok: false; message: string }> {
  try {
    const abs = join(input.snapshotRootPath, ...input.unit.file_path.split("/"));
    const raw = await readFile(abs, "utf8");
    const canonical = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const next =
      canonical.slice(0, input.unit.start_byte) + input.newText + canonical.slice(input.unit.end_byte);
    await writeFile(abs, next, "utf8");
    const nextSnap = await materializePythonStubSnapshot(input.snapshotRootPath);
    return { ok: true, next: nextSnap };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

export async function applyPythonRenameSymbol(input: {
  snapshotRootPath: string;
  snapshot: WorkspaceSnapshot;
  unit: LogicalUnit;
  newName: string;
  oldName: string;
}): Promise<{ ok: true; next: PythonMaterializedSnapshot } | { ok: false; message: string }> {
  try {
    const abs = join(input.snapshotRootPath, ...input.unit.file_path.split("/"));
    const raw = await readFile(abs, "utf8");
    const canonical = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const next = pythonScopedRename(canonical, input.oldName, input.newName);
    await writeFile(abs, next, "utf8");
    const nextSnap = await materializePythonStubSnapshot(input.snapshotRootPath);
    return { ok: true, next: nextSnap };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}
