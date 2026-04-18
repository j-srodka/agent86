import type { AdapterFingerprint, ValidationReport, V0Op } from "ts-adapter";

import type { Agent86Transport } from "./transport.js";

export interface RenameSymbolInput {
  target_id: string;
  new_name: string;
  cross_file?: boolean;
}

export interface ReplaceUnitInput {
  target_id: string;
  /** Authoring-friendly alias; serialized as `new_text` on the wire. */
  new_body: string;
}

export interface MoveUnitInput {
  target_id: string;
  destination_file: string;
  insert_after_id?: string;
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

  constructor(private readonly transport: Agent86Transport) {}

  renameSymbol(input: RenameSymbolInput): this {
    const op: V0Op = {
      op: "rename_symbol",
      target_id: input.target_id,
      new_name: input.new_name,
      ...(input.cross_file === undefined ? {} : { cross_file: input.cross_file }),
    };
    this.ops.push(op);
    return this;
  }

  replaceUnit(input: ReplaceUnitInput): this {
    this.ops.push({
      op: "replace_unit",
      target_id: input.target_id,
      new_text: input.new_body,
    });
    return this;
  }

  moveUnit(input: MoveUnitInput): this {
    this.ops.push({
      op: "move_unit",
      target_id: input.target_id,
      destination_file: input.destination_file,
      ...(input.insert_after_id === undefined ? {} : { insert_after_id: input.insert_after_id }),
    });
    return this;
  }

  /** Snapshot of queued ops (defensive copies). */
  toOps(): V0Op[] {
    return this.ops.map((o) => ({ ...o }));
  }

  async apply(input: ApplyBatchInput): Promise<ValidationReport> {
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

export function builder(transport: Agent86Transport): OpBatchBuilder {
  return new OpBatchBuilder(transport);
}
