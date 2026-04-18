import { describe, expect, it } from "vitest";

import { mergeSearchCriteria, normalizeUnitRef, search } from "../src/search.js";

describe("search", () => {
  it("AND-composes criteria via mergeSearchCriteria before calling search_units", async () => {
    const calls: unknown[] = [];
    const transport = {
      async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ name, args });
        if (name !== "search_units") throw new Error("unexpected tool");
        return {
          unit_refs: [
            {
              id: "u1",
              file_path: "src/a.ts",
              snapshot_id: "snap-1",
              kind: "function",
              name: "foo",
            },
          ],
        } as T;
      },
    };

    const base = mergeSearchCriteria(
      { kind: "function" },
      { path_prefix: "src/", name: "foo" },
    );
    const units = await search(base, { transport, root_path: "/repo" });

    expect(calls).toEqual([
      {
        name: "search_units",
        args: {
          root_path: "/repo",
          criteria: { kind: "function", path_prefix: "src/", name: "foo" },
        },
      },
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]!.id).toBe("u1");
  });

  it("returns empty units with warning callback when unsupported filter warnings are present", async () => {
    const warnings: Array<{ code?: string; message: string }> = [];
    const transport = {
      async callTool<T>(): Promise<T> {
        return {
          unit_refs: [{ id: "ghost", file_path: "x.ts", snapshot_id: "snap-x", kind: "class", name: "C" }],
          capability_warnings: [
            { code: "lang.agent86.unsupported_search_filter", message: "unsupported filter: tags" },
          ],
        } as T;
      },
    };

    const seen: string[] = [];
    const units = await search(
      { kind: "class", tags: ["nope"] },
      {
        transport,
        root_path: "/repo",
        onWarning: (w) => {
          seen.push(w.message);
        },
      },
    );

    expect(units).toEqual([]);
    expect(seen.join("|")).toContain("unsupported");
  });
});

describe("normalizeUnitRef", () => {
  it("accepts normative kinds", () => {
    expect(
      normalizeUnitRef({
        id: "1",
        file_path: "f.ts",
        snapshot_id: "s",
        kind: "import",
        imported_from: "./x",
      }),
    ).toMatchObject({ kind: "import", imported_from: "./x" });
  });

  it("rejects unknown kinds", () => {
    expect(() =>
      normalizeUnitRef({
        id: "1",
        file_path: "f.ts",
        snapshot_id: "s",
        kind: "function_declaration",
      }),
    ).toThrow(/unsupported kind/);
  });
});
