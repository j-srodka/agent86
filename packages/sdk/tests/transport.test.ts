import { describe, expect, it } from "vitest";

import { Agent86TransportError, Agent86VersionSkewError } from "../src/transport.js";
import { search } from "../src/search.js";

describe("Agent86TransportError", () => {
  it("keeps reference equality on detail when the second arg is a raw RPC-shaped object", () => {
    const rpcError = { code: -32603, message: "Internal error" };
    const err = new Agent86TransportError("failed", rpcError);
    expect(err.detail).toBe(rpcError);
  });

  it("allows assigning code/rpcMessage after construction without losing detail", () => {
    const rpcError = { code: -32603, message: "Internal error" };
    const err = new Agent86TransportError("HTTP 500 calling search_units", rpcError);
    err.code = -32603;
    err.rpcMessage = "Internal error";
    expect(err.detail).toBe(rpcError);
    expect(err.code).toBe(-32603);
    expect(err.rpcMessage).toBe("Internal error");
  });
});

describe("search + Agent86TransportError skew (assigned fields)", () => {
  it("wraps when code -32601 is set after construction", async () => {
    const transport = {
      async callTool(): Promise<never> {
        const err = new Agent86TransportError("JSON-RPC error", {});
        err.code = -32601;
        throw err;
      },
    };

    await expect(search({ kind: "function" }, { transport, root_path: "/repo" })).rejects.toSatisfy(
      (e: unknown) => e instanceof Agent86VersionSkewError && e instanceof Error && e.cause instanceof Agent86TransportError,
    );
  });
});
