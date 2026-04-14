import { writeFile } from "node:fs/promises";

import type { LogicalUnit, WorkspaceSnapshot } from "ts-adapter";

import type { PythonMaterializedSnapshot } from "./python-materialize.js";

/** Seeded PRNG (mulberry32) — deterministic for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], rand: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

export type TaskCategory = "replace_unit" | "rename_symbol";

export interface TaskDescriptor {
  task_id: string;
  repo: string;
  language: "typescript" | "python_stub" | "python";
  task_category: TaskCategory;
  target_unit_id: string;
  file_path: string;
  /** Present when task_category === rename_symbol */
  rename_to?: string;
  has_homonym: boolean;
}

const BENCHMARK_SEED = 42;

/** Tree-sitter snapshot: benchmark samples top-level functions (v0 units; class_declaration not emitted by adapter). */
function filterEligibleTsUnits(units: LogicalUnit[]): LogicalUnit[] {
  return units.filter((u) => u.kind === "function_declaration");
}

/** Heuristic: symbol appears inside a quoted segment or a line / block comment. */
export function homonymInStringsOrComments(source: string, symbol: string): boolean {
  if (!symbol.length) {
    return false;
  }
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const seg = end === -1 ? source.slice(i) : source.slice(i, end);
      if (seg.includes(symbol)) {
        return true;
      }
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        return source.slice(i).includes(symbol);
      }
      const seg = source.slice(i, end + 2);
      if (seg.includes(symbol)) {
        return true;
      }
      i = end + 2;
      continue;
    }
    if (c === "#") {
      const end = source.indexOf("\n", i);
      const seg = end === -1 ? source.slice(i) : source.slice(i, end);
      if (seg.includes(symbol)) {
        return true;
      }
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          break;
        }
        j++;
      }
      const seg = source.slice(i, j + 1);
      if (seg.includes(symbol)) {
        return true;
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        j++;
      }
      const seg = source.slice(i, j + 1);
      if (seg.includes(symbol)) {
        return true;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return false;
}

export function declaredNameFromTsUnit(unit: LogicalUnit, fileSource: string): string | null {
  const span = fileSource.slice(unit.start_byte, unit.end_byte);
  const m = span.match(/\bfunction\s+([A-Za-z_$][\w$]*)/);
  return m?.[1] ?? null;
}

function declaredNameFromPythonStub(span: string): string | null {
  const line = span.split("\n")[0] ?? "";
  const dm = line.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
  if (dm?.[1]) {
    return dm[1];
  }
  const cm = line.match(/^class\s+([A-Za-z_]\w*)\b/);
  return cm?.[1] ?? null;
}

function pickRenameUnitTs(
  pool: LogicalUnit[],
  fileSources: Map<string, string>,
  rand: () => number,
  avoidIds: Set<string>,
): { unit: LogicalUnit; has_homonym: boolean } {
  const available = pool.filter((u) => !avoidIds.has(u.id));
  for (let attempt = 0; attempt < 3; attempt++) {
    const copy = [...available];
    shuffleInPlace(copy, rand);
    for (const unit of copy) {
      const src = fileSources.get(unit.file_path);
      if (!src) {
        continue;
      }
      const name = declaredNameFromTsUnit(unit, src);
      if (!name) {
        continue;
      }
      if (homonymInStringsOrComments(src, name)) {
        return { unit, has_homonym: true };
      }
    }
  }
  const copy = [...available];
  shuffleInPlace(copy, rand);
  const unit = copy[0]!;
  const src = fileSources.get(unit.file_path)!;
  const name = declaredNameFromTsUnit(unit, src);
  return { unit, has_homonym: name ? homonymInStringsOrComments(src, name) : false };
}

type PyAdapterUnit = { id: string; file_path: string; kind: string; start_byte: number; end_byte: number };

