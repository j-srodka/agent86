import type { LogicalUnit, WorkspaceSnapshot } from "./types.js";

export type ResolveOpTargetResult =
  | { kind: "live"; unit: LogicalUnit; supersededFrom: string | null }
  | { kind: "ghost"; target_id: string; resolved_to: string }
  | { kind: "unknown"; target_id: string };

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
  if (r.kind !== "live") return null;
  return r.unit;
}

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
    if (live.has(k)) continue;
    if (v === k) continue;
    out[k] = v;
  }
  return out;
}
