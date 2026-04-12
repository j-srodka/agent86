import type { LogicalUnit, WorkspaceSnapshot } from "./types.js";

/**
 * Flatten `id_resolve` to the canonical unit id, or `null` if unknown / cycle.
 */
export function resolveCanonicalUnitId(snapshot: WorkspaceSnapshot, logicalId: string): string | null {
  let id = logicalId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(id)) {
      return null;
    }
    visited.add(id);
    const step = snapshot.id_resolve[id];
    if (step === undefined) {
      break;
    }
    if (step === id) {
      break;
    }
    id = step;
  }
  return snapshot.units.some((u) => u.id === id) ? id : null;
}

export type ResolveOpTargetResult =
  | { kind: "live"; unit: LogicalUnit; supersededFrom: string | null }
  | { kind: "ghost"; target_id: string; resolved_to: string }
  | { kind: "unknown"; target_id: string };

/**
 * Resolve an op `target_id` using the flattened snapshot `id_resolve` map (single hop).
 * Emits `id_superseded` when `supersededFrom` is non-null.
 */
export function resolveOpTarget(snapshot: WorkspaceSnapshot, target_id: string): ResolveOpTargetResult {
  const direct = snapshot.units.find((u) => u.id === target_id);
  if (direct) {
    return { kind: "live", unit: direct, supersededFrom: null };
  }
  const resolved = snapshot.id_resolve[target_id];
  if (resolved === undefined) {
    return { kind: "unknown", target_id };
  }
  const unit = snapshot.units.find((u) => u.id === resolved);
  if (unit) {
    return { kind: "live", unit, supersededFrom: target_id };
  }
  return { kind: "ghost", target_id, resolved_to: resolved };
}

export function resolveLogicalUnit(snapshot: WorkspaceSnapshot, logicalId: string): LogicalUnit | null {
  const r = resolveOpTarget(snapshot, logicalId);
  if (r.kind !== "live") {
    return null;
  }
  return r.unit;
}

/**
 * Apply one move edge to a flattened `id_resolve` map: all pointers to `old_id` become `new_id`,
 * and `old_id` maps to `new_id`.
 */
export function applyMoveIdResolveEdge(
  id_resolve: Record<string, string>,
  old_id: string,
  new_id: string,
): Record<string, string> {
  const out: Record<string, string> = { ...id_resolve };
  for (const k of Object.keys(out)) {
    if (out[k] === old_id) {
      out[k] = new_id;
    }
  }
  out[old_id] = new_id;
  return out;
}

/**
 * Merge supersession entries from a previous snapshot after re-materializing live units from disk.
 * Drops stale self-edges `k -> k` when `k` is not a live unit id.
 */
export function mergeIdResolveFromPrevious(
  liveUnits: LogicalUnit[],
  previousIdResolve: Record<string, string> | undefined,
): Record<string, string> {
  const live = new Set(liveUnits.map((u) => u.id));
  const out: Record<string, string> = {};
  for (const u of liveUnits) {
    out[u.id] = u.id;
  }
  if (!previousIdResolve) {
    return out;
  }
  for (const k of Object.keys(previousIdResolve).sort((a, b) => a.localeCompare(b))) {
    const v = previousIdResolve[k]!;
    if (live.has(k)) {
      continue;
    }
    if (v === k) {
      continue;
    }
    out[k] = v;
  }
  return out;
}
