import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchUnits as jsSearchUnits } from "@agent86/js-adapter";
import { searchUnits as pySearchUnits } from "@agent86/py-adapter";
import { resolve } from "node:path";
import { searchUnits as tsSearchUnits } from "ts-adapter";

import {
  buildJsApplySubset,
  buildPyApplySubset,
  buildTsApplySubset,
  materializeCombinedSnapshot,
  type CombinedWorkspaceSnapshot,
} from "../combined-snapshot.js";
import { jsonToolError, jsonToolSuccess, runToolHandler, zodToToolInputError } from "../errors.js";
import { searchUnitsInputSchema } from "../schemas.js";
import { readSnapshotCache } from "../snapshot-cache.js";

export interface SearchUnitsWireWarning {
  code: string;
  severity: "warning";
  message: string;
  evidence?: Record<string, unknown>;
}

export interface SearchUnitsWirePayload {
  unit_refs: Array<{
    id: string;
    file_path: string;
    kind: string;
    name?: string;
    enclosing_class?: string;
    imported_from?: string;
    tags?: string[];
  }>;
  capability_warnings?: SearchUnitsWireWarning[];
}

function mergeWarnings(
  a: SearchUnitsWireWarning[] | undefined,
  b: SearchUnitsWireWarning[] | undefined,
): SearchUnitsWireWarning[] | undefined {
  const out = [...(a ?? []), ...(b ?? [])];
  return out.length > 0 ? out : undefined;
}

export function registerTool(server: McpServer): void {
  server.registerTool(
    "search_units",
    {
      description:
        "Search logical units with AND-composed criteria (kind, optional name, enclosing_class, path_prefix, etc.). Returns UnitRef identifiers (not full LogicalUnit bodies). When snapshot_id is set, loads the cached combined snapshot from materialize_snapshot; otherwise materializes from disk. Pass root_path as the workspace directory; for enclosing_class on .ts methods, the server passes snapshot_root_path to the ts-adapter.",
      inputSchema: searchUnitsInputSchema,
    },
    async (raw: unknown) => {
      const parsed = searchUnitsInputSchema.safeParse(raw);
      if (!parsed.success) return zodToToolInputError(parsed.error);
      return runToolHandler(async () => {
        const resolvedRoot = resolve(parsed.data.root_path);
        let combined: CombinedWorkspaceSnapshot;
        if (parsed.data.snapshot_id !== undefined) {
          const cached = await readSnapshotCache(resolvedRoot, parsed.data.snapshot_id);
          if (!cached) {
            return jsonToolError({
              code: "lang.agent86.snapshot_cache_miss",
              message:
                `Snapshot ${parsed.data.snapshot_id} not found in cache at ` +
                `${resolvedRoot}/.agent86/snapshots/. Re-run materialize_snapshot ` +
                `to rebuild the cache, then retry search_units with the new snapshot_id.`,
            });
          }
          combined = cached;
        } else {
          combined = await materializeCombinedSnapshot({ rootPath: resolvedRoot });
        }

        const criteria = parsed.data.criteria;
        const tsSubset = buildTsApplySubset(combined);
        const pySubset = buildPyApplySubset(combined);
        const jsSubset = buildJsApplySubset(combined);

        const [tsR, pyR, jsR] = await Promise.all([
          tsSearchUnits(tsSubset, criteria, resolvedRoot),
          pySearchUnits(pySubset, criteria, resolvedRoot),
          jsSearchUnits(jsSubset, criteria, resolvedRoot),
        ]);

        const unit_refs = [...tsR.unit_refs, ...pyR.unit_refs, ...jsR.unit_refs];
        const capability_warnings = mergeWarnings(
          mergeWarnings(tsR.capability_warnings, pyR.capability_warnings),
          jsR.capability_warnings,
        );

        const payload: SearchUnitsWirePayload = {
          unit_refs,
          ...(capability_warnings !== undefined ? { capability_warnings } : {}),
        };
        return jsonToolSuccess(payload);
      });
    },
  );
}
