import type { AdapterFingerprint, ValidationReport, V0Op } from "ts-adapter";

import { buildSnapshotIdMismatchReport } from "./snapshot-coherence.js";
import type { Agent86Transport } from "./transport.js";

export interface RenameSymbolInput {
  target_id: string;
  new_name: string;
  cross_file?: boolean;
  /**
   * Snapshot id from which `target_id` was resolved (e.g. `UnitRef.snapshot_id`).
   * If **any** queued op sets this, **every** op must set it, all must match each other,
   * and `.apply({ snapshot_id })` must use the same id — otherwise the SDK returns
   * `lang.agent86.snapshot_id_mismatch` without calling MCP.
   */
  source_snapshot_id?: string;
}

export interface ReplaceUnitInput {
  target_id: string;
  /** Authoring-friendly alias; serialized as `new_text` on the wire. */
  new_body: string;
  /** @see RenameSymbolInput.source_snapshot_id */
  source_snapshot_id?: string;
}

export interface MoveUnitInput {
  target_id: string;
  destination_file: string;
  insert_after_id?: string;
  /** @see RenameSymbolInput.source_snapshot_id */
  source_snapshot_id?: string;
}

export interface ApplyBatchInput {
  snapshot_id: string;
  root_path: string;
  toolchain_fingerprint_at_apply?: AdapterFingerprint;
}

/**
 * Fluent batch builder for `apply_batch`. Ops are queued in call order; the MCP server still
 * enforces adapter semantics (including same-file ordering guidance).
 */
export class OpBatchBuilder {
  private readonly ops: V0Op[] = [];
  private readonly opSourceSnapshotIds: (string | undefined)[] = [];

  constructor(private readonly transport: Agent86Transport) {}

  renameSymbol(input: RenameSymbolInput): this {
    const op: V0Op = {
      op: "rename_symbol",
      target_id: input.target_id,
      new_name: input.new_name,
      ...(input.cross_file === undefined ? {} : { cross_file: input.cross_file }),
    };
    this.ops.push(op);
    this.opSourceSnapshotIds.push(input.source_snapshot_id);
    return this;
  }

  replaceUnit(input: ReplaceUnitInput): this {
    this.ops.push({
      op: "replace_unit",
      target_id: input.target_id,
      new_text: input.new_body,
    });
    this.opSourceSnapshotIds.push(input.source_snapshot_id);
    return this;
  }

  moveUnit(input: MoveUnitInput): this {
    this.ops.push({
      op: "move_unit",
      target_id: input.target_id,
      destination_file: input.destination_file,
      ...(input.insert_after_id === undefined ? {} : { insert_after_id: input.insert_after_id }),
    });
    this.opSourceSnapshotIds.push(input.source_snapshot_id);
    return this;
  }

  /** Snapshot of queued ops (defensive copies). */
  toOps(): V0Op[] {
    return this.ops.map((o) => ({ ...o }));
  }

  async apply(input: ApplyBatchInput): Promise<ValidationReport> {
    const coherence = checkSnapshotCoherence(input.snapshot_id, this.opSourceSnapshotIds);
    if (coherence !== null) {
      return coherence;
    }
    return this.transport.callTool<ValidationReport>("apply_batch", {
      root_path: input.root_path,
      snapshot_id: input.snapshot_id,
      ops: this.ops,
      ...(input.toolchain_fingerprint_at_apply === undefined
        ? {}
        : { toolchain_fingerprint_at_apply: input.toolchain_fingerprint_at_apply }),
    });
  }
}

function checkSnapshotCoherence(
  applySnapshotId: string,
  perOpSource: (string | undefined)[],
): ValidationReport | null {
  if (perOpSource.length === 0) {
    return null;
  }
  const defined = perOpSource.filter((x): x is string => x !== undefined);
  if (defined.length === 0) {
    return null;
  }
  if (defined.length !== perOpSource.length) {
    return buildSnapshotIdMismatchReport({
      apply_snapshot_id: applySnapshotId,
      builder_snapshot_ids: [...new Set(defined)],
      reason: "incomplete_source_snapshot_ids",
    });
  }
  const uniq = new Set(defined);
  if (uniq.size > 1) {
    return buildSnapshotIdMismatchReport({
      apply_snapshot_id: applySnapshotId,
      builder_snapshot_ids: [...uniq],
      reason: "builder_multi_snapshot",
    });
  }
  const only = [...uniq][0]!;
  if (only !== applySnapshotId) {
    return buildSnapshotIdMismatchReport({
      apply_snapshot_id: applySnapshotId,
      builder_snapshot_ids: [only],
      reason: "apply_mismatch",
    });
  }
  return null;
}

export function builder(transport: Agent86Transport): OpBatchBuilder {
  return new OpBatchBuilder(transport);
}
