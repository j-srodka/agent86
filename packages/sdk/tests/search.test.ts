import { describe, expect, it } from "vitest";

import { Agent86TransportError, Agent86VersionSkewError } from "../src/transport.js";
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

  it("throws Agent86VersionSkewError for list_units-shaped { units } without unit_refs", async () => {
    const transport = {
      async callTool<T>(): Promise<T> {
        return { units: [{ id: "x", file_path: "a.ts", kind: "function" }] } as T;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy(
      (e: unknown) => e instanceof Agent86VersionSkewError && /list_units-shaped/.test(String(e.message)),
    );
  });

  it("throws Agent86VersionSkewError when unit_refs key is missing", async () => {
    const transport = {
      async callTool<T>(): Promise<T> {
        return { capability_warnings: [] } as T;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy(
      (e: unknown) => e instanceof Agent86VersionSkewError && /missing unit_refs/.test(String(e.message)),
    );
  });

  it("wraps Agent86TransportError as Agent86VersionSkewError when rpcMessage is an exact-match skew phrase", async () => {
    const transport = {
      async callTool(): Promise<never> {
        const err = new Agent86TransportError("JSON-RPC error");
        err.rpcMessage = "Method not found";
        throw err;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy(
      (e: unknown) => e instanceof Agent86VersionSkewError && e instanceof Error && e.cause instanceof Agent86TransportError,
    );
  });

  it("does not wrap HTTP-style Agent86TransportError that names search_units in the message", async () => {
    const transport = {
      async callTool(): Promise<never> {
        const err = new Agent86TransportError("HTTP 500 calling search_units", "body");
        err.code = -32603;
        err.rpcMessage = "Internal error";
        throw err;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy((e: unknown) => {
      return e instanceof Agent86TransportError && !(e instanceof Agent86VersionSkewError);
    });
  });

  it("does not wrap HTTP-style Agent86TransportError without JSON-RPC code", async () => {
    const transport = {
      async callTool(): Promise<never> {
        throw new Agent86TransportError("HTTP 500 calling search_units");
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy((e: unknown) => {
      return e instanceof Agent86TransportError && !(e instanceof Agent86VersionSkewError);
    });
  });

  it("throws TypeError when response body is an empty array (not version-skew)", async () => {
    const transport = {
      async callTool<T>(): Promise<T> {
        return [] as T;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof TypeError &&
        /response is not an object/.test(String((e as Error).message)) &&
        !(e instanceof Agent86VersionSkewError)
      );
    });
  });

  it("throws TypeError when response body is a non-empty array (not version-skew)", async () => {
    const transport = {
      async callTool<T>(): Promise<T> {
        return [{ id: "x" }] as T;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy((e: unknown) => {
      return (
        e instanceof TypeError &&
        /response is not an object/.test(String((e as Error).message)) &&
        !(e instanceof Agent86VersionSkewError)
      );
    });
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
