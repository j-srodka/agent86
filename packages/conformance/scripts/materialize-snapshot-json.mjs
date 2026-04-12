/**
 * Standalone entry for subprocess determinism checks (imports workspace `ts-adapter`).
 * Usage: node materialize-snapshot-json.mjs <absoluteRootPath>
 */
import { materializeSnapshot } from "ts-adapter";

const root = process.argv[2];
if (!root) {
  console.error("missing root path");
  process.exit(1);
}

const s = await materializeSnapshot({ rootPath: root });
const unitIds = s.units.map((u) => u.id).sort();
const idResolveKeys = Object.keys(s.id_resolve).sort();
console.log(
  JSON.stringify({
    snapshot_id: s.snapshot_id,
    unit_ids: unitIds,
    id_resolve: s.id_resolve,
    id_resolve_key_order: idResolveKeys,
  }),
);
