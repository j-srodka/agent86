import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { materializeSnapshot } from "./snapshot.js";
import { searchUnits } from "./search_units.js";

describe("searchUnits (ts-adapter)", () => {
  it("matches class_declaration for kind class + name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ts-search-class-"));
    try {
      await writeFile(
        join(dir, "box.ts"),
        ["export class Box {", "  constructor() {}", "}", ""].join("\n"),
        "utf8",
      );
      const snap = await materializeSnapshot({ rootPath: dir });
      const res = await searchUnits(snap, { kind: "class", name: "Box" }, dir);
      expect(res.unit_refs).toHaveLength(1);
      expect(res.unit_refs[0]!.kind).toBe("class");
      expect(res.unit_refs[0]!.name).toBe("Box");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
