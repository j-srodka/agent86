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

export function resolveLogicalUnit(snapshot: WorkspaceSnapshot, logicalId: string): LogicalUnit | null {
  const canon = resolveCanonicalUnitId(snapshot, logicalId);
  if (!canon) {
    return null;
  }
  return snapshot.units.find((u) => u.id === canon) ?? null;
}