function pickRenameUnitPy(
  pool: PyAdapterUnit[],
  fileSources: Map<string, string>,
  rand: () => number,
  avoidIds: Set<string>,
): { unit: PyAdapterUnit; has_homonym: boolean } {
  const available = pool.filter((u) => !avoidIds.has(u.id));
  for (let attempt = 0; attempt < 3; attempt++) {
    const copy = [...available];
    shuffleInPlace(copy, rand);
    for (const unit of copy) {
      const src = fileSources.get(unit.file_path);
      if (!src) {
        continue;
      }
      const span = src.slice(unit.start_byte, unit.end_byte);
      const name = declaredNameFromPythonStub(span);
      if (!name) {
        continue;
      }
      if (homonymInStringsOrComments(src, name)) {
        return { unit, has_homonym: true };
      }
    }
  }
  const copy = [...available];
  shuffleInPlace(copy, rand);
  const unit = copy[0]!;
  const src = fileSources.get(unit.file_path)!;
  const span = src.slice(unit.start_byte, unit.end_byte);
  const name = declaredNameFromPythonStub(span);
  return { unit, has_homonym: name ? homonymInStringsOrComments(src, name) : false };
}

export interface SampleTasksOptions {
  repo: string;
  language: "typescript" | "python_stub" | "python";
  taskCount?: number;
  seed?: number;
}

/**
 * Sample deterministic tasks from a TypeScript materialized snapshot (Tree-sitter units).
 */
export function sampleTasksFromTsSnapshot(
  snapshot: WorkspaceSnapshot,
  fileSources: Map<string, string>,
  options: SampleTasksOptions,
): TaskDescriptor[] {
  const seed = options.seed ?? BENCHMARK_SEED;
  const taskCount = options.taskCount ?? 20;
  const rand = mulberry32(seed);
  const eligible = filterEligibleTsUnits(snapshot.units);
  const shuffled = [...eligible];
  shuffleInPlace(shuffled, rand);
  const n = Math.min(taskCount, shuffled.length);
  const picked = shuffled.slice(0, n);
  const replaceN = Math.min(12, Math.ceil((n * 12) / 20));
  const tasks: TaskDescriptor[] = [];
  const usedRenameIds = new Set<string>();

  for (let idx = 0; idx < n; idx++) {
    const unit = picked[idx]!;
    const isReplace = idx < replaceN;
    const task_id = `${options.repo}_${isReplace ? "rep" : "ren"}_${String(idx).padStart(2, "0")}`;
    if (isReplace) {
      tasks.push({
        task_id,
        repo: options.repo,
        language: "typescript",
        task_category: "replace_unit",
        target_unit_id: unit.id,
        file_path: unit.file_path,
        has_homonym: false,
      });
    } else {
      const r = pickRenameUnitTs(eligible, fileSources, mulberry32(seed + idx * 0x9e3779b9 + 13), usedRenameIds);
      usedRenameIds.add(r.unit.id);
      const rename_to = `renamed_${task_id.replace(/[^a-z0-9]+/gi, "_")}`;
      tasks.push({
        task_id,
        repo: options.repo,
        language: "typescript",
        task_category: "rename_symbol",
        target_unit_id: r.unit.id,
        file_path: r.unit.file_path,
        rename_to,
        has_homonym: r.has_homonym,
      });
    }
  }
  return tasks;
}

/**
 * Sample tasks from a Python stub snapshot (regex units).
 */
