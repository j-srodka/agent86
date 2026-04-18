export interface Agent86TransportOptions {
  /**
   * JSON-RPC HTTP endpoint for MCP tool calls.
   * When omitted, reads `process.env.AGENT86_MCP_ENDPOINT` (throws if still unset on first call).
   */
  endpoint?: string;
  /** Inject fetch (tests); defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface McpTextContentBlock {
  type: "text";
  text: string;
}

/** Minimal MCP `CallToolResult` shape returned over JSON-RPC. */
export interface CallToolResultWire {
  content: McpTextContentBlock[];
  isError?: boolean;
}

export class Agent86TransportError extends Error {
  override readonly name = "Agent86TransportError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export class Agent86ToolError extends Error {
  override readonly name = "Agent86ToolError";
  constructor(
    message: string,
    readonly payload: unknown,
  ) {
    super(message);
  }
}

/**
 * Host MCP server is too old or misconfigured: **`@agent86/sdk` v3 requires `search_units`**
 * and a normative **`{ unit_refs }`** payload (with **`snapshot_id`** on each ref). No silent
 * downgrade to **`list_units`** or legacy shapes.
 */
export class Agent86VersionSkewError extends Error {
  override readonly name = "Agent86VersionSkewError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

let rpcIdSeq = 1;

function resolveEndpoint(explicit?: string): string {
  const fromOpt = explicit?.trim();
  if (fromOpt) return fromOpt;
  const fromEnv = process.env.AGENT86_MCP_ENDPOINT?.trim();
  if (fromEnv) return fromEnv;
  throw new Agent86TransportError(
    "Agent86 MCP endpoint is not configured (pass `endpoint` or set AGENT86_MCP_ENDPOINT).",
  );
}

function parseToolPayload<T>(result: CallToolResultWire): T {
  if (result.isError) {
    const text = result.content[0]?.text ?? JSON.stringify(result);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // keep raw string
    }
    const message =
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : "MCP tool returned isError=true";
    throw new Agent86ToolError(message, parsed);
  }
  const text = result.content[0]?.text;
  if (text === undefined) {
    throw new Agent86TransportError("MCP tool result missing text content", result);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Agent86TransportError("MCP tool result text is not valid JSON", { text, err });
  }
}

/**
 * JSON-RPC 2.0 client for MCP-style `tools/call` over HTTP POST.
 *
 * **Wire contract:** `method: "tools/call"`, `params: { name, arguments }`, `result` is a
 * `CallToolResultWire` object. Non-2xx HTTP responses throw; JSON-RPC `error` objects throw;
 * tool-level failures (`isError`) throw {@link Agent86ToolError}.
 */
export class Agent86JsonRpcTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Agent86TransportOptions = {}) {
    this.endpoint = resolveEndpoint(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const body = {
      jsonrpc: "2.0" as const,
      id: rpcIdSeq++,
      method: "tools/call",
      params: { name, arguments: args },
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Agent86TransportError(`HTTP ${res.status} calling ${name}`, rawText);
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(rawText) as unknown;
    } catch (err) {
      throw new Agent86TransportError("JSON-RPC response is not valid JSON", { rawText, err });
    }
    if (!envelope || typeof envelope !== "object") {
      throw new Agent86TransportError("JSON-RPC response envelope malformed", envelope);
    }
    const e = envelope as Record<string, unknown>;
    if (e.error !== undefined) {
      throw new Agent86TransportError(
        typeof e.error === "object" &&
          e.error !== null &&
          "message" in e.error &&
          typeof (e.error as { message: unknown }).message === "string"
          ? String((e.error as { message: string }).message)
          : "JSON-RPC error",
        e.error,
      );
    }
    if (e.result === undefined) {
      throw new Agent86TransportError("JSON-RPC response missing result", envelope);
    }
    return parseToolPayload<T>(e.result as CallToolResultWire);
  }
}

export type Agent86Transport = Pick<Agent86JsonRpcTransport, "callTool">;