export function sampleTasksFromPythonSnapshot(
  snap: PythonMaterializedSnapshot,
  options: SampleTasksOptions,
): TaskDescriptor[] {
  const seed = options.seed ?? BENCHMARK_SEED;
  const taskCount = options.taskCount ?? 20;
  const rand = mulberry32(seed ^ 0xdeadbeef);
  const eligible = snap.snapshot.units.filter(
    (u) => u.kind === "function_declaration" || u.kind === "class_declaration",
  );
  const shuffled = [...eligible];
  shuffleInPlace(shuffled, rand);
  const n = Math.min(taskCount, shuffled.length);
  const picked = shuffled.slice(0, n);
  const replaceN = Math.min(12, Math.ceil((n * 12) / 20));
  const tasks: TaskDescriptor[] = [];
  const usedRenameIds = new Set<string>();

  for (let idx = 0; idx < n; idx++) {
    const unit = picked[idx]!;
    const isReplace = idx < replaceN;
    const task_id = `${options.repo}_${isReplace ? "rep" : "ren"}_${String(idx).padStart(2, "0")}`;
    if (isReplace) {
      tasks.push({
        task_id,
        repo: options.repo,
        language: "python_stub",
        task_category: "replace_unit",
        target_unit_id: unit.id,
        file_path: unit.file_path,
        has_homonym: false,
      });
    } else {
      const r = pickRenameUnitPy(eligible, snap.fileSources, mulberry32(seed + idx * 0x85ebca6b + 7), usedRenameIds);
      usedRenameIds.add(r.unit.id);
      const rename_to = `renamed_${task_id.replace(/[^a-z0-9]+/gi, "_")}`;
      tasks.push({
        task_id,
        repo: options.repo,
        language: "python_stub",
        task_category: "rename_symbol",
        target_unit_id: r.unit.id,
        file_path: r.unit.file_path,
        rename_to,
        has_homonym: r.has_homonym,
      });
    }
  }
  return tasks;
}

interface PyAdapterSnapshot {
  units: Array<{ id: string; file_path: string; kind: string; start_byte: number; end_byte: number }>;
}

/**
 * Sample tasks from a py-adapter snapshot (real tree-sitter units).
 * Unit kinds: `function_definition`, `class_definition`.
 */
export function sampleTasksFromPyAdapterSnapshot(
  snapshot: PyAdapterSnapshot,
  fileSources: Map<string, string>,
  options: SampleTasksOptions,
): TaskDescriptor[] {
  const seed = options.seed ?? BENCHMARK_SEED;
  const taskCount = options.taskCount ?? 20;
  const rand = mulberry32(seed ^ 0xdeadbeef);
  const eligible = snapshot.units.filter(
    (u) => u.kind === "function_definition" || u.kind === "class_definition",
  );
  const shuffled = [...eligible];
  shuffleInPlace(shuffled, rand);
  const n = Math.min(taskCount, shuffled.length);
  const picked = shuffled.slice(0, n);
  const replaceN = Math.min(12, Math.ceil((n * 12) / 20));
  const tasks: TaskDescriptor[] = [];
  const usedRenameIds = new Set<string>();

  for (let idx = 0; idx < n; idx++) {
    const unit = picked[idx]!;
    const isReplace = idx < replaceN;
    const task_id = `${options.repo}_${isReplace ? "rep" : "ren"}_${String(idx).padStart(2, "0")}`;
    if (isReplace) {
      tasks.push({
        task_id,
        repo: options.repo,
        language: "python",
        task_category: "replace_unit",
        target_unit_id: unit.id,
        file_path: unit.file_path,
        has_homonym: false,
      });
    } else {
      const r = pickRenameUnitPy(
        eligible,
        fileSources,
        mulberry32(seed + idx * 0x85ebca6b + 7),
        usedRenameIds,
      );
      usedRenameIds.add(r.unit.id);
      const rename_to = `renamed_${task_id.replace(/[^a-z0-9]+/gi, "_")}`;
      tasks.push({
        task_id,
        repo: options.repo,
        language: "python",
        task_category: "rename_symbol",
        target_unit_id: r.unit.id,
        file_path: r.unit.file_path,
        rename_to,
        has_homonym: r.has_homonym,
      });
    }
  }
  return tasks;
}

export async function writeTaskListJson(outPath: string, tasks: TaskDescriptor[]): Promise<void> {
  await writeFile(outPath, JSON.stringify({ seed: BENCHMARK_SEED, tasks }, null, 2) + "\n", "utf8");
}

export { BENCHMARK_SEED };
